/**
 * ScoreManager — combo, score, accuracy and the final results.
 *
 * Scoring rules (transparent, and the only place points are created):
 *
 *   combo         +1 for PERFECT/GOOD, reset to 0 for BAD/MISS and for a broken hold.
 *                 A completed hold does *not* add a second combo step: combo counts notes.
 *   multiplier    1 + 0.01 * min(combo, 100)  -> 1.0x at combo 0, 2.0x from combo 100 on.
 *   units         a tap is 1 unit, a hold is 2 units (head 1 + tail 1).
 *   points        round(basePoints[judgment] * units * multiplier)
 *                 PERFECT 300, GOOD 200, BAD 100, MISS 0.
 *   hold tail     awarded on completion using the head's judgment; forfeited when the hold is
 *                 released early, and forfeited without combo penalty when paused mid-hold.
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
  /** Full theoretical score at this chart's note count, useful for progress bars. */
  maxScore: number;
  finishedAtMs: number;
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

  constructor(rules: ScoreRules = DEFAULT_SCORE_RULES) {
    this.rules = rules;
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
    const capped = Math.min(combo, this.rules.comboMultiplierCap);
    return 1 + this.rules.comboMultiplierStep * capped;
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
    const points = Math.round(this.rules.basePoints[judgment] * units * multiplier);
    this.scoreValue += points;

    return { judgment, units, multiplier, points, combo: this.comboValue };
  }

  /** Award the tail of a completed hold, using the head's judgment. */
  awardHoldTail(judgment: JudgmentType, units = this.rules.holdWeight - 1): number {
    const multiplier = this.multiplierFor(this.comboValue);
    const points = Math.round(this.rules.basePoints[judgment] * units * multiplier);
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

  results(totalNotes: number, finishedAtMs: number): PlayResults {
    this.finishedAtMsValue = finishedAtMs;
    const maxScore = Math.round(
      totalNotes * this.rules.basePoints.perfect * this.multiplierFor(this.rules.comboMultiplierCap),
    );
    return {
      ...this.snapshot(),
      grade: gradeForAccuracy(this.accuracy),
      totalNotes,
      maxScore,
      finishedAtMs: this.finishedAtMsValue,
    };
  }
}
