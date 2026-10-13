/**
 * The import pipeline: file → decoded audio → analysis → chart → stored record.
 *
 * Kept free of DOM access so the whole workflow can be driven from a test (and so the UI is only
 * responsible for showing progress and errors). The stages report a single monotonic 0..1 ratio:
 *
 *   validate  0.00   file checks (instant, or a readable error)
 *   decode    0.02–0.30  Web Audio decode + channel copies
 *   analyse   0.30–0.86  the analysis worker (progress comes from the analysis itself)
 *   generate  0.86–0.94  chart generation + validation
 *   save      0.94–1.00  IndexedDB write (optional)
 *
 * The numbers are deliberately weighted by *how long each stage takes* on a real song (analysis
 * dominates), so the progress bar moves at a plausible rate instead of jumping.
 */

import type { AnalysisOptions, AnalysisResult } from '../analysis/types';
import type { AnalysisClient, AnalysisProgress } from '../analysis/AnalysisClient';
import { generateChart, type ChartStats } from '../chart/ChartGenerator';
import type { Beatmap } from '../chart/ChartTypes';
import type { ValidationResult } from '../chart/ChartValidator';
import { validateBeatmap } from '../chart/ChartValidator';
import { decodeAudioFile, describeFile, ImportError, type DecodedSong, type FileFacts } from './MusicImport';
import { exportOggVorbis, oggEncoderAvailable, type OggExportResult } from './OggExport';
import { buildSongRecord, makeSongId, titleFromFileName, type SongRecord } from '../storage/SongRecord';
import type { SongStore } from '../storage/SongLibrary';

export type ImportStage =
  | 'validating'
  | 'decoding'
  | 'analyzing'
  | 'generating'
  | 'transcoding'
  | 'saving'
  | 'done';

export interface ImportProgress {
  stage: ImportStage;
  ratio: number;
  detail: string;
}

export interface ImportOutcome {
  file: File;
  facts: FileFacts;
  buffer: AudioBuffer;
  record: SongRecord;
  chart: Beatmap;
  stats: ChartStats;
  validation: ValidationResult;
  analysis: AnalysisResult;
  ogg: OggExportResult | null;
  warnings: string[];
  /** True when the record was written to the library. */
  saved: boolean;
}

export interface ImportOptions {
  file: File;
  context: BaseAudioContext;
  client: AnalysisClient;
  /** Seed for chart generation. Same file + same seed ⇒ same chart. */
  seed?: number;
  title?: string;
  artist?: string;
  analysisOptions?: Partial<AnalysisOptions>;
  /** Persist to the library. `store` is required when this is true. */
  save?: boolean;
  store?: SongStore;
  /** Optional MP3 → OGG Vorbis transcode (off by default: lossy, and the original is kept). */
  transcodeToOgg?: boolean;
  oggQuality?: number;
  onProgress?: (progress: ImportProgress) => void;
  now?: () => Date;
}

/** Import a file end to end. Throws `ImportError` for anything the player should read. */
export async function importSongFile(options: ImportOptions): Promise<ImportOutcome> {
  // Progress is clamped to be monotonic. The stage boundaries are computed with floating point
  // (0.3 + 1 × 0.56 lands a hair below the next stage's 0.86), and a progress bar that flickers
  // backwards — even by 1e-16 — is a bug in the contract the UI relies on.
  let lastRatio = 0;
  const report = (stage: ImportStage, ratio: number, detail: string): void => {
    const next = Math.min(1, Math.max(lastRatio, Math.max(0, ratio)));
    lastRatio = next;
    options.onProgress?.({ stage, ratio: next, detail });
  };

  report('validating', 0, `checking ${options.file.name}`);
  const facts = describeFile(options.file);

  report('decoding', 0.02, 'decoding audio');
  const decoded = await decodeAudioFile(options.file, {
    context: options.context,
    onProgress: (ratio, detail) => report('decoding', 0.02 + ratio * 0.28, detail),
  });

  const analysis = await analyzeDecoded(decoded, options, (progress) => {
    report('analyzing', 0.3 + progress.ratio * 0.56, progress.detail ?? describeStage(progress.stage));
  });

  report('generating', 0.86, 'generating chart');
  const seed = options.seed ?? 1;
  const title = options.title ?? titleFromFileName(facts.name);
  const generated = generateChart(analysis, {
    seed,
    songId: makeSongId(facts, analysis.durationMs),
    title,
    ...(options.artist ? { artist: options.artist } : {}),
    charter: 'automatic analysis (phase 2)',
    durationMs: analysis.durationMs,
  });
  const validation = validateBeatmap(generated.chart);

  const warnings = [...analysis.warnings, ...generated.warnings];
  if (!validation.ok) {
    throw new ImportError(
      `The generated chart did not pass validation (${validation.errors.map((issue) => issue.code).join(', ')}). ` +
        'Try a longer or more rhythmic track.',
      'decode-failed',
    );
  }

  let ogg: OggExportResult | null = null;
  if (options.transcodeToOgg) {
    report('transcoding', 0.9, 'preparing OGG export');
    ogg = await transcode(decoded, options, (ratio) => report('transcoding', 0.9 + ratio * 0.05, 'encoding OGG Vorbis'));
  }

  const audioBlob = ogg ? ogg.blob : options.file;
  const record = buildSongRecord({
    id: generated.chart.songId,
    title,
    ...(options.artist ? { artist: options.artist } : {}),
    fileName: facts.name,
    fileSize: facts.sizeBytes,
    audio: {
      format: ogg ? 'ogg' : formatFromFacts(facts, options.file.type),
      mimeType: ogg ? ogg.blob.type : options.file.type || 'audio/mpeg',
      bytes: audioBlob.size,
      stored: options.save === true,
      transcoded: ogg !== null,
    },
    analysis,
    chart: generated.chart,
    stats: generated.stats,
    validation,
    ...(options.now ? { now: options.now } : {}),
  });

  let saved = false;
  if (options.save) {
    if (!options.store) throw new Error('save was requested without a song store');
    report('saving', 0.95, 'saving to the library');
    await options.store.save(record, {
      id: record.id,
      blob: audioBlob,
      mimeType: record.audio.mimeType,
    });
    saved = true;
  }

  report('done', 1, saved ? 'saved' : 'ready to play');
  return {
    file: options.file,
    facts,
    buffer: decoded.buffer,
    record,
    chart: generated.chart,
    stats: generated.stats,
    validation,
    analysis,
    ogg,
    warnings,
    saved,
  };
}

async function analyzeDecoded(
  decoded: DecodedSong,
  options: ImportOptions,
  onProgress: (progress: AnalysisProgress) => void,
): Promise<AnalysisResult> {
  // `analysisChannels` are copies (see MusicImport) — the worker transport detaches them, which is
  // exactly why they are copies and not views into the playback buffer.
  const { result } = await options.client.analyze({
    sampleRate: decoded.sampleRate,
    channels: decoded.analysisChannels,
    ...(options.analysisOptions ? { options: options.analysisOptions } : {}),
    onProgress,
  });
  return result;
}

async function transcode(
  decoded: DecodedSong,
  options: ImportOptions,
  onProgress: (ratio: number) => void,
): Promise<OggExportResult> {
  if (decoded.channelCount > 2) {
    // More than stereo is downmixed by the browser's decoder already in most cases; if not, the
    // encoder takes the first two channels (documented, not silent: the warning is returned).
    onProgress(0);
  }
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < Math.min(2, decoded.buffer.numberOfChannels); channel += 1) {
    channels.push(decoded.buffer.getChannelData(channel));
  }
  return exportOggVorbis({
    channels,
    sampleRate: decoded.sampleRate,
    ...(options.oggQuality !== undefined ? { vbrQuality: options.oggQuality } : {}),
    onProgress,
  });
}

export function formatFromFacts(facts: FileFacts, mimeType: string): 'mp3' | 'ogg' | 'other' {
  const lower = facts.name.toLowerCase();
  if (lower.endsWith('.mp3') || mimeType === 'audio/mpeg') return 'mp3';
  if (lower.endsWith('.ogg') || lower.endsWith('.oga') || lower.endsWith('.opus')) return 'ogg';
  return 'other';
}

export async function canTranscodeToOgg(): Promise<boolean> {
  return oggEncoderAvailable();
}

function describeStage(stage: AnalysisProgress['stage']): string {
  switch (stage) {
    case 'prepare':
      return 'preparing';
    case 'features':
      return 'spectral analysis';
    case 'onsets':
      return 'finding onsets';
    case 'tempo':
      return 'estimating tempo';
    case 'energy':
      return 'loudness profile';
    default:
      return 'analysing';
  }
}
