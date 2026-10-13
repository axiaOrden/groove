/**
 * ScoreManager — combo, score, accuracy and the final results.
 *
 * Scoring rules (transparent, and the only place points are created):
 *
 *   combo         +1 for PERFECT/GOOD, reset to 0 for BAD/MISS and for a broken hold.
 *                 A completed hold does *not* add a second combo step: combo counts notes.
 *   multiplier    1 + 0.01 * min(combo, 100)  -> 1.0x at combo 0, 2.0x from combo 100 on.
 *   units         a tap is 1 unit, a hold is 2 units (head 1 + tail 1).
 *   points        round(basePoints[judgment] * units * multiplier * difficultyWeight)
 *                 PERFECT 300, GOOD 200, BAD 100, MISS 0 at weight 1.
 *   hold tail     awarded on completion using the head's judgment *and the head's combo multiplier*
 *                 (so a hold is worth the same whether it is held to its tail or, within the
 *                 release grace, let go early); forfeited when the hold is released early, and
 *                 forfeited without combo penalty when paused mid-hold.
 *
 * The hold-tail rule is what makes the theoretical maximum exact: the score of a flawless run is
 * `perfectRunScore(chart.notes)` (see `chart/ScoreModel`), which is also what a perfect play
 * produces, so the score/max percentage reaches 100 %.
 *
 * **Difficulty weight (phase 3)**: Easy 1.0, Normal 1.5, Hard 2.0, applied to every award
 * including hold tails. It is a *score* multiplier and nothing else — accuracy, combo and the
 * judgment windows are untouched, so an Easy and a Hard run can be compared on accuracy, and the
 * recorded score always carries the weight it was earned with (`ScoreEntry.difficultyWeight`).
 *
 * Accuracy is judgment-weighted and combo independent, which keeps it comparable between
 * runs and independent of where in a chart the mistakes happened:
 *
 *   accuracy = (300*PERFECT + 200*GOOD + 100*BAD) / (300 * judgedNotes)
 *
 * Only note *heads* are judged, so `judgedNotes` equals the number of notes by the end and
 * accuracy always has the same denominator. An empty chart reports 100%.
 */

import type { JudgmentType, ScoreRules } from './GameConfig';
import { DEFAULT_SCORE_RULES, gradeForAccuracy, isComboIncreasing, type Grade } from './GameConfig';
import { difficultyProfile, type ChartDifficulty } from '../chart/Difficulty';
import { awardPoints, comboMultiplier, perfectRunScore, DIFFICULTY_WEIGHTS } from '../chart/ScoreModel';
import type { ChartNote } from '../chart/ChartTypes';

export interface JudgmentCounts {
  perfect: number;
  good: number;
  bad: number;
  miss: number;
}

export interface ScoreSnapshot {
  score: number;
  combo: number;
  maxCombo: number;
  accuracy: number;
  counts: JudgmentCounts;
  holdCompleted: number;
  holdBroken: number;
  interruptedHolds: number;
  strayPresses: number;
  judgedNotes: number;
}

export interface PlayResults extends ScoreSnapshot {
  grade: Grade;
  totalNotes: number;
  /** Note *units* judged: a tap is 1, a hold is 2 (head + tail). */
  totalUnits: number;
  /**
   * Score of a flawless run of this chart: every note PERFECT, in chart order, every hold held to
   * its tail — the same arithmetic the live scorer uses, so a perfect run reaches exactly this
   * number (see `perfectRunScore` in `chart/ScoreModel.ts`).
   */
  maxScore: number;
  finishedAtMs: number;
  difficulty: ChartDifficulty;
  /** The multiplier actually applied to every award in this run. */
  difficultyWeight: number;
}

export interface ScoreManagerOptions {
  /** Difficulty the run is played at; sets `difficultyWeight` when that is not given. */
  difficulty?: ChartDifficulty;
  /** Explicit score multiplier, overriding the difficulty's. */
  difficultyWeight?: number;
}

export interface AwardBreakdown {
  judgment: JudgmentType;
  units: number;
  multiplier: number;
  points: number;
  combo: number;
}

export class ScoreManager {
  private readonly rules: ScoreRules;
  private readonly difficultyValue: ChartDifficulty;
  private readonly weight: number;
  private scoreValue = 0;
  private comboValue = 0;
  private maxComboValue = 0;
  private readonly countsValue: JudgmentCounts = { perfect: 0, good: 0, bad: 0, miss: 0 };
  private holdCompletedValue = 0;
  private holdBrokenValue = 0;
  private interruptedHoldsValue = 0;
  private strayPressesValue = 0;
  private judgedNotesValue = 0;
  private finishedAtMsValue = 0;

  constructor(rules: ScoreRules = DEFAULT_SCORE_RULES, options: ScoreManagerOptions = {}) {
    this.rules = rules;
    this.difficultyValue = options.difficulty ?? 'hard';
    // With no difficulty named the weight stays 1, which keeps the pre-phase-3 arithmetic intact
    // for callers that only care about the judgment model.
    this.weight =
      options.difficultyWeight ?? (options.difficulty ? difficultyProfile(options.difficulty).scoreWeight : 1);
  }

  get difficulty(): ChartDifficulty {
    return this.difficultyValue;
  }

  get difficultyWeight(): number {
    return this.weight;
  }

  get score(): number {
    return this.scoreValue;
  }

  get combo(): number {
    return this.comboValue;
  }

  get maxCombo(): number {
    return this.maxComboValue;
  }

  get counts(): Readonly<JudgmentCounts> {
    return this.countsValue;
  }

  get judgedNotes(): number {
    return this.judgedNotesValue;
  }

  get holdCompleted(): number {
    return this.holdCompletedValue;
  }

  get holdBroken(): number {
    return this.holdBrokenValue;
  }

  get interruptedHolds(): number {
    return this.interruptedHoldsValue;
  }

  get strayPresses(): number {
    return this.strayPressesValue;
  }

  get accuracy(): number {
    const judged = this.judgedNotesValue;
    if (judged === 0) return 1;
    const weighted =
      this.countsValue.perfect * 300 + this.countsValue.good * 200 + this.countsValue.bad * 100;
    return weighted / (300 * judged);
  }

  /** Multiplier that will apply to the *next* award at the current combo. */
  get multiplier(): number {
    return this.multiplierFor(this.comboValue);
  }

  multiplierFor(combo: number): number {
    return comboMultiplier(combo, this.rules);
  }

  /** Points for one award: the shared formula from `chart/ScoreModel`, so the maximum and the live
   * score cannot disagree. */
  pointsFor(judgment: JudgmentType, units: number, combo: number): number {
    return awardPoints(judgment, units, combo, this.weight, this.rules);
  }

  /**
   * Award the head of a note (tap or hold head). `units` defaults to 1; a hold head is always
   * 1 unit and its tail is awarded separately.
   */
  awardHead(judgment: JudgmentType, units = 1): AwardBreakdown {
    this.countsValue[judgment] += 1;
    this.judgedNotesValue += 1;

    if (isComboIncreasing(judgment)) {
      this.comboValue += 1;
      this.maxComboValue = Math.max(this.maxComboValue, this.comboValue);
    } else {
      this.comboValue = 0;
    }

    // BAD breaks combo, so its multiplier is always 1; hits use the incremented combo.
    const multiplier = this.multiplierFor(this.comboValue);
    const points = this.pointsFor(judgment, units, this.comboValue);
    this.scoreValue += points;

    return { judgment, units, multiplier, points, combo: this.comboValue };
  }

  /**
   * Award the tail of a completed hold, using the head's judgment and (when the caller passes it)
   * the combo the head was awarded at. Scoring the tail at the head's multiplier keeps a hold's
   * value independent of when inside its release window the player let go.
   */
  awardHoldTail(judgment: JudgmentType, units = this.rules.holdWeight - 1, comboAtHead?: number): number {
    const combo = comboAtHead !== undefined && Number.isFinite(comboAtHead) ? comboAtHead : this.comboValue;
    const points = this.pointsFor(judgment, units, combo);
    this.scoreValue += points;
    this.holdCompletedValue += 1;
    return points;
  }

  /** Released before the tail: combo breaks, tail score is forfeited, no extra judgment. */
  registerHoldBreak(): void {
    this.holdBrokenValue += 1;
    this.comboValue = 0;
  }

  /** Paused mid-hold: tail forfeited, but pausing never punishes the player. */
  registerInterruptedHold(): void {
    this.interruptedHoldsValue += 1;
  }

  /** A press that matched no note. Ignored for scoring; only counted for the results screen. */
  registerStrayPress(): void {
    this.strayPressesValue += 1;
  }

  snapshot(): ScoreSnapshot {
    return {
      score: this.scoreValue,
      combo: this.comboValue,
      maxCombo: this.maxComboValue,
      accuracy: this.accuracy,
      counts: { ...this.countsValue },
      holdCompleted: this.holdCompletedValue,
      holdBroken: this.holdBrokenValue,
      interruptedHolds: this.interruptedHoldsValue,
      strayPresses: this.strayPressesValue,
      judgedNotes: this.judgedNotesValue,
    };
  }

  /**
   * Final results.
   *
   * `extras.totalUnits` is the note *mix* of the chart (a hold is two units); it defaults to
   * `totalNotes` so a caller with a tap-only chart does not have to compute it.
   */
  results(
    totalNotes: number,
    finishedAtMs: number,
    extras: { notes?: readonly ChartNote[]; totalUnits?: number; difficulty?: ChartDifficulty } = {},
  ): PlayResults {
    this.finishedAtMsValue = finishedAtMs;
    const unitCount = Number.isFinite(extras.totalUnits) ? Math.max(0, extras.totalUnits as number) : totalNotes;
    // The maximum is a flawless run of the chart itself. When a caller only knows how many notes
    // there are (the pre-phase-3 call shape), the notes are assumed to be taps, which is exactly the
    // chart that shape describes.
    const notes = extras.notes ?? tapNotesOf(totalNotes);
    const maxScore = perfectRunScore(notes, this.weight, this.rules);
    return {
      ...this.snapshot(),
      grade: gradeForAccuracy(this.accuracy),
      totalNotes,
      totalUnits: unitCount,
      maxScore,
      finishedAtMs: this.finishedAtMsValue,
      difficulty: extras.difficulty ?? this.difficultyValue,
      difficultyWeight: this.weight,
    };
  }
}

/** Tap-only notes for a count: the shape a caller who only knows `totalNotes` is describing. */
function tapNotesOf(count: number): ChartNote[] {
  const safe = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const notes: ChartNote[] = [];
  for (let index = 0; index < safe; index += 1) {
    notes.push({ timeMs: index * 1000, lane: 0, type: 'tap' });
  }
  return notes;
}

/** The weights, re-exported so the HUD/results screen and the docs read from one table. */
export { DIFFICULTY_WEIGHTS };
