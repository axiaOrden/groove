/**
 * Versioned beatmap schema.
 *
 * Conventions (authoritative for the whole codebase):
 *  - Every timestamp is in **milliseconds relative to the start of the decoded song**.
 *    Rendering lead time, scroll speed and note-speed settings are purely visual and never
 *    change these numbers.
 *  - `lane` is zero-indexed, 0..6, left to right: A S D SPACE J K L.
 *  - `durationMs` exists only on `hold` notes and is measured from `timeMs` (the head).
 *  - `offsetMs` is a per-chart audio offset: the *effective* time of a note is
 *    `note.timeMs + chart.offsetMs + globalOffsetMs`-style composition is intentionally
 *    NOT applied here; the game applies chart offset to both visuals and judgment, and the
 *    user's global calibration offset to judgment only. See src/game/GameConfig.ts.
 *
 * The schema is intentionally small and JSON-serialisable so the same object can be stored
 * in IndexedDB (phase 4), exported by the editor and validated as untrusted input by the
 * Laravel API (phase 5).
 */

export const BEATMAP_SCHEMA_VERSION = 1;

export const LANE_COUNT = 7;

export type Difficulty = 'easy' | 'normal' | 'hard' | 'expert';

export type NoteType = 'tap' | 'hold';

export interface ChartNote {
  /** Milliseconds from song start. */
  timeMs: number;
  /** Zero-indexed lane, 0..LANE_COUNT-1. */
  lane: number;
  type: NoteType;
  /** Hold length in ms. Present (and > 0) for `hold` notes only. */
  durationMs?: number;
}

export interface ChartGeneratorInfo {
  name: string;
  version: string;
  /** Reserved for the deterministic analyser/generator (phase 3); 0 for hand-authored charts. */
  seed: number;
}

export interface Beatmap {
  schemaVersion: number;
  songId: string;
  title: string;
  artist?: string;
  charter?: string;
  difficulty: Difficulty;
  /** Beats per minute used for the beat grid / editor snapping. */
  bpm: number;
  /** Per-chart offset in ms, added to every note time (both visuals and judgment). */
  offsetMs: number;
  generator: ChartGeneratorInfo;
  /** Optional hint; the authoritative duration is the decoded audio buffer. */
  durationMs?: number;
  notes: ChartNote[];
}

/** Inclusive upper bounds of each judgment window, in ms of absolute timing error. */
export interface TimingWindows {
  perfectMs: number;
  goodMs: number;
  badMs: number;
}

/** End of a note in chart time (head for taps, tail for holds). */
export function noteEndMs(note: ChartNote): number {
  return note.type === 'hold' ? note.timeMs + Math.max(0, note.durationMs ?? 0) : note.timeMs;
}

/** Stable, non-mutating sort: by time, then lane. */
export function sortNotes(notes: readonly ChartNote[]): ChartNote[] {
  return [...notes].sort((a, b) => a.timeMs - b.timeMs || a.lane - b.lane);
}

/** Round to 1/1000 ms to keep JSON and test expectations free of floating point noise. */
export function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function isDifficulty(value: unknown): value is Difficulty {
  return value === 'easy' || value === 'normal' || value === 'hard' || value === 'expert';
}

export function millisecondsToBars(ms: number, bpm: number, beatsPerBar = 4): number {
  const beatMs = 60000 / bpm;
  return ms / (beatMs * beatsPerBar);
}
