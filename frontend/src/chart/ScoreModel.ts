/**
 * Score model — the arithmetic of scoring, in one place.
 *
 * This module is deliberately *pure data and pure functions*: no DOM, no audio, no engine state.
 * That is what lets three very different callers share one formula instead of three copies of it:
 *
 *   - `ScoreManager` awards points during play,
 *   - the chart layer states a chart's **theoretical maximum** before the song is ever played
 *     (the difficulty picker shows it, and `Beatmap.maxScore` carries it),
 *   - the tests pin the model down without constructing a game.
 *
 * The model (phase 3):
 *
 *     multiplier   = 1 + comboMultiplierStep × min(combo, comboMultiplierCap)      (1.0× … 2.0×)
 *     units        = tapWeight for a tap, holdWeight for a hold (head + tail)
 *     note score   = round(basePoints[judgment] × units × multiplier × difficultyWeight)
 *
 * A hold's **tail** is scored at the multiplier its head was awarded at (`awardHoldTail`'s
 * `comboAtHead`), not at whatever the combo happens to be when the tail arrives. That makes a
 * hold's total value a property of the note rather than of when the player let go, and it is what
 * makes the theoretical maximum below a number a perfect run can actually hit — see
 * `perfectRunScore`.
 *
 * Two things this file exists to keep separate:
 *
 *   - **accuracy** is judgment-weighted and *never* touched by `difficultyWeight`, so an Easy run
 *     and a Hard run are comparable ("Accuracy must remain normalized and independent of
 *     difficulty multipliers");
 *   - **score** scales with `difficultyWeight` (Easy 1.0, Normal 1.5, Hard 2.0), so a harder chart
 *     is worth more per note. Score records therefore store the weight they were earned with
 *     (`ScoreEntry.difficultyWeight`) rather than re-deriving it from a table that may change.
 *
 * ## Why the maximum is a simulation and not a formula
 *
 * Phase 3 shipped `maxScore = units × 300 × 2.0 × weight`, i.e. "every unit at the capped 2.0×
 * multiplier". No play can produce that number: the multiplier only reaches 2.0 at combo 100, so the
 * first hundred units are worth strictly less. A perfect run therefore read ~57 % of its own
 * maximum. The maximum is now computed by *playing the chart* — `perfectRunScore` walks the notes in
 * chart order with the same `awardPoints` arithmetic the live scorer uses — so the number the HUD
 * and the results screen show is exactly what a flawless run scores, and the percentage reaches
 * 100 %.
 */

import type { ChartNote, Difficulty } from './ChartTypes';

export type JudgmentType = 'perfect' | 'good' | 'bad' | 'miss';

export const JUDGMENT_TYPES: readonly JudgmentType[] = ['perfect', 'good', 'bad', 'miss'];

export interface ScoreRules {
  /** Points for a tap before the combo multiplier and the difficulty weight. */
  basePoints: Record<JudgmentType, number>;
  /** Multiplier grows by this per combo step: 1 + step * min(combo, cap). */
  comboMultiplierStep: number;
  /** Combo value at which the multiplier stops growing. */
  comboMultiplierCap: number;
  /** A tap is worth this many units; a hold head + tail is worth `holdWeight` units in total. */
  tapWeight: number;
  holdWeight: number;
  /** Releasing within this many ms of the tail still counts as completing the hold. */
  holdReleaseGraceMs: number;
}

export const DEFAULT_SCORE_RULES: ScoreRules = {
  basePoints: { perfect: 300, good: 200, bad: 100, miss: 0 },
  comboMultiplierStep: 0.01,
  comboMultiplierCap: 100,
  tapWeight: 1,
  holdWeight: 2,
  holdReleaseGraceMs: 100,
};

/** Combo multiplier at a given combo value, capped. Deterministic and monotonic. */
export function comboMultiplier(combo: number, rules: ScoreRules = DEFAULT_SCORE_RULES): number {
  const capped = Math.min(Math.max(0, combo), rules.comboMultiplierCap);
  return 1 + rules.comboMultiplierStep * capped;
}

/**
 * Points for one award at a combo value — **the** scoring formula, shared by the live score manager
 * and by the theoretical-maximum simulation so the two can never drift apart.
 */
export function awardPoints(
  judgment: JudgmentType,
  units: number,
  combo: number,
  difficultyWeight = 1,
  rules: ScoreRules = DEFAULT_SCORE_RULES,
): number {
  const base = rules.basePoints[judgment] ?? 0;
  const weight = Number.isFinite(difficultyWeight) ? Math.max(0, difficultyWeight) : 1;
  const safeUnits = Number.isFinite(units) ? units : 0;
  return Math.round(base * safeUnits * comboMultiplier(combo, rules) * weight);
}

/** Units a note is worth: a tap is `tapWeight`, a hold is `holdWeight` (head + tail). */
export function noteUnitsOf(type: ChartNote['type'], rules: ScoreRules = DEFAULT_SCORE_RULES): number {
  return type === 'hold' ? rules.holdWeight : rules.tapWeight;
}

/**
 * Total units in a chart. This is the multiplier-free "size" of a chart and the reason the maximum
 * score depends on the *note mix* as well as the note count: a hold is worth two units, so two
 * charts with the same note count but different hold counts have different maximums.
 */
export function totalNoteUnits(notes: readonly ChartNote[], rules: ScoreRules = DEFAULT_SCORE_RULES): number {
  let units = 0;
  for (const note of notes) units += noteUnitsOf(note.type, rules);
  return units;
}

/**
 * Score of a flawless run of `notes`: every head PERFECT on time, in chart order, every hold held to
 * its tail. This is the *theoretical maximum* — and it is reachable, because it is computed with the
 * same per-award arithmetic (`awardPoints`) and the same combo progression the live scorer uses:
 * the first note is judged at combo 1, the second at combo 2, and so on (capped at 100).
 *
 * The note **mix** matters as much as the count: a hold adds `holdWeight - 1` extra units at its
 * head's combo, so swapping taps for holds raises the maximum. Order within a chord is chart order
 * (time, then lane), which is the order a player reads the chord in.
 */
export function perfectRunScore(
  notes: readonly ChartNote[],
  difficultyWeight = 1,
  rules: ScoreRules = DEFAULT_SCORE_RULES,
): number {
  let combo = 0;
  let score = 0;
  for (const note of perfectRunOrder(notes)) {
    combo += 1;
    // A head is always one unit (`GameEngine.pressLane` awards it with units = 1); a hold's tail is
    // the rest of its weight, awarded by the engine at the head's combo.
    score += awardPoints('perfect', 1, combo, difficultyWeight, rules);
    if (note.type === 'hold') {
      score += awardPoints('perfect', Math.max(0, rules.holdWeight - 1), combo, difficultyWeight, rules);
    }
  }
  return score;
}

/**
 * The order a flawless run is scored in: chart order (time, then lane) with one refinement — inside
 * a chord, the **holds come last**.
 *
 * The refinement is what makes this the true maximum rather than one arbitrary play. The sum of the
 * heads is the same whatever order a chord is pressed in (the group's combo values are the same set
 * either way), but a hold's tail is scored at its *head's* multiplier, so giving the hold heads the
 * larger combo values of their group is strictly better. A player reaches this by pressing the taps
 * of a chord before its holds; pressing them the other way round scores a little less, which is why
 * the maximum is an upper bound that a real run can be just under (and never above).
 */
export function perfectRunOrder(notes: readonly ChartNote[]): ChartNote[] {
  return [...notes].sort(
    (a, b) =>
      a.timeMs - b.timeMs ||
      (a.type === 'hold' ? 1 : 0) - (b.type === 'hold' ? 1 : 0) ||
      a.lane - b.lane,
  );
}

/** Convenience: the reachable maximum for a chart's own notes at a difficulty weight. */
export function maxTheoreticalScoreOf(
  notes: readonly ChartNote[],
  difficultyWeight = 1,
  rules: ScoreRules = DEFAULT_SCORE_RULES,
): number {
  return perfectRunScore(notes, difficultyWeight, rules);
}

export type Grade = 'S' | 'A' | 'B' | 'C' | 'D' | 'F';

/** Accuracy-derived grade. Accuracy is judgment-weighted and combo independent. */
export function gradeForAccuracy(accuracy: number): Grade {
  if (accuracy >= 0.95) return 'S';
  if (accuracy >= 0.9) return 'A';
  if (accuracy >= 0.8) return 'B';
  if (accuracy >= 0.7) return 'C';
  if (accuracy >= 0.6) return 'D';
  return 'F';
}

/** Difficulty weights, in one place so the docs, the UI and the tests cannot drift apart. */
export const DIFFICULTY_WEIGHTS: Readonly<Record<Difficulty, number>> = {
  easy: 1,
  normal: 1.5,
  hard: 2,
  expert: 2.4,
};
