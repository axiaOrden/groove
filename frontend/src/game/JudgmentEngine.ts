/**
 * Judgment rules and the per-note runtime state machine.
 *
 * Judgment is a pure function of the absolute timing error between an input and a note head:
 *
 *   |error| <=  45ms  PERFECT
 *   |error| <= 100ms  GOOD
 *   |error| <= 160ms  BAD
 *   otherwise         outside the window (the press is stray, or the note auto-misses later)
 *
 * Boundaries are inclusive, so exactly 45/100/160 ms are PERFECT/GOOD/BAD.
 *
 * Note lifecycle
 * --------------
 *   tap:   pending -> hit | missed
 *   hold:  pending -> holding -> completed        (head hit, held to the tail)
 *                   -> broken                   (head hit, released early)
 *                   -> interrupted              (paused mid-hold: no combo penalty, tail forfeited)
 *                   -> missed                   (head never hit)
 *
 * A note's head is judged at most once: `status` leaves `pending` exactly once, and every
 * transition is guarded, which is what makes "notes cannot be judged twice" testable.
 */

import type { ChartNote, TimingWindows } from '../chart/ChartTypes';
import { noteEndMs } from '../chart/ChartTypes';
import type { JudgmentType, ScoreRules } from './GameConfig';
import { DEFAULT_SCORE_RULES, DEFAULT_TIMING_WINDOWS } from './GameConfig';

export type NoteStatus = 'pending' | 'hit' | 'holding' | 'completed' | 'broken' | 'missed' | 'interrupted';

export interface RuntimeNote {
  readonly index: number;
  readonly lane: number;
  readonly type: ChartNote['type'];
  /** Chart time including the chart's own offset; the same value the renderer draws. */
  readonly timeMs: number;
  readonly endTimeMs: number;
  readonly durationMs: number;
  /** 1 for a tap, `holdWeight` for a hold (head + tail are each worth half). */
  readonly weight: number;
  status: NoteStatus;
  /** Judgment of the head, if it was judged at all. */
  headJudgment: JudgmentType | null;
  /** Timing error of the head judgment in ms (signed: negative = early). */
  headErrorMs: number | null;
  /**
   * Combo value the head was awarded at. A hold's tail is scored at this multiplier, so a hold is
   * worth the same however late inside its release window the player lets go (see `ScoreModel`).
   */
  headCombo: number | null;
  /** True when the head was hit AND the hold was released before its tail. */
  releasedEarly: boolean;
}

export const JUDGMENT_LABELS: Record<JudgmentType, string> = {
  perfect: 'PERFECT',
  good: 'GOOD',
  bad: 'BAD',
  miss: 'MISS',
};

export const STATUS_LABELS: Record<NoteStatus, string> = {
  pending: 'pending',
  hit: 'hit',
  holding: 'holding',
  completed: 'completed',
  broken: 'broken',
  missed: 'missed',
  interrupted: 'interrupted',
};

/** Classify a signed timing error (negative = early). */
export function classifyTiming(errorMs: number, windows: TimingWindows = DEFAULT_TIMING_WINDOWS): JudgmentType {
  const error = Math.abs(errorMs);
  if (error <= windows.perfectMs) return 'perfect';
  if (error <= windows.goodMs) return 'good';
  if (error <= windows.badMs) return 'bad';
  return 'miss';
}

/** True when a timing error is inside the widest (BAD) window, i.e. the note may be judged. */
export function isJudgeable(errorMs: number, windows: TimingWindows = DEFAULT_TIMING_WINDOWS): boolean {
  return Math.abs(errorMs) <= windows.badMs;
}

export interface CreateRuntimeNotesOptions {
  /** Per-chart offset from the beatmap (applied to note times). */
  chartOffsetMs: number;
  rules?: ScoreRules;
}

/**
 * Freeze a beatmap into runtime notes. The input note list is expected to be sorted
 * (use `prepareBeatmap`), and is not mutated.
 */
export function createRuntimeNotes(
  notes: readonly ChartNote[],
  options: CreateRuntimeNotesOptions,
): RuntimeNote[] {
  const rules = options.rules ?? DEFAULT_SCORE_RULES;
  return notes.map((note, index) => {
    const timeMs = note.timeMs + options.chartOffsetMs;
    const durationMs = note.type === 'hold' ? Math.max(0, note.durationMs ?? 0) : 0;
    return {
      index,
      lane: note.lane,
      type: note.type,
      timeMs,
      endTimeMs: timeMs + (note.type === 'hold' ? Math.max(0, note.durationMs ?? 0) : 0),
      durationMs,
      weight: note.type === 'hold' ? rules.holdWeight : rules.tapWeight,
      status: 'pending',
      headJudgment: null,
      headErrorMs: null,
      headCombo: null,
      releasedEarly: false,
    };
  });
}

export { noteEndMs };
