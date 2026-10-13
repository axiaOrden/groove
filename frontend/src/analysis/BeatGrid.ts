/**
 * Beat-grid quality: how well a grid lines up with the music, where the downbeats are, and which
 * parts of the track have no reliable pulse.
 *
 * ---------------------------------------------------------------------------- why this exists --
 *
 * Phase 2 reported `beatConfidence` as `(captured / chance - 1) / 4`, where `captured` was the share
 * of the onset-*envelope* energy a grid landed on and `chance` was the share of *frames* a grid of
 * that density covers. Those two quantities are not on the same scale — onset energy is concentrated
 * into short attacks, so a grid whose phase is audibly correct can still capture only a few percent
 * of the envelope — and on real music the ratio therefore saturates near 1 and the panel printed a
 * confidence of 0.16 for a chart whose notes clearly landed on the beat (measured on Kenshi Yonezu —
 * IRIS OUT during phase 2.1). A number that says "no better than chance" about a working grid is
 * worse than no number at all.
 *
 * The replacement measures the quantity the player actually perceives, and it measures it on the
 * **onsets** rather than on the frame envelope:
 *
 *     alignment = share of the track's onset strength that lands within a tolerance window of a beat
 *
 * That is bounded and directly readable ("74 % of onset strength is on a beat"), and it has an
 * honest null hypothesis: a grid with a random phase would swallow `2 · tolerance / beatMs` of the
 * strength, which is exactly what `chance` reports. `confidence` normalises the excess against that
 * null, so 0 means "indistinguishable from a random grid" and 1 means "every onset is on a beat".
 *
 * Everything else in phase 2.1 is derived from this one measurement: the tempo estimator's reported
 * confidence, the warnings, the half-beat "offbeat rescue", the bar phase (which lane SPACE should
 * get its accents from) and the per-section quality used by the chart generator to decide where it
 * may trust the grid.
 *
 * No clock, no randomness, no dependence on the frame grid: pure functions of the onset list.
 */

import type { BarPhase, OnsetEvent, SectionConfidence, TimeRange } from './types';
import { roundMs } from './OnsetDetector';

/** Beats per bar assumed for phrasing. Four is the overwhelmingly common case in this repertoire. */
export const BEATS_PER_BAR = 4;

/**
 * How far from a beat an onset may sit and still count as "on" it.
 *
 * An eighth of a beat is the natural scale (the PERFECT judgment window at 120 BPM is 45 ms, i.e.
 * 9 % of a beat), clamped so that very slow tracks do not accept onsets a whole sixteenth away and
 * very fast ones do not demand sub-frame precision.
 */
export function beatToleranceMs(beatMs: number): number {
  if (!(beatMs > 0)) return 60;
  return Math.max(15, Math.min(beatMs * 0.125, 75));
}

/** Signed distance from a grid position to the nearest grid line, in `(-periodMs/2, periodMs/2]`. */
export function signedOffsetMs(deltaMs: number, periodMs: number): number {
  if (!(periodMs > 0)) return 0;
  const wrapped = ((deltaMs % periodMs) + periodMs) % periodMs;
  return wrapped > periodMs / 2 ? wrapped - periodMs : wrapped;
}

export interface BeatAlignment {
  /** Strength-weighted share of onset strength within `toleranceMs` of a beat (0..1). */
  ratio: number;
  /** What the same measurement scores with a random grid phase (0..1). */
  chance: number;
  /** `(ratio - chance) / (1 - chance)`, clamped to 0..1: 0 = chance, 1 = perfect. */
  confidence: number;
  toleranceMs: number;
  matchedOnsets: number;
  totalOnsets: number;
  /** Same measurement taken half a beat away from the grid: high values mean the grid is on the offbeat. */
  offbeatRatio: number;
}

/**
 * Measure how well a grid explains the onset strength.
 *
 * `phaseOffsetMs` shifts the measured grid, which is how `offbeatRatio` is obtained: measuring the
 * grid half a beat away tells you how much of the music sits *between* the beats. A grid that
 * tracks the offbeat instead of the beat (loud hats on the eighths, a kick that plays the "and")
 * shows up as `offbeatRatio` clearly above `ratio` — see the rescue in the tempo estimator.
 */
export function measureBeatAlignment(
  onsets: readonly OnsetEvent[],
  beatMs: number,
  firstBeatMs: number,
  toleranceMs: number = beatToleranceMs(beatMs),
  phaseOffsetMs = 0,
): BeatAlignment {
  const empty: BeatAlignment = {
    ratio: 0,
    chance: 0,
    confidence: 0,
    toleranceMs,
    matchedOnsets: 0,
    totalOnsets: onsets.length,
    offbeatRatio: 0,
  };
  if (!(beatMs > 0) || onsets.length === 0) return empty;

  const total = measureGridCoverage(onsets, beatMs, firstBeatMs, toleranceMs, phaseOffsetMs);
  const offbeat = measureGridCoverage(onsets, beatMs, firstBeatMs, toleranceMs, phaseOffsetMs + beatMs / 2);
  const chance = Math.min(1, (2 * toleranceMs) / beatMs);
  const confidence = chance >= 1 ? 0 : clamp01((total.ratio - chance) / (1 - chance));
  return {
    ratio: total.ratio,
    chance,
    confidence,
    toleranceMs,
    matchedOnsets: total.matched,
    totalOnsets: onsets.length,
    offbeatRatio: offbeat.ratio,
  };
}

function measureGridCoverage(
  onsets: readonly OnsetEvent[],
  beatMs: number,
  firstBeatMs: number,
  toleranceMs: number,
  phaseOffsetMs: number,
): { ratio: number; matched: number } {
  let matchedStrength = 0;
  let totalStrength = 0;
  let matched = 0;
  for (const onset of onsets) {
    // Strength is 0..1 and already normalised against the track's own strong-onset level, so the
    // sum is a fair weighting across sections of different loudness.
    const weight = Math.max(onset.strength, 0.05);
    totalStrength += weight;
    const offset = signedOffsetMs(onset.timeMs - firstBeatMs - phaseOffsetMs, beatMs);
    if (Math.abs(offset) <= toleranceMs) {
      matchedStrength += weight;
      matched += 1;
    }
  }
  return { ratio: totalStrength > 0 ? matchedStrength / totalStrength : 0, matched };
}

/**
 * Where does the bar start?
 *
 * The bar phase is not detectable from periodicity (a 4/4 groove is periodic at the beat), so it is
 * estimated from **accents**: for each of the four beat positions, sum the onset strength that lands
 * on it, weighting low-frequency onsets (kicks, which overwhelmingly play the downbeat in this
 * repertoire) and adding a small bonus for metric plausibility. The winning position becomes the
 * downbeat, and the margin says how much to trust it.
 *
 * This is a heuristic, and its failure mode is documented rather than hidden: a track with a kick on
 * every beat, or with its accents on 2 and 4 (a snare backbeat reggae-style), will pick a phase that
 * is musically defensible but may be one beat off a written score. The chart generator only uses the
 * phase to decide *which* beats get the strongest accents, never to shift timing.
 */
export function estimateBarPhase(
  onsets: readonly OnsetEvent[],
  beatMs: number,
  firstBeatMs: number,
  beatsPerBar = BEATS_PER_BAR,
): BarPhase {
  const scores = new Array<number>(beatsPerBar).fill(0);
  const counts = new Array<number>(beatsPerBar).fill(0);
  if (!(beatMs > 0) || onsets.length === 0) {
    return { phase: 0, scores, margin: 0, downbeatMs: roundMs(normalize(firstBeatMs, beatMs)) };
  }
  const tolerance = beatToleranceMs(beatMs);
  for (const onset of onsets) {
    const beatIndex = Math.round((onset.timeMs - firstBeatMs) / beatMs);
    const offset = signedOffsetMs(onset.timeMs - firstBeatMs, beatMs);
    if (Math.abs(offset) > tolerance) continue;
    const position = ((beatIndex % beatsPerBar) + beatsPerBar) % beatsPerBar;
    const lowWeight = onset.band === 'low' ? 0.8 : onset.band === 'broad' ? 0.25 : 0;
    scores[position] = scores[position]! + onset.strength * (1 + lowWeight);
    counts[position] = counts[position]! + 1;
  }
  // Normalise per available beat so a track that simply has more beats at one position (it cannot,
  // in a 4/4 grid, but a partial first or last bar can) does not win by count.
  for (let position = 0; position < beatsPerBar; position += 1) {
    const count = Math.max(1, counts[position]!);
    scores[position] = scores[position]! / Math.sqrt(count);
  }
  let best = 0;
  for (let position = 1; position < beatsPerBar; position += 1) {
    if (scores[position]! > scores[best]!) best = position;
  }
  const sorted = [...scores].sort((a, b) => b - a);
  const top = sorted[0] ?? 0;
  const second = sorted[1] ?? 0;
  const margin = top > 0 ? (top - second) / top : 0;
  const normalized = top > 0 ? scores.map((value) => roundMs(value / top)) : scores;
  return {
    phase: best,
    scores: normalized,
    margin: roundMs(margin),
    downbeatMs: roundMs(normalize(firstBeatMs + best * beatMs, beatMs)),
  };
}

export interface SectionOptions {
  /** Section length in bars. Eight bars trades resolution for a usable number of onsets per window. */
  barsPerSection?: number;
  beatsPerBar?: number;
  /** Sections with fewer onsets than this are reported with `confidence: -1` (unknown). */
  minOnsets?: number;
}

/**
 * Per-section alignment.
 *
 * A single number for a whole song hides the case that actually breaks charts: a track whose grid is
 * right for four minutes and wrong for the breakdown (half-time feel, free-time piano, a tempo
 * change). Windows are aligned to bars so the boundary lands where the music changes phrase, and a
 * window with too few onsets reports `-1` rather than pretending to know.
 */
export function measureSections(
  onsets: readonly OnsetEvent[],
  beatMs: number,
  firstBeatMs: number,
  durationMs: number,
  options: SectionOptions = {},
): SectionConfidence[] {
  const barsPerSection = Math.max(1, options.barsPerSection ?? 8);
  const beatsPerBar = Math.max(1, options.beatsPerBar ?? BEATS_PER_BAR);
  const minOnsets = Math.max(2, options.minOnsets ?? 6);
  if (!(beatMs > 0) || !(durationMs > 0) || onsets.length === 0) return [];

  const windowMs = beatMs * beatsPerBar * barsPerSection;
  const tolerance = beatToleranceMs(beatMs);
  // A grid this dense explains everything by chance, so a per-section score would be meaningless.
  if (2 * tolerance >= beatMs) return [];
  const sections: SectionConfidence[] = [];
  let from = normalize(firstBeatMs, beatMs);
  // Long tracks get at most 64 sections: the panel and the generator only need coarse placement,
  // and a 10-minute song would otherwise produce a hundred near-identical rows.
  const maxSections = 64;
  if (durationMs / windowMs > maxSections) {
    from = 0;
  }
  const step = durationMs / windowMs > maxSections ? durationMs / maxSections : windowMs;

  for (let start = from; start < durationMs; start += step) {
    const end = Math.min(durationMs, start + step);
    const inside = onsets.filter((onset) => onset.timeMs >= start && onset.timeMs < end);
    const alignment = measureBeatAlignment(inside, beatMs, firstBeatMs, tolerance);
    const beats = Math.max(1, Math.round((end - start) / beatMs));
    sections.push({
      startMs: roundMs(start),
      endMs: roundMs(end),
      alignment: roundMs(alignment.ratio),
      confidence: inside.length >= minOnsets ? roundMs(alignment.confidence) : -1,
      onsetCount: inside.length,
      beatCount: beats,
    });
  }
  return sections;
}

/**
 * Merge the sections whose pulse is too weak to trust into ranges.
 *
 * `minConfidence` is the floor a section has to clear. Sections with unknown confidence (`-1`) are
 * treated as trustworthy: a genuinely sparse passage (a solo vocal line) has nothing to align with,
 * so "we cannot tell" must not be turned into "the grid is wrong here".
 */
export function lowConfidenceRanges(
  sections: readonly SectionConfidence[],
  minConfidence = 0.25,
): TimeRange[] {
  const ranges: TimeRange[] = [];
  for (const section of sections) {
    const weak = section.confidence >= 0 && section.confidence < minConfidence;
    const previous = ranges[ranges.length - 1];
    if (!weak) continue;
    if (previous && section.startMs - previous.endMs <= 1) previous.endMs = section.endMs;
    else ranges.push({ startMs: section.startMs, endMs: section.endMs });
  }
  return ranges;
}

/** Merge per-section confidences into one number for the whole track: the median, not the mean. */
export function medianSectionConfidence(sections: readonly SectionConfidence[]): number {
  const known = sections.map((section) => section.confidence).filter((value) => value >= 0);
  if (known.length === 0) return 0;
  known.sort((a, b) => a - b);
  const middle = known.length >> 1;
  return known.length % 2 === 1 ? known[middle]! : (known[middle - 1]! + known[middle]!) / 2;
}

function normalize(timeMs: number, beatMs: number): number {
  if (!(beatMs > 0)) return timeMs;
  return ((timeMs % beatMs) + beatMs) % beatMs;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
