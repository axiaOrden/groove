/**
 * Shared types for the Phase 2 analysis pipeline.
 *
 * Timestamp conventions (authoritative, and the reason they are written down):
 *
 *  - Every timestamp in an `AnalysisResult` is **milliseconds from the first audio sample**, the
 *    same convention as `ChartNote.timeMs` and `PlaybackTimeline`. A decoded `AudioBuffer` starts
 *    at sample 0 of the uploaded file, so no extra offset is needed to line analysis up with
 *    playback; `decodeAudioData` does not drop or prepend samples (an MP3's encoder delay is
 *    already handled by the decoder).
 *  - The **time of an onset is the start of its attack**, located to one fine envelope block
 *    (1.45 ms) inside the frame the flux peak points at; the reported value is that block's centre.
 *    Without that last step the frame grid alone would report the event up to `frameSize - hop`
 *    (~35 ms at 2048/512) early, and reporting the block's start would bias every onset ~0.7 ms
 *    early and pull the fitted beat grid off the start of the track. Residual uncertainty is about
 *    ±1 ms, far inside the PERFECT judgment window (±45 ms).
 *  - Nothing here depends on `requestAnimationFrame`, wall-clock time or the AudioContext: the
 *    analysis is a pure function of the sample array, so it is reproducible and testable.
 */

export const ANALYSIS_VERSION = '1.1.0';

export interface AnalysisOptions {
  /** STFT window size in samples (power of two). */
  frameSize: number;
  /** STFT hop in samples. Must divide the frame into an integer overlap. */
  hopSize: number;
  /** Lowest tempo considered, in BPM. */
  minBpm: number;
  /** Highest tempo considered, in BPM. */
  maxBpm: number;
  /**
   * Tempo octave preference. Detection is ambiguous by nature (a 128 BPM track is also 64 and
   * 256), so among the candidates whose comb scores are close, the one inside this range wins.
   */
  preferredBpm: readonly [number, number];
  /** Onset peak-picking: peak must exceed the local mean by this factor. */
  onsetDelta: number;
  /** Onset peak-picking: half-width of the adaptive threshold window, in frames. */
  onsetWindow: number;
  /** Two onsets closer than this collapse into one (the stronger one wins). */
  minInterOnsetMs: number;
  /**
   * An onset must be at least this strong (0..1 of the track's strong-onset level, the 95th
   * percentile) to be kept. The sliding analysis window produces tiny flux re-rises of about 1–3 %
   * after a loud attack; without this floor they would become extra notes. It is relative, so a
   * uniformly quiet track is not stripped of all its onsets.
   */
  minOnsetStrength: number;
  /** Low-energy detection: frames below (peak - this) dB are "quiet". */
  silenceDropDb: number;
}

export const DEFAULT_ANALYSIS_OPTIONS: AnalysisOptions = {
  frameSize: 2048,
  hopSize: 512,
  minBpm: 50,
  maxBpm: 220,
  preferredBpm: [70, 180],
  onsetDelta: 0.08,
  onsetWindow: 8,
  minInterOnsetMs: 60,
  minOnsetStrength: 0.08,
  silenceDropDb: 45,
};

export interface AnalysisInput {
  /** Decoded PCM, one Float32Array per channel. */
  channels: readonly Float32Array[];
  sampleRate: number;
  options?: Partial<AnalysisOptions>;
}

export type OnsetBand = 'low' | 'mid' | 'high' | 'broad';

export interface OnsetEvent {
  /** Milliseconds from the first sample (see the header). */
  timeMs: number;
  /** 0..1, normalised against the strongest onset in the track. */
  strength: number;
  /** Where the new energy appeared, used for lane assignment. */
  band: OnsetBand;
  /** Spectral centroid at the onset frame, in Hz (0 when unknown). */
  centroidHz: number;
  /** Raw spectral flux value before normalisation. */
  flux: number;
}

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export interface EnergyProfile {
  /** Smoothed frame loudness in dBFS (negative), one value per STFT frame. */
  frameDb: readonly number[];
  /** Frame period in ms, so `frameDb` can be indexed by time. */
  frameMs: number;
  peakDb: number;
  meanDb: number;
  /** Peak - silenceDropDb: below this the track counts as quiet. */
  floorDb: number;
  /** Loud sections, merged across short gaps. */
  activeRanges: readonly TimeRange[];
  /** Quiet/silent sections (between `activeRanges`), used to keep notes out of them. */
  lowEnergyRanges: readonly TimeRange[];
  /** Musical intensity per beat: 0..1 from loudness and onset density. */
  intensityByBeat: readonly number[];
  /** Onsets per second in one-second windows (diagnostics + density modulation). */
  onsetsPerSecond: readonly number[];
}

export interface TempoCandidate {
  bpm: number;
  /** Comb/autocorrelation score, 0..1 relative to the best candidate. */
  score: number;
  /** True when this candidate is the chosen BPM or its half/double. */
  octaveOf?: number;
  /** Onset alignment of this candidate's own best grid, when it was scored (0..1). */
  alignment?: number;
  /** How the candidate relates to the chosen tempo, for the diagnostics panel. */
  label?: string;
}

/**
 * Quality of a stretch of the beat grid, in bars (phase 2.1).
 *
 * A single confidence for a whole song hides the case that actually breaks charts: a grid that is
 * right for four minutes and wrong for the breakdown. `confidence` is `-1` when the section has too
 * few onsets to judge, which is *unknown*, not *bad*.
 */
export interface SectionConfidence {
  startMs: number;
  endMs: number;
  /** Strength-weighted onset alignment inside the section (0..1). */
  alignment: number;
  /** Alignment normalised against chance (0..1), or -1 when unknown. */
  confidence: number;
  onsetCount: number;
  beatCount: number;
}

/** Which beat of the bar carries the accents, and how clearly (phase 2.1). */
export interface BarPhase {
  /** 0..beatsPerBar-1, where 0 means the first detected beat is a downbeat. */
  phase: number;
  /** Per-position accent score, normalised so the winner is 1 (diagnostics only). */
  scores: number[];
  /** `(best - second) / best`: 0 means the bar has no audible metre. */
  margin: number;
  /** Time of the first downbeat, in milliseconds from the first sample. */
  downbeatMs: number;
}

export interface AnalysisResult {
  version: string;
  /** Wall-clock duration of the analysis itself, for the diagnostics panel. */
  analysisMs: number;
  sampleRate: number;
  channels: number;
  durationMs: number;
  frameSize: number;
  hopSize: number;
  hopMs: number;
  framesAnalyzed: number;
  bpm: number;
  beatMs: number;
  /** Time of the first detected beat. */
  firstBeatMs: number;
  /**
   * 0..1 confidence of the beat grid: how much of the onset strength lands on a beat, normalised
   * against the share a randomly phased grid would capture. See `analysis/BeatGrid.ts`.
   */
  beatConfidence: number;
  /** Strength-weighted share of onset strength inside a beat's tolerance window (0..1). */
  beatAlignRatio: number;
  /** The same measurement for a randomly phased grid: the null hypothesis (0..1). */
  beatAlignChance: number;
  /** Phase-2 metric, kept for comparison only: share of envelope energy the grid lands on. */
  gridCoverage: number;
  /** Phase-2 metric, kept for comparison only: `coverage / chance`, where 1 is no better than chance. */
  gridExcess: number;
  /** Which beat of the bar carries the accents, used for strong-beat lane mapping. */
  barPhase: BarPhase;
  /** Per-section grid quality, in bar-sized windows. */
  sections: readonly SectionConfidence[];
  /** Sections whose pulse is too weak to trust; the generator falls back to onsets there. */
  lowConfidenceRanges: readonly TimeRange[];
  /** Tempo candidates including the rejected half/double-time ones, for diagnostics. */
  tempoCandidates: readonly TempoCandidate[];
  beats: readonly number[];
  onsets: readonly OnsetEvent[];
  energy: EnergyProfile;
  /** Non-fatal problems worth surfacing to the player (e.g. "no clear pulse found"). */
  warnings: readonly string[];
}

/** The subset the chart generator needs; keeps generation testable without a full analysis. */
export interface AnalysisSummary {
  bpm: number;
  beatMs: number;
  firstBeatMs: number;
  beats: readonly number[];
  onsets: readonly OnsetEvent[];
  energy: EnergyProfile;
  durationMs: number;
  beatConfidence: number;
  /** Strength-weighted onset alignment (phase 2.1); drives the generator's trust in the grid. */
  beatAlignRatio?: number;
  /** Which beat of the bar carries the accents; drives the SPACE-lane mapping. */
  barPhase?: BarPhase;
  /** Per-section quality; sections marked low-confidence are charted from onsets only. */
  sections?: readonly SectionConfidence[];
  lowConfidenceRanges?: readonly TimeRange[];
}

export function isLowEnergy(range: TimeRange, energy: EnergyProfile): boolean {
  return energy.lowEnergyRanges.some((low) => range.startMs >= low.startMs - 1 && range.startMs < low.endMs);
}

/** Interpolate the intensity curve at a beat index (0..1). */
export function intensityAtBeat(energy: EnergyProfile, beatIndex: number): number {
  if (energy.intensityByBeat.length === 0) return 1;
  const index = Math.max(0, Math.min(energy.intensityByBeat.length - 1, beatIndex));
  return energy.intensityByBeat[index] ?? 1;
}
