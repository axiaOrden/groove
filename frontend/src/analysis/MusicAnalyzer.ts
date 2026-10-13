/**
 * MusicAnalyzer — decoded PCM in, a complete `AnalysisResult` out.
 *
 * This is the seam the Web Worker wraps: the function is **synchronous and pure** apart from the
 * progress callback and the wall-clock measurement it reports, so it can be driven from a worker,
 * from the main thread as a fallback, or directly from a test with a synthetic signal.
 *
 * Stages and where the time goes (44.1 kHz, 3:35 song, 2048/512 window):
 *
 *     downmix            ~10 ms    (stereo → mono)
 *     frame features     ~1.5 s    (~18.5k frames: FFT 2048 + log flux + bands + centroid)
 *     onset detection    ~30 ms    (~18.5k frames of median-threshold peak picking)
 *     tempo + beat grid  ~50 ms    (autocorrelation + grid search over phases and octaves)
 *     energy profile     ~20 ms    (sections, per-beat intensity, onsets/s)
 *
 * Everything is expressed in milliseconds from the first sample (see types.ts for the timestamp
 * convention and the ±hop/2 uncertainty the frame grid implies).
 */

import { detectOnsets, downmix, computeFrameFeatures } from './OnsetDetector';
import { computeEnergyProfile } from './EnergyProfile';
import { estimateTempo } from './TempoEstimator';
import {
  ANALYSIS_VERSION,
  DEFAULT_ANALYSIS_OPTIONS,
  type AnalysisInput,
  type AnalysisOptions,
  type AnalysisResult,
} from './types';

export interface AnalysisProgress {
  stage: 'prepare' | 'features' | 'onsets' | 'tempo' | 'energy' | 'done';
  /** 0..1 overall. */
  ratio: number;
  detail?: string;
}

export interface AnalyzeHooks {
  onProgress?: (progress: AnalysisProgress) => void;
  /** Injected clock so `analysisMs` is reproducible-in-shape in tests. */
  now?: () => number;
}

/** Audio shorter than this cannot carry a playable chart. */
export const MIN_ANALYZABLE_MS = 1500;

export function resolveOptions(partial?: Partial<AnalysisOptions>): AnalysisOptions {
  const options = { ...DEFAULT_ANALYSIS_OPTIONS, ...partial };
  if (!Number.isInteger(options.frameSize) || options.frameSize < 64 || (options.frameSize & (options.frameSize - 1)) !== 0) {
    options.frameSize = DEFAULT_ANALYSIS_OPTIONS.frameSize;
  }
  if (!Number.isInteger(options.hopSize) || options.hopSize < 1 || options.hopSize > options.frameSize) {
    options.hopSize = DEFAULT_ANALYSIS_OPTIONS.hopSize;
  }
  if (!(options.minBpm > 0) || !(options.maxBpm > options.minBpm)) {
    options.minBpm = DEFAULT_ANALYSIS_OPTIONS.minBpm;
    options.maxBpm = DEFAULT_ANALYSIS_OPTIONS.maxBpm;
  }
  return options;
}

export function analyzeSong(input: AnalysisInput, hooks: AnalyzeHooks = {}): AnalysisResult {
  const now = hooks.now ?? (() => Date.now());
  const startedAt = now();
  const report = (stage: AnalysisProgress['stage'], ratio: number, detail?: string): void => {
    hooks.onProgress?.(detail === undefined ? { stage, ratio } : { stage, ratio, detail });
  };

  const options = resolveOptions(input.options);
  const warnings: string[] = [];
  report('prepare', 0.01);

  const sampleRate = input.sampleRate > 0 ? input.sampleRate : 44100;
  const channels = input.channels.filter((channel) => channel.length > 0);
  const mono = downmix(channels);
  const durationMs = (mono.length / sampleRate) * 1000;
  const hopMs = (options.hopSize / sampleRate) * 1000;

  if (mono.length === 0) {
    warnings.push('the decoded audio is empty');
  }
  if (durationMs > 0 && durationMs < MIN_ANALYZABLE_MS) {
    warnings.push(`audio is only ${Math.round(durationMs)} ms long; too short for a reliable analysis`);
  }
  if (durationMs > 0 && durationMs < (options.frameSize / sampleRate) * 1000 * 4) {
    warnings.push('audio is shorter than a few analysis windows; tempo detection will be unreliable');
  }

  report('features', 0.03);
  const features = computeFrameFeatures(mono, sampleRate, options, (ratio) =>
    report('features', 0.03 + ratio * 0.72, 'spectral flux'),
  );

  report('onsets', 0.78, 'peaks');
  const detection = detectOnsets(features, options, (ratio) => report('onsets', 0.78 + ratio * 0.04), sampleRate);
  if (detection.onsets.length === 0) {
    warnings.push('no onsets were detected; is this track rhythmic?');
  } else if (detection.onsets.length < 8) {
    warnings.push(`only ${detection.onsets.length} onsets detected; the chart will be very sparse`);
  }

  report('tempo', 0.84, 'autocorrelation');
  const tempo = estimateTempo(detection.envelope, hopMs, durationMs, options, detection.onsets);
  warnings.push(...tempo.warnings);
  // The grid is the spine of the chart, so its measured quality is reported in the numbers the
  // player can check (see BeatGrid.ts) rather than as a single opaque score.
  report(
    'tempo',
    0.9,
    `grid ${tempo.bpm.toFixed(1)} BPM · ${(tempo.alignment.ratio * 100).toFixed(0)}% of onset strength on a beat`,
  );

  report('energy', 0.95, 'loudness + sections');
  const energy = computeEnergyProfile({
    rmsDb: features.rmsDb,
    hopMs,
    durationMs,
    beats: tempo.beats,
    beatMs: tempo.beatMs,
    onsets: detection.onsets,
  });

  if (energy.activeRanges.length === 0 && durationMs > 0) {
    warnings.push('the whole track is silent or near-silent');
  }

  report('done', 1);
  return {
    version: ANALYSIS_VERSION,
    analysisMs: Math.max(0, Math.round(now() - startedAt)),
    sampleRate,
    channels: channels.length,
    durationMs: Math.round(durationMs * 1000) / 1000,
    frameSize: options.frameSize,
    hopSize: options.hopSize,
    hopMs: Math.round(hopMs * 1000) / 1000,
    framesAnalyzed: features.frameCount,
    bpm: tempo.bpm,
    beatMs: tempo.beatMs,
    firstBeatMs: tempo.firstBeatMs,
    beatConfidence: tempo.confidence,
    beatAlignRatio: tempo.alignment.ratio,
    beatAlignChance: tempo.alignment.chance,
    gridCoverage: tempo.coverage,
    gridExcess: tempo.excess,
    barPhase: tempo.barPhase,
    sections: tempo.sections,
    lowConfidenceRanges: tempo.lowConfidenceRanges,
    tempoCandidates: tempo.candidates,
    beats: tempo.beats,
    onsets: detection.onsets,
    energy,
    warnings,
  };
}

/** Convenience for tests and diagnostics: the analysis of a mono signal. */
export function analyzeMono(
  samples: Float32Array,
  sampleRate: number,
  options?: Partial<AnalysisOptions>,
): AnalysisResult {
  return analyzeSong({ channels: [samples], sampleRate, options });
}
