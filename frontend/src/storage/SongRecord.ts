/**
 * The persisted form of an imported song.
 *
 * What is stored, and why exactly this much:
 *
 *   - the **chart** (notes + generator info + validation result) — this *is* the analysis output, so
 *     a stored song reopens with no re-analysis at all;
 *   - the **tempo and grid numbers** (bpm, beatMs, firstBeatMs, confidence) so the chart can be
 *     rebuilt and re-validated without the audio, and so the editor (phase 4) has the grid;
 *   - **analysis metadata** (version, timings, counts, warnings, tempo candidates) which is what the
 *     diagnostics panel shows for a stored song;
 *   - the **original audio bytes** (or an optional OGG transcode), in a separate object store, so
 *     listing the library does not read megabytes of audio.
 *
 * What is deliberately *not* stored is the full analysis: the per-frame loudness curve, the ~20 000
 * onset envelope samples per minute and the complete onset list. They are inputs to chart
 * generation, and regenerating them is exactly what the library is supposed to avoid. Keeping them
 * would multiply the database size for no user-visible benefit.
 *
 * Records are validated on the way out of the database (`decodeSongRecord` + `chartOf`, which runs
 * the real `ChartValidator`): IndexedDB contents are untrusted input like any other.
 */

import type { Beatmap, ChartGeneratorInfo, ChartNote, Difficulty } from '../chart/ChartTypes';
import { BEATMAP_SCHEMA_VERSION, isDifficulty } from '../chart/ChartTypes';
import { prepareBeatmap, validateBeatmap } from '../chart/ChartValidator';
import type { ChartStats } from '../chart/ChartGenerator';
import type { BarPhase, SectionConfidence, TempoCandidate, TimeRange } from '../analysis/types';
import type { AnalysisResult } from '../analysis/types';
import type { ValidationResult } from '../chart/ChartValidator';

/** Bumped when the record shape changes; a newer version is refused with a clear message. */
export const SONG_RECORD_VERSION = 1;

export type StoredAudioFormat = 'mp3' | 'ogg' | 'other';

export interface SongAudioDescriptor {
  /** Format of the bytes we hold, not of the file the user picked. */
  format: StoredAudioFormat;
  mimeType: string;
  bytes: number;
  /** False when only the metadata was kept (the user chose not to store the audio). */
  stored: boolean;
  /** True when the stored blob is an OGG export rather than the original upload. */
  transcoded: boolean;
}

export interface SongAnalysisInfo {
  version: string;
  analysisMs: number;
  framesAnalyzed: number;
  hopMs: number;
  onsetCount: number;
  beatCount: number;
  lowEnergySections: number;
  warnings: string[];
  tempoCandidates: TempoCandidate[];
  // --- phase 2.1 ---
  //
  // The grid's measured quality, stored so the diagnostics panel can be reopened for a saved song
  // without re-analysing (or even re-decoding) its audio. These are a handful of numbers plus at
  // most 64 section entries, so the reason the full onset list is *not* stored still stands.
  /** Share of onset strength inside a beat's tolerance window, and the chance baseline. */
  beatAlignRatio: number;
  beatAlignChance: number;
  /** Phase-2 metrics, kept for the side-by-side comparison in the panel. */
  gridCoverage: number;
  gridExcess: number;
  /** Which beat of the bar carries the accents. */
  barPhase: BarPhase;
  /** Per-section pulse quality (rebuilt as an empty list for records saved before phase 2.1). */
  sections: SectionConfidence[];
  /** Sections whose pulse is too weak to trust. */
  lowConfidenceRanges: TimeRange[];
}

export interface SongChartInfo {
  schemaVersion: number;
  difficulty: Difficulty;
  generator: ChartGeneratorInfo;
  noteCount: number;
  notes: ChartNote[];
  stats: ChartStats;
  validation: { ok: boolean; errors: string[]; warnings: string[] };
}

export interface SongRecord {
  recordVersion: number;
  id: string;
  title: string;
  artist?: string;
  fileName: string;
  fileSize: number;
  durationMs: number;
  sampleRate: number;
  channels: number;
  bpm: number;
  beatMs: number;
  firstBeatMs: number;
  beatConfidence: number;
  analysis: SongAnalysisInfo;
  chart: SongChartInfo;
  audio: SongAudioDescriptor;
  createdAt: string;
  updatedAt: string;
}

/** The list view: everything except the notes and the audio bytes. */
export interface SongSummary {
  id: string;
  title: string;
  artist?: string;
  durationMs: number;
  bpm: number;
  noteCount: number;
  difficulty: Difficulty;
  createdAt: string;
  updatedAt: string;
  audio: SongAudioDescriptor;
  validationOk: boolean;
  warnings: string[];
}

export interface BuildRecordInput {
  id: string;
  title: string;
  artist?: string;
  fileName: string;
  fileSize: number;
  audio: SongAudioDescriptor;
  analysis: AnalysisResult;
  chart: Beatmap;
  stats: ChartStats;
  validation: ValidationResult;
  now?: () => Date;
}

export function buildSongRecord(input: BuildRecordInput): SongRecord {
  const now = (input.now ?? (() => new Date()))().toISOString();
  return {
    recordVersion: SONG_RECORD_VERSION,
    id: input.id,
    title: input.title,
    ...(input.artist ? { artist: input.artist } : {}),
    fileName: input.fileName,
    fileSize: input.fileSize,
    durationMs: round(input.analysis.durationMs),
    sampleRate: input.analysis.sampleRate,
    channels: input.analysis.channels,
    bpm: input.analysis.bpm,
    beatMs: input.analysis.beatMs,
    firstBeatMs: input.analysis.firstBeatMs,
    beatConfidence: input.analysis.beatConfidence,
    analysis: {
      version: input.analysis.version,
      analysisMs: input.analysis.analysisMs,
      framesAnalyzed: input.analysis.framesAnalyzed,
      hopMs: input.analysis.hopMs,
      onsetCount: input.analysis.onsets.length,
      beatCount: input.analysis.beats.length,
      lowEnergySections: input.analysis.energy.lowEnergyRanges.length,
      warnings: [...input.analysis.warnings],
      tempoCandidates: [...input.analysis.tempoCandidates],
      beatAlignRatio: input.analysis.beatAlignRatio,
      beatAlignChance: input.analysis.beatAlignChance,
      gridCoverage: input.analysis.gridCoverage,
      gridExcess: input.analysis.gridExcess,
      barPhase: { ...input.analysis.barPhase, scores: [...input.analysis.barPhase.scores] },
      sections: input.analysis.sections.map((section) => ({ ...section })),
      lowConfidenceRanges: input.analysis.lowConfidenceRanges.map((range) => ({ ...range })),
    },
    chart: {
      schemaVersion: input.chart.schemaVersion,
      difficulty: input.chart.difficulty,
      generator: { ...input.chart.generator },
      noteCount: input.chart.notes.length,
      notes: input.chart.notes.map((note) => ({ ...note })),
      stats: { ...input.stats },
      validation: {
        ok: input.validation.ok,
        errors: input.validation.errors.map((issue) => `${issue.code}: ${issue.message}`),
        warnings: input.validation.warnings.map((issue) => `${issue.code}: ${issue.message}`),
      },
    },
    audio: { ...input.audio },
    createdAt: now,
    updatedAt: now,
  };
}

/** Rebuild a playable, validated `Beatmap` from a stored record. */
export function chartOf(record: SongRecord): Beatmap {
  const chart: Beatmap = {
    schemaVersion: record.chart.schemaVersion,
    songId: record.id,
    title: record.title,
    difficulty: record.chart.difficulty,
    bpm: record.bpm,
    offsetMs: 0,
    generator: { ...record.chart.generator },
    durationMs: record.durationMs,
    notes: record.chart.notes.map((note) => ({ ...note })),
  };
  if (record.artist) chart.artist = record.artist;
  // The validator is the authority, exactly as for a hand-authored or freshly generated chart.
  return prepareBeatmap(chart);
}

export function summarize(record: SongRecord): SongSummary {
  return {
    id: record.id,
    title: record.title,
    ...(record.artist ? { artist: record.artist } : {}),
    durationMs: record.durationMs,
    bpm: record.bpm,
    noteCount: record.chart.noteCount || record.chart.notes.length,
    difficulty: record.chart.difficulty,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    audio: { ...record.audio },
    validationOk: validateBeatmap(chartOfSafe(record)).ok,
    warnings: [...record.analysis.warnings],
  };
}

/** Validation without throwing, for list views and diagnostics. */
export function validateRecord(record: SongRecord): ValidationResult {
  try {
    return validateBeatmap(chartOf(record));
  } catch (error) {
    return {
      ok: false,
      errors: [{ severity: 'error', code: 'unreadable', message: error instanceof Error ? error.message : String(error) }],
      warnings: [],
    };
  }
}

function chartOfSafe(record: SongRecord): Beatmap {
  try {
    return chartOf(record);
  } catch {
    return {
      schemaVersion: BEATMAP_SCHEMA_VERSION,
      songId: record.id,
      title: record.title,
      difficulty: 'normal',
      bpm: record.bpm || 120,
      offsetMs: 0,
      generator: { name: 'unknown', version: '0', seed: 0 },
      notes: [],
    };
  }
}

/** JSON round-trip, used for export/import and covered by tests. */
export function encodeSongRecord(record: SongRecord): string {
  return JSON.stringify(record);
}

export class SongRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SongRecordError';
  }
}

/**
 * Parse and validate an untrusted record (from the database, a file, or another build).
 * Throws `SongRecordError` with a message that can be shown to the player.
 */
export function decodeSongRecord(value: unknown): SongRecord {
  const parsed = typeof value === 'string' ? safeParse(value) : value;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new SongRecordError('The stored song is not a JSON object.');
  }
  const record = parsed as Partial<SongRecord>;
  if (typeof record.recordVersion !== 'number') {
    throw new SongRecordError('The stored song has no record version.');
  }
  if (record.recordVersion > SONG_RECORD_VERSION) {
    throw new SongRecordError(
      `This song was saved by a newer version of Seven Keys (record v${record.recordVersion}, ` +
        `this build understands v${SONG_RECORD_VERSION}).`,
    );
  }
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new SongRecordError('The stored song has no id.');
  }
  if (typeof record.title !== 'string' || record.title.length === 0) {
    throw new SongRecordError('The stored song has no title.');
  }
  if (!Number.isFinite(record.bpm) || (record.bpm ?? 0) <= 0) {
    throw new SongRecordError('The stored song has no usable tempo.');
  }
  if (!Number.isFinite(record.beatMs) || (record.beatMs ?? 0) <= 0) {
    throw new SongRecordError('The stored song has no usable beat length.');
  }
  if (!record.chart || !Array.isArray(record.chart.notes) || record.chart.notes.length === 0) {
    throw new SongRecordError('The stored song has no chart notes.');
  }
  if (!isDifficulty(record.chart.difficulty)) {
    throw new SongRecordError(`The stored song has an unknown difficulty: ${String(record.chart.difficulty)}`);
  }
  if (typeof record.chart.schemaVersion !== 'number' || record.chart.schemaVersion < 1) {
    throw new SongRecordError('The stored chart has no schema version.');
  }
  if (record.chart.schemaVersion > BEATMAP_SCHEMA_VERSION) {
    throw new SongRecordError(
      `The stored chart uses schema v${record.chart.schemaVersion}; this build supports v${BEATMAP_SCHEMA_VERSION}.`,
    );
  }
  return {
    recordVersion: record.recordVersion,
    id: record.id,
    title: record.title,
    ...(record.artist ? { artist: record.artist } : {}),
    fileName: typeof record.fileName === 'string' ? record.fileName : 'unknown',
    fileSize: Number.isFinite(record.fileSize) ? (record.fileSize as number) : 0,
    durationMs: Number.isFinite(record.durationMs) ? (record.durationMs as number) : 0,
    sampleRate: Number.isFinite(record.sampleRate) ? (record.sampleRate as number) : 44100,
    channels: Number.isFinite(record.channels) ? (record.channels as number) : 2,
    bpm: record.bpm as number,
    beatMs: record.beatMs as number,
    firstBeatMs: Number.isFinite(record.firstBeatMs) ? (record.firstBeatMs as number) : 0,
    beatConfidence: Number.isFinite(record.beatConfidence) ? (record.beatConfidence as number) : 0,
    analysis: normalizeAnalysis(record.analysis),
    chart: {
      schemaVersion: record.chart.schemaVersion,
      difficulty: record.chart.difficulty,
      generator: normalizeGenerator(record.chart.generator),
      noteCount: record.chart.notes.length,
      notes: record.chart.notes,
      stats: record.chart.stats ?? EMPTY_STATS,
      validation: {
        ok: record.chart.validation?.ok ?? true,
        errors: record.chart.validation?.errors ?? [],
        warnings: record.chart.validation?.warnings ?? [],
      },
    },
    audio: {
      format: record.audio?.format ?? 'other',
      mimeType: record.audio?.mimeType ?? 'audio/mpeg',
      bytes: record.audio?.bytes ?? 0,
      stored: record.audio?.stored ?? false,
      transcoded: record.audio?.transcoded ?? false,
    },
    createdAt: record.createdAt ?? new Date().toISOString(),
    updatedAt: record.updatedAt ?? record.createdAt ?? new Date().toISOString(),
  };
}

function normalizeAnalysis(analysis: SongAnalysisInfo | undefined): SongAnalysisInfo {
  return {
    version: analysis?.version ?? 'unknown',
    analysisMs: analysis?.analysisMs ?? 0,
    framesAnalyzed: analysis?.framesAnalyzed ?? 0,
    hopMs: analysis?.hopMs ?? 0,
    onsetCount: analysis?.onsetCount ?? 0,
    beatCount: analysis?.beatCount ?? 0,
    lowEnergySections: analysis?.lowEnergySections ?? 0,
    warnings: analysis?.warnings ?? [],
    tempoCandidates: analysis?.tempoCandidates ?? [],
    // A record written before phase 2.1 has no alignment numbers; zeroing them (rather than
    // inventing a value) keeps the panel honest: "not recorded", not "measured as zero".
    beatAlignRatio: analysis?.beatAlignRatio ?? 0,
    beatAlignChance: analysis?.beatAlignChance ?? 0,
    gridCoverage: analysis?.gridCoverage ?? 0,
    gridExcess: analysis?.gridExcess ?? 0,
    barPhase: {
      phase: analysis?.barPhase?.phase ?? 0,
      scores: analysis?.barPhase?.scores ?? [],
      margin: analysis?.barPhase?.margin ?? 0,
      downbeatMs: analysis?.barPhase?.downbeatMs ?? 0,
    },
    sections: analysis?.sections ?? [],
    lowConfidenceRanges: analysis?.lowConfidenceRanges ?? [],
  };
}

function normalizeGenerator(generator: ChartGeneratorInfo | undefined): ChartGeneratorInfo {
  return {
    name: generator?.name ?? 'unknown',
    version: generator?.version ?? '0',
    seed: Number.isFinite(generator?.seed) ? (generator?.seed as number) : 0,
  };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new SongRecordError(`The stored song is not valid JSON: ${error instanceof Error ? error.message : ''}`);
  }
}

/** Stable id for a file: the same upload re-imported replaces its library entry. */
export function makeSongId(facts: { name: string; sizeBytes: number; lastModified: number }, durationMs: number): string {
  const source = `${facts.name}|${facts.sizeBytes}|${facts.lastModified}|${Math.round(durationMs)}`;
  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(index)) >>> 0;
  }
  return `song-${hash.toString(16).padStart(8, '0')}`;
}

/** Title from a file name: strip the extension, collapse separators. */
export function titleFromFileName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]+$/, '');
  const spaced = withoutExtension.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced.length > 0 ? spaced : 'Untitled';
}

const EMPTY_STATS: ChartStats = {
  noteCount: 0,
  tapCount: 0,
  holdCount: 0,
  chordCount: 0,
  holdRatio: 0,
  chordRatio: 0,
  notesPerSecond: 0,
  peakNotesPerSecond: 0,
  chartDurationMs: 0,
  firstNoteMs: 0,
  lastNoteEndMs: 0,
  laneUsage: [],
  lanesUsed: 0,
  onOnset: 0,
  onBeat: 0,
  onsetAlignRatio: 0,
  beatAlignRatio: 0,
  candidatesConsidered: 0,
  droppedByDensity: 0,
  droppedBySilence: 0,
  droppedBySpacing: 0,
  droppedByLaneGap: 0,
  droppedByLaneExhausted: 0,
  longGapCount: 0,
  maxGapMs: 0,
  meanGapMs: 0,
  sectionsSkipped: 0,
  spaceCount: 0,
  spaceRatio: 0,
  roleCounts: { downbeat: 0, kick: 0, low: 0, high: 0, supporting: 0, melodic: 0, syncopation: 0, beat: 0 },
  gridOnlyNotes: 0,
  lowConfidenceNotes: 0,
};

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
