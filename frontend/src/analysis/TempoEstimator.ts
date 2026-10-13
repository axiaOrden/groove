/**
 * Tempo and beat-grid estimation from the onset-strength envelope.
 *
 * Tempo detection is ambiguous by construction: a 128 BPM track is also a 64 BPM and a 256 BPM
 * track depending on which pulse you call the beat, and any method that just picks the strongest
 * periodicity will flip between them from song to song. This module therefore works in two steps.
 *
 * 1. **Candidates** from the autocorrelation of the onset envelope. Local maxima of the
 *    correlation give the periods that repeat.
 * 2. **Decision by explanatory power, not by peak height.** For a candidate period we search the
 *    phase that captures the most onset energy and then measure *excess* against the energy a grid
 *    with that many positions would capture by chance:
 *
 *        excess = captured / chance
 *
 *    Chance grows with the number of grid positions, so a double-time grid has to explain
 *    genuinely more music to win — that is what stops the "just pick the fastest periodicity"
 *    failure mode. Only when two octaves are within 10 % do we fall back to the preferred tempo
 *    range (`preferredBpm`), which is how half-time and double-time estimates are resolved; the
 *    rejected octaves are reported in `tempoCandidates` for the diagnostics panel.
 *
 * Timestamps stay in the analysis frame domain (frames × hopMs) and are converted once at the end,
 * so the beat grid cannot drift away from the onsets it was fitted to.
 *
 * Phase 2.1 changed three things here, all of them in response to a real song (Kenshi Yonezu — IRIS
 * OUT) where the estimated tempo was plausible but the notes did not land on the hits:
 *
 *  - `confidence` is now the **onset alignment** of the finished grid normalised against chance
 *    (`BeatGrid.ts`) instead of the envelope coverage ratio, which saturated on dense music and
 *    printed "no better than chance" for grids that were audibly correct. The old ratio is still
 *    reported as `excess`/`coverage` so the two can be compared side by side.
 *  - The grid gets an **offbeat rescue**: if the onsets align better half a beat later, the phase is
 *    shifted. A grid that locked onto the "and" of every beat has a perfect tempo and a
 *    half-beat-wrong phase, which is the single most damaging failure for a chart.
 *  - The result now carries the **bar phase** (which beat carries the accents, used to choose which
 *    beats deserve the SPACE lane) and **per-section confidence**, so a track whose grid is right
 *    for four minutes and wrong for the breakdown is reported honestly instead of averaged.
 */

import type { AnalysisOptions, BarPhase, OnsetEvent, SectionConfidence, TempoCandidate, TimeRange } from './types';
import { roundMs } from './OnsetDetector';
import {
  beatToleranceMs,
  estimateBarPhase,
  lowConfidenceRanges,
  measureBeatAlignment,
  measureSections,
  type BeatAlignment,
} from './BeatGrid';

export interface TempoEstimate {
  bpm: number;
  beatMs: number;
  firstBeatMs: number;
  /**
   * 0..1: how much better than chance the chosen grid explains the onsets, measured as the share of
   * onset strength inside a beat's tolerance window (phase 2.1; see `analysis/BeatGrid.ts`).
   */
  confidence: number;
  /** The phase-2 excess ratio (1 = no better than chance), kept for comparison in the panel. */
  excess: number;
  /** Envelope coverage of the chosen grid (phase-2 diagnostic), kept for comparison. */
  coverage: number;
  /** The measurement `confidence` is derived from, in full. */
  alignment: BeatAlignment;
  /** Which beat of the bar carries the accents. */
  barPhase: BarPhase;
  /** Per-section grid quality, in bar-sized windows. */
  sections: SectionConfidence[];
  /** Sections whose pulse is too weak to trust (the generator falls back to onsets there). */
  lowConfidenceRanges: TimeRange[];
  candidates: TempoCandidate[];
  beats: number[];
  warnings: string[];
}

/** Half-width of the tolerance window, in frames, used when scoring a beat grid. */
const TOLERANCE_FRAMES = 2;

/** Broad preference for musically common tempos; used only to break near-ties between octaves. */
function tempoPrior(bpm: number): number {
  const ratio = Math.log2(bpm / 120);
  return Math.exp(-0.5 * (ratio / 0.75) ** 2);
}

function correlationAt(envelope: Float32Array, lag: number): number {
  const n = envelope.length;
  if (lag <= 0 || lag >= n) return 0;
  let sum = 0;
  for (let t = 0; t + lag < n; t += 1) sum += envelope[t]! * envelope[t + lag]!;
  return sum / (n - lag);
}

export function estimateTempo(
  envelope: Float32Array,
  hopMs: number,
  durationMs: number,
  options: AnalysisOptions,
  onsets: readonly OnsetEvent[] = [],
): TempoEstimate {
  const frames = envelope.length;
  const warnings: string[] = [];
  let totalEnergy = 0;
  for (let i = 0; i < frames; i += 1) totalEnergy += envelope[i]!;

  const fallback: TempoEstimate = {
    bpm: 120,
    beatMs: 500,
    firstBeatMs: 0,
    confidence: 0,
    excess: 0,
    coverage: 0,
    alignment: measureBeatAlignment(onsets, 500, 0),
    barPhase: estimateBarPhase(onsets, 500, 0),
    sections: [],
    lowConfidenceRanges: [],
    candidates: [],
    beats: gridBeats(500, 0, durationMs),
    warnings,
  };

  if (frames < 8 || totalEnergy <= 0) {
    warnings.push('no onset energy to estimate a tempo from');
    return fallback;
  }

  const minLag = Math.max(2, Math.floor(60000 / (options.maxBpm * hopMs)));
  const maxLag = Math.min(Math.ceil(frames / 3), Math.ceil(60000 / (options.minBpm * hopMs)));
  if (maxLag <= minLag) {
    warnings.push('audio too short for tempo estimation');
    return fallback;
  }

  // ---------------------------------------------------------------- candidates ---
  const score = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const bpm = 60000 / (lag * hopMs);
    score[lag] = correlationAt(envelope, lag) * tempoPrior(bpm);
  }

  const candidates: Array<{ bpm: number; score: number; excess: number }> = [];
  for (let lag = minLag + 1; lag < maxLag; lag += 1) {
    const value = score[lag]!;
    if (value <= 0 || value < score[lag - 1]! || value < score[lag + 1]!) continue;
    const bpm = 60000 / (lag * hopMs);
    if (bpm < options.minBpm || bpm > options.maxBpm) continue;
    // Keep the grid candidate at least 3 % away from an already accepted one.
    if (candidates.some((entry) => Math.abs(entry.bpm - bpm) / entry.bpm < 0.03)) continue;
    const grid = scoreGrid(envelope, hopMs, bpm);
    candidates.push({ bpm, score: value, excess: grid.excess });
  }

  if (candidates.length === 0) {
    warnings.push('no repeating pulse found; falling back to 120 BPM');
    return { ...fallback, warnings, candidates: [] };
  }

  candidates.sort((a, b) => b.excess - a.excess || b.score - a.score);

  // -------------------------------------------------- octave (half/double) choice ---
  //
  // Every candidate and its octaves are scored on **two** axes, because one is not enough:
  //
  //   coverage  how much of the onset energy the grid actually lands on. A grid at 2.5× the beat
  //             (yes, that happens: see the fixture harness in tests/fixture-analysis.test.ts) can
  //             have a spectacular excess score simply because its chance coverage is tiny, while
  //             it misses most of the music. Coverage is what rules those out.
  //   score     excess × tempo prior, the standard "salience" ranking. Among grids that cover the
  //             music, the one that explains it best *and* sits in a musically plausible range wins.
  //
  // The coverage floor is relative (`best coverage × 0.75`, at least 0.25), so a track whose onsets
  // are all on eighth notes is still tracked, while a subharmonic that ignores half the beats is not.
  interface ShortlistEntry {
    bpm: number;
    excess: number;
    coverage: number;
    score: number;
  }
  const shortlist: ShortlistEntry[] = [];
  const seen = new Set<string>();
  const consider = (bpm: number): void => {
    if (!(bpm >= options.minBpm && bpm <= options.maxBpm)) return;
    const key = (Math.round(bpm * 100) / 100).toString();
    if (seen.has(key)) return;
    seen.add(key);
    const grid = scoreGrid(envelope, hopMs, bpm);
    shortlist.push({ bpm, excess: grid.excess, coverage: grid.coverage, score: grid.excess * tempoPrior(bpm) });
  };
  consider(candidates[0]!.bpm);
  for (const factor of [2, 0.5, 3, 1 / 3]) consider(candidates[0]!.bpm * factor);
  for (const candidate of candidates.slice(0, 8)) {
    consider(candidate.bpm);
    consider(candidate.bpm * 2);
    consider(candidate.bpm * 0.5);
  }

  // The floor is deliberately generous (half of the best coverage): coverage grows with grid density,
  // so a *tight* floor would systematically promote subdivision grids — 192 BPM over 96 on the
  // fixture, because the eighth-note grid lands on every onset and the beat grid only on the
  // beats. Half of the best is enough to remove a grid that misses most of the music (a 2.5×
  // subharmonic that only coincides with a beat every fifth position) without arguing about density.
  const bestCoverage = Math.max(...shortlist.map((entry) => entry.coverage));
  const coverageFloor = Math.max(0.12, bestCoverage * 0.5);
  const viable = shortlist.filter((entry) => entry.coverage >= coverageFloor);
  const ranked = viable.length > 0 ? viable : shortlist;
  let chosen = ranked.reduce((best, entry) => (entry.score > best.score ? entry : best), ranked[0]!);

  const [preferredLow, preferredHigh] = options.preferredBpm;
  if (chosen.bpm < preferredLow || chosen.bpm > preferredHigh) {
    const alternative = ranked
      .filter((entry) => entry.bpm >= preferredLow && entry.bpm <= preferredHigh && entry.score >= chosen.score * 0.9)
      .sort((a, b) => b.score - a.score)[0];
    if (alternative) {
      warnings.push(
        `tempo ${chosen.bpm.toFixed(1)} BPM is outside the preferred range; using its octave ` +
          `${alternative.bpm.toFixed(1)} BPM (score ${alternative.score.toFixed(2)} vs ${chosen.score.toFixed(2)})`,
      );
      chosen = alternative;
    }
  }

  // ----------------------------------------------------------------- half-time rescue ---
  //
  // Energy-per-position cannot tell a beat from its subdivisions when the subdivisions are as
  // loud as the beats — a track with hats on every eighth scores identically at 96 and 192 BPM
  // (measured on the 96 BPM fixture, which came out at 192). What *does* distinguish them is the
  // **pattern**: on a subdivision grid the captured energy alternates strong/weak. So a fast grid
  // whose odd positions carry clearly less energy than its even ones is halved — and only then.
  const alternating = alternationRatio(envelope, hopMs, chosen.bpm);
  if (chosen.bpm > 150 && alternating < 0.75 && chosen.bpm / 2 >= options.minBpm) {
    const halved = scoreGrid(envelope, hopMs, chosen.bpm / 2);
    const halvedScore = halved.excess * tempoPrior(chosen.bpm / 2);
    if (halvedScore >= chosen.score * 0.75 && halved.coverage >= coverageFloor * 0.75) {
      warnings.push(
        `tempo ${chosen.bpm.toFixed(1)} BPM positions alternate (weak/strong ratio ${alternating.toFixed(2)}); ` +
          `using the half-time beat ${(chosen.bpm / 2).toFixed(1)} BPM`,
      );
      chosen = {
        bpm: chosen.bpm / 2,
        excess: halved.excess,
        coverage: halved.coverage,
        score: halvedScore,
      };
    }
  }

  // ----------------------------------------------------------- refine the period ---
  const coarse = chosen.bpm;
  let best = scoreGrid(envelope, hopMs, coarse);
  let bestBpm = coarse;
  const step = coarse * 0.0005;
  for (let offset = -30; offset <= 30; offset += 1) {
    if (offset === 0) continue;
    const bpm = coarse + offset * step;
    if (bpm < options.minBpm || bpm > options.maxBpm) continue;
    const grid = scoreGrid(envelope, hopMs, bpm);
    if (grid.excess > best.excess) {
      best = grid;
      bestBpm = bpm;
    }
  }

  // The grid was fitted in the frame domain, so its phase carries the frame convention; snapping
  // it onto the *refined* onset times removes the remaining systematic lead of the flux domain.
  let beatMs = roundMs(60000 / bestBpm);
  let firstBeatMs = snapPhase(best.phaseFrames * hopMs + hopMs / 2, beatMs, onsets);

  // Finally, fit the grid to the onsets by weighted least squares. The frame grid can only resolve
  // a period to about half a hop (~1 % of a beat), because excess is piecewise constant in BPM;
  // a regression over hundreds of onset times resolves it to a fraction of a millisecond. The fit
  // is only adopted when it stays close to the tested BPM and still explains the music, so a
  // pathological assignment (every onset on one beat) cannot hijack the tempo.
  // Two passes of iteratively re-weighted fitting: the first pass downsamples onsets that look
  // off-grid against the *snapped* phase (which may be a few milliseconds off), and the second
  // re-classifies them against the corrected grid.
  const firstPass = fitGridToOnsets(firstBeatMs, beatMs, onsets);
  const fitted = firstPass ? (fitGridToOnsets(firstPass.firstBeatMs, firstPass.beatMs, onsets) ?? firstPass) : null;
  if (fitted) {
    const drift = Math.abs(fitted.beatMs - beatMs) / beatMs;
    if (drift <= 0.03 && scoreGrid(envelope, hopMs, 60000 / fitted.beatMs).excess >= best.excess * 0.95) {
      beatMs = roundMs(fitted.beatMs);
      firstBeatMs = roundMs(fitted.firstBeatMs);
      best = scoreGrid(envelope, hopMs, 60000 / beatMs);
    }
  }

  // -------------------------------------------------- alignment, phase and sections ---
  //
  // From here on the grid is fixed and the question changes from "which tempo" to "how good is
  // it, and is it on the beat or on the offbeat". Everything below is measured on the *onsets*
  // rather than on the frame envelope (see BeatGrid.ts for why that replaced the coverage ratio).
  const toleranceMs = beatToleranceMs(beatMs);
  let alignment = measureBeatAlignment(onsets, beatMs, firstBeatMs, toleranceMs);

  // Offbeat rescue. Peak picking does not care whether it is looking at a kick or at a loud
  // off-beat hat or snare, and on percussion-heavy music the strongest consistent pulse is quite
  // often the offbeat. If the music aligns measurably better half a beat later, the grid is wrong
  // by half a beat and no amount of period refinement will fix it.
  if (
    onsets.length >= 8 &&
    alignment.offbeatRatio - alignment.chance > 0.15 &&
    alignment.offbeatRatio > alignment.ratio * 1.2
  ) {
    const shifted = normalizePhase(firstBeatMs + beatMs / 2, beatMs);
    const flipped = measureBeatAlignment(onsets, beatMs, shifted, toleranceMs);
    if (flipped.ratio > alignment.ratio) {
      warnings.push(
        `onsets align better half a beat later (${(flipped.ratio * 100).toFixed(0)}% vs ` +
          `${(alignment.ratio * 100).toFixed(0)}% of onset strength); shifted the grid onto the offbeat`,
      );
      firstBeatMs = shifted;
      alignment = flipped;
    }
  }

  const barPhase = estimateBarPhase(onsets, beatMs, firstBeatMs);
  const sections = measureSections(onsets, beatMs, firstBeatMs, durationMs);
  const confidence = alignment.confidence;
  // A section counts as weak *relative to the rest of this track*, not against a fixed bar.
  // Measured on a real song (real-nightlife.mp3, phase 2.1): the whole track scores 0.24, so a fixed
  // 0.25 threshold flagged every section and the grid was discarded everywhere — technically safe,
  // but it threw away a grid that was right for most of the song. A relative floor finds the parts
  // that are genuinely worse than the rest, which is the actionable signal.
  const sectionFloor = Math.max(0.1, Math.min(0.45, confidence * 0.6));
  const weakSections = lowConfidenceRanges(sections, sectionFloor);
  const beats = gridBeats(beatMs, firstBeatMs, durationMs);
  const roundedBpm = roundMs(Math.round((60000 / beatMs) * 100) / 100);

  if (confidence < 0.2) {
    warnings.push(
      `the beat grid holds only ${(alignment.ratio * 100).toFixed(0)}% of the onset strength ` +
        `(a randomly phased grid would hold ${(alignment.chance * 100).toFixed(0)}%); ` +
        'the chart follows detected onsets and only uses the grid where the music is sparse',
    );
  }
  if (weakSections.length > 0) {
    const totalMs = weakSections.reduce((sum, range) => sum + (range.endMs - range.startMs), 0);
    warnings.push(
      `${weakSections.length} section(s) (${Math.round(totalMs / 1000)} s) have a weaker pulse than ` +
        `the rest of the track (below ${(sectionFloor * 100).toFixed(0)}% confidence); ` +
        'those parts are charted from detected onsets only instead of the beat grid',
    );
  }

  // Rejected octaves keep their own measured alignment, so the panel can show *why* the chosen
  // tempo won instead of asserting it: a half-time candidate that aligns as well as the winner is
  // exactly the case a player should be told about.
  const reported: TempoCandidate[] = [
    {
      bpm: roundedBpm,
      score: roundMs(clamp01(best.excess / 6)),
      alignment: roundMs(alignment.ratio),
      label: 'chosen',
    },
    ...candidates
      .filter((entry) => Math.abs(entry.bpm - roundedBpm) > 1)
      .slice(0, 5)
      .map((entry) => {
        const grid = scoreGrid(envelope, hopMs, entry.bpm);
        const phase = snapPhase(grid.phaseFrames * hopMs + hopMs / 2, 60000 / entry.bpm, onsets);
        const candidateAlignment = measureBeatAlignment(onsets, 60000 / entry.bpm, phase);
        const ratio = entry.bpm / roundedBpm;
        const label =
          Math.abs(ratio - 2) < 0.06
            ? 'double-time'
            : Math.abs(ratio - 0.5) < 0.03
              ? 'half-time'
              : 'rejected';
        const candidate: TempoCandidate = {
          bpm: roundMs(Math.round(entry.bpm * 100) / 100),
          score: roundMs(clamp01(entry.excess / 6)),
          octaveOf: roundMs(Math.round(roundedBpm * 100) / 100),
          alignment: roundMs(candidateAlignment.ratio),
          label,
        };
        return candidate;
      }),
  ];

  return {
    bpm: roundedBpm,
    beatMs,
    firstBeatMs,
    confidence: roundMs(confidence),
    excess: roundMs(best.excess),
    coverage: roundMs(best.coverage),
    alignment,
    barPhase,
    sections,
    lowConfidenceRanges: weakSections,
    candidates: reported,
    beats,
    warnings,
  };
}

interface GridScore {
  excess: number;
  phaseFrames: number;
  captured: number;
  chance: number;
  /** How much of the envelope's total energy the grid lands on (0..1). */
  coverage: number;
}

/**
 * Score a beat grid: pick the phase that captures the most envelope energy, then compare that
 * against the energy a grid of the same density would capture by chance.
 */
export function scoreGrid(envelope: Float32Array, hopMs: number, bpm: number): GridScore {
  const frames = envelope.length;
  const periodFrames = 60000 / bpm / hopMs;
  if (!Number.isFinite(periodFrames) || periodFrames <= 0) {
    return { excess: 0, phaseFrames: 0, captured: 0, chance: 1, coverage: 0 };
  }

  let totalEnergy = 0;
  for (let i = 0; i < frames; i += 1) totalEnergy += envelope[i]!;
  if (totalEnergy <= 0) return { excess: 0, phaseFrames: 0, captured: 0, chance: 1, coverage: 0 };

  const phaseSteps = Math.max(1, Math.min(frames, Math.round(periodFrames)));
  let bestCaptured = -1;
  let bestPhase = 0;
  for (let step = 0; step < phaseSteps; step += 1) {
    const phase = step;
    let captured = 0;
    for (let position = phase; position < frames; position += periodFrames) {
      const centre = Math.round(position);
      for (let d = -TOLERANCE_FRAMES; d <= TOLERANCE_FRAMES; d += 1) {
        const index = centre + d;
        if (index < 0 || index >= frames) continue;
        // Triangular weighting: a beat exactly on the grid counts more than one two frames off.
        const weight = (TOLERANCE_FRAMES + 1 - Math.abs(d)) / (TOLERANCE_FRAMES + 1);
        captured += weight * envelope[index]!;
      }
    }
    if (captured > bestCaptured) {
      bestCaptured = captured;
      bestPhase = phase;
    }
  }

  const beats = Math.max(1, Math.floor((frames - bestPhase) / periodFrames) + 1);
  const windowFrames = (TOLERANCE_FRAMES * 2 + 1) * 0.6; // effective width of the triangular kernel
  const chance = Math.min(1, (beats * windowFrames) / frames);
  const coverage = bestCaptured / totalEnergy;
  const excess = chance <= 0 ? 0 : coverage / chance;
  return { excess, phaseFrames: bestPhase, captured: bestCaptured, chance, coverage };
}

/**
 * Weighted least-squares fit of a beat grid to onset times.
 *
 * Each onset is assigned to the nearest grid beat (that assignment is reliable once the coarse grid
 * is within a quarter of a beat, which the frame-domain search guarantees), then `t ≈ first + k·period`
 * is fitted by weighted linear regression. Strong onsets weigh more.
 */
export function fitGridToOnsets(
  firstBeatMs: number,
  beatMs: number,
  onsets: readonly OnsetEvent[],
): { firstBeatMs: number; beatMs: number } | null {
  if (!(beatMs > 0) || onsets.length < 4) return null;
  let sumW = 0;
  let sumK = 0;
  let sumT = 0;
  let sumKK = 0;
  let sumKT = 0;
  let minK = Infinity;
  let maxK = -Infinity;
  for (const onset of onsets) {
    const k = Math.round((onset.timeMs - firstBeatMs) / beatMs);
    const residual = onset.timeMs - (firstBeatMs + k * beatMs);
    // Onsets that sit *between* grid lines (eighth-note hats, syncopated stabs) carry tempo
    // information but no phase information for this grid: including them at full weight pulls the
    // fitted phase towards the middle of a beat. Measured on the 128 BPM fixture, where hats on
    // every eighth put the grid 75 ms late. They are down-weighted rather than dropped, and the
    // fit runs twice, so the classification improves once the phase has been corrected once.
    const onGrid = Math.abs(residual) <= beatMs * 0.25;
    const w = onGrid ? 0.25 + onset.strength : 0.1 * (0.25 + onset.strength);
    minK = Math.min(minK, k);
    maxK = Math.max(maxK, k);
    sumW += w;
    sumK += w * k;
    sumT += w * onset.timeMs;
    sumKK += w * k * k;
    sumKT += w * k * onset.timeMs;
  }
  // Two beats of lever arm minimum: with all onsets on one or two grid positions the slope is
  // dominated by timing jitter of a single attack.
  if (maxK - minK < 2) return null;
  const denominator = sumW * sumKK - sumK * sumK;
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-9) return null;
  const period = (sumW * sumKT - sumK * sumT) / denominator;
  if (!Number.isFinite(period) || period <= 0) return null;
  const intercept = (sumT - period * sumK) / sumW;
  // Anchor the phase to the grid we fitted *against* rather than wrapping it blindly: a fit whose
  // intercept lands a fraction of a millisecond below zero would otherwise wrap to the end of the
  // period and drop the first beat of the track.
  const phase = normalizePhase(firstBeatMs + signedOffset(intercept - firstBeatMs, period), period);
  return { beatMs: period, firstBeatMs: phase };
}

/**
 * Ratio of captured energy between a grid's odd and even positions (min/max, so 1 means the
 * positions are equally strong and a low value means they alternate).
 *
 * Used only to decide whether a fast grid is really a subdivision of a slower beat: on a beat grid
 * whose eighths are all occupied by hats, every position looks occupied, but every *other* position
 * is weaker.
 */
export function alternationRatio(envelope: Float32Array, hopMs: number, bpm: number): number {
  const frames = envelope.length;
  const periodFrames = 60000 / bpm / hopMs;
  if (!Number.isFinite(periodFrames) || periodFrames < 4 || frames === 0) return 1;
  const { phaseFrames } = scoreGrid(envelope, hopMs, bpm);
  let even = 0;
  let odd = 0;
  let evenCount = 0;
  let oddCount = 0;
  let index = 0;
  for (let position = phaseFrames; position < frames; position += periodFrames, index += 1) {
    const centre = Math.round(position);
    let captured = 0;
    for (let d = -TOLERANCE_FRAMES; d <= TOLERANCE_FRAMES; d += 1) {
      const frame = centre + d;
      if (frame < 0 || frame >= frames) continue;
      captured += ((TOLERANCE_FRAMES + 1 - Math.abs(d)) / (TOLERANCE_FRAMES + 1)) * envelope[frame]!;
    }
    if (index % 2 === 0) {
      even += captured;
      evenCount += 1;
    } else {
      odd += captured;
      oddCount += 1;
    }
  }
  if (evenCount === 0 || oddCount === 0) return 1;
  const meanEven = even / evenCount;
  const meanOdd = odd / oddCount;
  const strong = Math.max(meanEven, meanOdd);
  const weak = Math.min(meanEven, meanOdd);
  if (strong <= 0) return 1;
  return weak / strong;
}

/**
 * Move the grid phase onto the onsets it was fitted to.
 *
 * Onset *frames* are quantised to the analysis hop (and the flux peak leads the attack), so the
 * fitted phase can be roughly 10–35 ms away from where the music actually is. Onset *times* are
 * refined to ~1.5 ms, so they are a far better phase reference than the frame index.
 *
 * The estimator is a **strength-weighted histogram**, not a circular mean, and that distinction is
 * not academic. A track with a kick on every beat and a hat on every off-beat has onsets spaced
 * every half beat; the circular mean of two equally spaced clusters is a quarter of a beat away
 * from both, i.e. it puts the beat grid exactly between the kick and the hat (measured: a 116 ms
 * phase error on a synthetic kick+hat track). A histogram has two peaks and the kick — heavier by
 * strength — wins. Only offsets within ±35 % of a beat of the coarse phase are counted, so the
 * half-beat cluster cannot vote at all.
 */
export function snapPhase(firstBeatMs: number, beatMs: number, onsets: readonly OnsetEvent[]): number {
  if (!(beatMs > 0) || onsets.length === 0) return normalizePhase(firstBeatMs, beatMs);
  const BINS = 64;
  const searchMs = beatMs * 0.35;
  const scores = new Float64Array(BINS);
  for (const onset of onsets) {
    const delta = signedOffset(onset.timeMs - firstBeatMs, beatMs);
    if (Math.abs(delta) > searchMs) continue;
    const ratio = (delta + searchMs) / (2 * searchMs);
    const bin = Math.max(0, Math.min(BINS - 1, Math.round(ratio * (BINS - 1))));
    scores[bin] = scores[bin]! + 0.25 + onset.strength;
  }

  let bestBin = -1;
  let bestScore = 0;
  for (let bin = 0; bin < BINS; bin += 1) {
    if (scores[bin]! > bestScore) {
      bestScore = scores[bin]!;
      bestBin = bin;
    }
  }
  if (bestBin < 0) return normalizePhase(firstBeatMs, beatMs);

  // Weighted centroid of the winning bin and its immediate neighbours: sub-bin resolution without
  // letting a distant second cluster pull the answer.
  const binMs = (2 * searchMs) / (BINS - 1);
  let sum = 0;
  let weight = 0;
  for (let bin = Math.max(0, bestBin - 1); bin <= Math.min(BINS - 1, bestBin + 1); bin += 1) {
    const centre = -searchMs + bin * binMs;
    sum += centre * scores[bin]!;
    weight += scores[bin]!;
  }
  const offset = weight > 0 ? sum / weight : -searchMs + bestBin * binMs;
  return normalizePhase(firstBeatMs + offset, beatMs);
}

/** Signed distance from a grid position to the nearest beat, in `(-beatMs/2, beatMs/2]`. */
function signedOffset(deltaMs: number, beatMs: number): number {
  const wrapped = ((deltaMs % beatMs) + beatMs) % beatMs;
  return wrapped > beatMs / 2 ? wrapped - beatMs : wrapped;
}

function normalizePhase(timeMs: number, beatMs: number): number {
  if (!(beatMs > 0)) return roundMs(timeMs);
  return roundMs(((timeMs % beatMs) + beatMs) % beatMs);
}

/** Beat positions from a phase, in ms, up to `durationMs`. */
export function gridBeats(beatMs: number, firstBeatMs: number, durationMs: number): number[] {
  if (!Number.isFinite(beatMs) || beatMs <= 0) return [];
  const beats: number[] = [];
  for (let time = firstBeatMs; time <= durationMs + 1e-6; time += beatMs) {
    beats.push(roundMs(time));
    if (beats.length > 100000) break;
  }
  return beats;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
