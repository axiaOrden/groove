/**
 * Gameplay configuration: key map, judgment windows, score rules and the offset conventions.
 *
 * ------------------------------------------------------------------ offset conventions --
 * Three independent numbers affect timing. They are deliberately *not* interchangeable:
 *
 * 1. `chart.offsetMs` — a property of the beatmap JSON (per-chart offset). It is added to
 *    every note time, so it shifts **both** what you see and what you are judged against.
 *    Positive = the chart plays later relative to the audio file.
 *
 * 2. `settings.globalOffsetMs` — the player's calibration value. It shifts **judgment only**:
 *
 *        judgeTimeMs = songTimeMs - settings.globalOffsetMs
 *
 *    This single formula is used for every input and every miss deadline, so the whole
 *    judgment system moves together. Positive = your presses tend to land *late* (slow
 *    display, delayed audio, sluggish device), so presses are measured earlier. A player who
 *    consistently hits "+30 ms" on the results screen raises this by 30.
 *
 * 3. `settings.noteSpeed` — purely visual. It changes how long a note is visible before the
 *    hit line and never affects judged timing. Rendering reads the same song clock as
 *    judgment, so changing speed mid-song cannot desynchronise the two.
 *
 * The calibration wizard (phase 2) will measure (2) automatically.
 */

import type { TimingWindows } from '../chart/ChartTypes';

export type JudgmentType = 'perfect' | 'good' | 'bad' | 'miss';

export const JUDGMENT_TYPES: readonly JudgmentType[] = ['perfect', 'good', 'bad', 'miss'];

/** PERFECT and GOOD build combo; BAD and MISS break it. Boundaries are inclusive upper bounds. */
export const DEFAULT_TIMING_WINDOWS: TimingWindows = {
  perfectMs: 45,
  goodMs: 100,
  badMs: 160,
};

export const COMBO_INCREASING: readonly JudgmentType[] = ['perfect', 'good'];
export const COMBO_BREAKING: readonly JudgmentType[] = ['bad', 'miss'];

export function isComboIncreasing(judgment: JudgmentType): boolean {
  return judgment === 'perfect' || judgment === 'good';
}

export interface LaneKey {
  lane: number;
  /** Label shown in the HUD. */
  label: string;
  /** `KeyboardEvent.code`, i.e. the physical key, so the layout does not matter. */
  code: string;
}

export const LANE_KEYS: readonly LaneKey[] = [
  { lane: 0, label: 'A', code: 'KeyA' },
  { lane: 1, label: 'S', code: 'KeyS' },
  { lane: 2, label: 'D', code: 'KeyD' },
  { lane: 3, label: 'SPACE', code: 'Space' },
  { lane: 4, label: 'J', code: 'KeyJ' },
  { lane: 5, label: 'K', code: 'KeyK' },
  { lane: 6, label: 'L', code: 'KeyL' },
];

export const KEY_CODE_TO_LANE: Readonly<Record<string, number>> = Object.freeze(
  LANE_KEYS.reduce<Record<string, number>>((map, entry) => {
    map[entry.code] = entry.lane;
    return map;
  }, {}),
);

export interface ScoreRules {
  /** Points for a tap before the combo multiplier. */
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

export interface GameSettings {
  /** See the offset conventions above. */
  globalOffsetMs: number;
  /** Visual only. 1 = a note is visible for BASE_LEAD_MS before the hit line. */
  noteSpeed: number;
  /** 0..1 master volume for the demo track and feedback ticks. */
  volume: number;
}

export const DEFAULT_SETTINGS: GameSettings = {
  globalOffsetMs: 0,
  noteSpeed: 1,
  volume: 0.7,
};

export const OFFSET_LIMITS = { min: -200, max: 200, step: 5 } as const;
export const NOTE_SPEED_LIMITS = { min: 0.5, max: 2.5, step: 0.1 } as const;

export interface DerivedTiming {
  windows: TimingWindows;
  rules: ScoreRules;
  globalOffsetMs: number;
}

export function deriveTiming(settings: GameSettings, windows = DEFAULT_TIMING_WINDOWS, rules = DEFAULT_SCORE_RULES): DerivedTiming {
  return { windows, rules, globalOffsetMs: settings.globalOffsetMs };
}
