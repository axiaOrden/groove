/**
 * Difficulties: what each one *is*, in one place.
 *
 * Phase 3 generates three charts from one analysis. A difficulty is therefore a bundle of facts
 * that several layers need:
 *
 *   - **how many lanes** the highway renders and which keys sit on them (`laneCount`, `keys`),
 *   - **how hard the chart should be** (`generation`: density, spacing, chord and hold budgets),
 *   - **what a note is worth** (`scoreWeight`, consumed by the score model).
 *
 * Keeping those in one table is what stops the picker, the generator, the input map and the score
 * model from disagreeing about what "Normal" means. Nothing here is measured from audio: this file
 * is *configuration*, and `LaneProfile` is the matching table of where each musical role may land
 * once the lane count is known.
 *
 *     difficulty   lanes   keys                        weight   density
 *     ---------    -----   -------------------------   ------   ------------------------------
 *     easy         4       A S K L                     1.0      1.5 notes/s, 2-note chords
 *     normal       5       A S SPACE K L               1.5      2.2 notes/s, 2-note chords
 *     hard         7       A S D SPACE J K L           2.0      3.2 notes/s, 2-note chords
 *
 * **Phase 3.1 rebalance.** Hard's row is the phase 2.1 generator's own defaults, verbatim: the
 * seven-key chart a player already knew must not get harder. Phase 3 had raised Hard's chord size
 * to four simultaneous notes and, because each difficulty drew its own seed, replaced the seven-key
 * chart with a differently shaped one; both are reverted (see `PHASE3_1_NOTES.md`). Easy and Normal
 * are simplified *adaptations* of that baseline: lower density, wider minimum spacing, fewer chords
 * and fewer holds, never a bigger chord than the baseline's two notes.
 *
 * Requirement, not decoration: **Easy and Normal are generated in their own right**, from the same
 * analysis, with their own lane mapping and their own note selection. They are *not* Hard with lanes
 * hidden — the lane count changes which role pool an event may use (with four lanes there is no
 * SPACE at all, so accents land on the inner pair S/K), and the density budgets change which events
 * survive at all.
 */

import type { Difficulty } from './ChartTypes';
import { DIFFICULTY_WEIGHTS } from './ScoreModel';

/** The three difficulties this milestone generates charts for. `expert` stays a valid schema value. */
export type ChartDifficulty = 'easy' | 'normal' | 'hard';

export const CHART_DIFFICULTIES: readonly ChartDifficulty[] = ['easy', 'normal', 'hard'];

export function isChartDifficulty(value: unknown): value is ChartDifficulty {
  return value === 'easy' || value === 'normal' || value === 'hard';
}

export interface KeyBinding {
  /** Zero-indexed lane, left to right. */
  lane: number;
  /** Label shown in the HUD and on the touch pad. */
  label: string;
  /** `KeyboardEvent.code`, i.e. the physical key, so the keyboard layout does not matter. */
  code: string;
}

/** Chart-generation knobs a difficulty fixes. Mirrors `ChartGenerator.GenerateOptions`. */
export interface DifficultyGeneration {
  /** Target note density at full intensity, notes per second. */
  targetNotesPerSecond: number;
  /** Hard ceiling on notes in any one-second window. */
  maxNotesPerSecond: number;
  /** Minimum distance between any two notes (rapid lane jumps are hard to read). */
  minNoteGapMs: number;
  /** Minimum distance between two notes in the *same* lane. */
  minLaneGapMs: number;
  /** Maximum share of the chart that may be chord notes. */
  maxChordRatio: number;
  /** Maximum simultaneous notes in one chord (2 = two-note chords at most). */
  maxChordSize: number;
  /** Maximum share of the chart that may be holds. */
  maxHoldRatio: number;
  /** Maximum share of the chart that may sit on the SPACE lane (0 when the layout has no SPACE). */
  maxSpaceRatio: number;
}

export interface DifficultyProfile {
  id: ChartDifficulty;
  /** Display name for the picker: "EASY — 4 Keys". */
  title: string;
  /** Short label for compact places (HUD, library rows): "4 Keys". */
  short: string;
  laneCount: number;
  keys: readonly KeyBinding[];
  /** Score multiplier for every award on this difficulty. */
  scoreWeight: number;
  /** One line describing the pattern intent, shown under the difficulty card. */
  summary: string;
  generation: DifficultyGeneration;
}

const EASY_KEYS: readonly KeyBinding[] = [
  { lane: 0, label: 'A', code: 'KeyA' },
  { lane: 1, label: 'S', code: 'KeyS' },
  { lane: 2, label: 'K', code: 'KeyK' },
  { lane: 3, label: 'L', code: 'KeyL' },
];

const NORMAL_KEYS: readonly KeyBinding[] = [
  { lane: 0, label: 'A', code: 'KeyA' },
  { lane: 1, label: 'S', code: 'KeyS' },
  { lane: 2, label: 'SPACE', code: 'Space' },
  { lane: 3, label: 'K', code: 'KeyK' },
  { lane: 4, label: 'L', code: 'KeyL' },
];

const HARD_KEYS: readonly KeyBinding[] = [
  { lane: 0, label: 'A', code: 'KeyA' },
  { lane: 1, label: 'S', code: 'KeyS' },
  { lane: 2, label: 'D', code: 'KeyD' },
  { lane: 3, label: 'SPACE', code: 'Space' },
  { lane: 4, label: 'J', code: 'KeyJ' },
  { lane: 5, label: 'K', code: 'KeyK' },
  { lane: 6, label: 'L', code: 'KeyL' },
];

export const DIFFICULTY_PROFILES: Readonly<Record<ChartDifficulty, DifficultyProfile>> = {
  easy: {
    id: 'easy',
    title: 'EASY — 4 Keys',
    short: '4 Keys',
    laneCount: 4,
    keys: EASY_KEYS,
    scoreWeight: DIFFICULTY_WEIGHTS.easy,
    summary: 'Prominent beats and strong onsets only, single notes and a few two-note chords.',
    generation: {
      // Deliberately sparse: a beginner needs the beat, not the sixteenths. The generator's density
      // budget is intensity-scaled, so 1.5 notes/s is an average over a loud chorus, not a floor.
      targetNotesPerSecond: 1.5,
      maxNotesPerSecond: 5,
      // Nearly twice Hard's minimum gap: at 170 ms the lane walk stays a step-at-a-time pattern
      // instead of a jump across the keyboard, and every note is comfortably readable.
      minNoteGapMs: 170,
      minLaneGapMs: 220,
      maxChordRatio: 0.05,
      maxChordSize: 2,
      maxHoldRatio: 0.08,
      // No SPACE lane exists on 4 keys; the generator ignores this and maps accents to S/K.
      maxSpaceRatio: 0,
    },
  },
  normal: {
    id: 'normal',
    title: 'NORMAL — 5 Keys',
    short: '5 Keys',
    laneCount: 5,
    keys: NORMAL_KEYS,
    scoreWeight: DIFFICULTY_WEIGHTS.normal,
    summary: 'The beat on SPACE, with supporting percussion and melodic accents around it.',
    generation: {
      // Between Easy and Hard, and closer to Easy: a five-key layout has fewer places for an accent
      // to go, so the same density reads as harder than it does on seven keys.
      targetNotesPerSecond: 2.2,
      maxNotesPerSecond: 7,
      minNoteGapMs: 120,
      minLaneGapMs: 180,
      maxChordRatio: 0.09,
      // Two notes, like the baseline: three simultaneous notes on a five-key layout with two hands
      // is a chord shape the original gameplay never asked for.
      maxChordSize: 2,
      maxHoldRatio: 0.12,
      maxSpaceRatio: 0.3,
    },
  },
  hard: {
    id: 'hard',
    title: 'HARD — 7 Keys',
    short: '7 Keys',
    laneCount: 7,
    keys: HARD_KEYS,
    scoreWeight: DIFFICULTY_WEIGHTS.hard,
    summary: 'The full seven-key chart: higher density, syncopation and larger accents.',
    generation: {
      // Byte-for-byte the phase 2.1 generator defaults (and the generator's own `DEFAULTS`), so the
      // seven-key chart a player knows is reproduced exactly, not merely approximated. Do not raise
      // anything here without a new milestone: this row *is* the definition of Hard.
      targetNotesPerSecond: 3.2,
      maxNotesPerSecond: 9,
      minNoteGapMs: 90,
      minLaneGapMs: 150,
      maxChordRatio: 0.12,
      maxChordSize: 2,
      maxHoldRatio: 0.15,
      maxSpaceRatio: 0.34,
    },
  },
};

export function difficultyProfile(id: ChartDifficulty): DifficultyProfile {
  return DIFFICULTY_PROFILES[id];
}

/** Profile for any schema difficulty value, falling back to hard for `expert`/unknown. */
export function difficultyProfileOf(value: Difficulty | undefined): DifficultyProfile {
  return isChartDifficulty(value) ? DIFFICULTY_PROFILES[value] : DIFFICULTY_PROFILES.hard;
}

export function isDifficultyAvailable(id: ChartDifficulty, available: readonly ChartDifficulty[]): boolean {
  return available.includes(id);
}

/** Key labels for a lane count, in lane order, for the HUD, the touch pads and the chart. */
export function keyLabelsFor(laneCount: number): string[] {
  const profile = profileForLaneCount(laneCount);
  return profile.keys.map((entry) => entry.label);
}

function profileForLaneCount(laneCount: number): DifficultyProfile {
  const found = CHART_DIFFICULTIES.map((id) => DIFFICULTY_PROFILES[id]).find(
    (profile) => profile.laneCount === laneCount,
  );
  return found ?? DIFFICULTY_PROFILES.hard;
}

/** Key code -> lane for a key map, used by the input manager. */
export function keyCodeToLane(keys: readonly KeyBinding[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const entry of keys) map[entry.code] = entry.lane;
  return map;
}

/**
 * Every key code that belongs to *any* difficulty.
 *
 * The input manager suppresses the default browser action (SPACE scrolling the page, letters
 * reaching a focused widget) for these keys whatever the current lane count is: on Easy, SPACE is
 * not a lane, and a page that scrolls when the player mashes it is a bug.
 */
export const ALL_LANE_KEY_CODES: readonly string[] = [
  ...new Set(CHART_DIFFICULTIES.flatMap((id) => DIFFICULTY_PROFILES[id].keys.map((entry) => entry.code))),
];
