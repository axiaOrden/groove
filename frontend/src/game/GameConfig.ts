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
import { ALL_LANE_KEY_CODES, DIFFICULTY_PROFILES, keyCodeToLane, type KeyBinding } from '../chart/Difficulty';
// The lane palettes are renderer geometry (they are per *lane*, and live beside `laneColorsFor`), so
// the default id is read from there instead of being spelled out again here.
import { DEFAULT_LANE_PALETTE_ID, isLanePaletteId } from '../renderer/Layout';

// Scoring lives in `chart/ScoreModel` because the chart layer has to be able to state a chart's
// theoretical maximum before a note is ever played. Re-exported here so every existing import of
// `JudgmentType` / `ScoreRules` / `DEFAULT_SCORE_RULES` from the game layer keeps working.
import {
  DEFAULT_SCORE_RULES,
  JUDGMENT_TYPES,
  gradeForAccuracy,
  type Grade,
  type JudgmentType,
  type ScoreRules,
} from '../chart/ScoreModel';

export type { Grade, JudgmentType, ScoreRules };
export { DEFAULT_SCORE_RULES, JUDGMENT_TYPES, gradeForAccuracy };

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

/** A lane's key: the same shape as `chart/Difficulty`'s `KeyBinding`, kept as an alias here because
 * the game layer talks about "lane keys" rather than about difficulties. */
export type LaneKey = KeyBinding;

/**
 * The seven-key map (Hard), kept as the default so existing callers and tests do not have to name a
 * difficulty. Phase 3 makes the *active* map per-difficulty: `InputManager.setKeyLayout` installs
 * the four-, five- or seven-key map when a chart loads.
 */
export const LANE_KEYS: readonly LaneKey[] = DIFFICULTY_PROFILES.hard.keys;

export const KEY_CODE_TO_LANE: Readonly<Record<string, number>> = Object.freeze(
  keyCodeToLane(LANE_KEYS),
);

/** Build the key-code map for a layout. Used by the input manager on difficulty change. */
export function keyMapFor(keys: readonly LaneKey[]): Record<string, number> {
  return keyCodeToLane(keys);
}

/**
 * Every key that belongs to *any* difficulty (A S D SPACE J K L). The input manager suppresses the
 * browser's default action for all of them whatever the active lane count is, so SPACE cannot
 * scroll the page on a four-lane chart where it is not a lane.
 */
export { ALL_LANE_KEY_CODES };

export interface GameSettings {
  /** See the offset conventions above. */
  globalOffsetMs: number;
  /** Visual only. 1 = a note is visible for BASE_LEAD_MS before the hit line. */
  noteSpeed: number;
  /** 0..1 master volume for the demo track and feedback ticks. */
  volume: number;
  /** Id of the lane palette (`LANE_PALETTES` in `renderer/Layout`). Purely visual. */
  lanePalette: string;
}

export const DEFAULT_SETTINGS: GameSettings = {
  globalOffsetMs: 0,
  noteSpeed: 1,
  volume: 0.7,
  lanePalette: DEFAULT_LANE_PALETTE_ID,
};

/** Clamp a palette id: an unknown or hand-edited value falls back to the default theme. */
export function clampLanePalette(value: unknown): string {
  return isLanePaletteId(value) ? value : DEFAULT_LANE_PALETTE_ID;
}

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
