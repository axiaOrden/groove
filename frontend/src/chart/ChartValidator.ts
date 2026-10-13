/**
 * Beatmap validation.
 *
 * Two severities, and the distinction matters:
 *   - `error`   the chart is not safe/fair to play (out of range lane, hold overlap,
 *               duplicate note, negative time, NaN). Rejected.
 *   - `warning` the chart is playable but suspicious (very tight same-lane spacing, an
 *               implausibly dense window, an unsorted note list we sorted for you).
 *
 * `validateBeatmap` never mutates its input. `prepareBeatmap` returns a normalised copy
 * (sorted, hold durations clamped) and throws when the result contains errors. Everything
 * that consumes a chart (engine, editor, and later the API) goes through one of those two.
 */

import type { Beatmap, ChartNote } from './ChartTypes';
import {
  BEATMAP_SCHEMA_VERSION,
  LANE_COUNT,
  MIN_LANE_COUNT,
  isDifficulty,
  lanesOf,
  noteEndMs,
  roundMs,
  sortNotes,
} from './ChartTypes';

export type IssueSeverity = 'error' | 'warning';

export interface ChartIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  noteIndex?: number;
}

export interface ValidationOptions {
  /** Minimum gap between the end of one note and the start of the next in the *same lane*. */
  minSpacingMs?: number;
  /** Warn when more than this many notes fall inside any one-second window. */
  maxNotesPerSecond?: number;
  /** Skip the `schemaVersion` check (used when loading an older draft in the editor). */
  ignoreSchemaVersion?: boolean;
}

export interface ValidationResult {
  ok: boolean;
  errors: ChartIssue[];
  warnings: ChartIssue[];
}

export const DEFAULT_VALIDATION_OPTIONS: Required<ValidationOptions> = {
  minSpacingMs: 60,
  maxNotesPerSecond: 22,
  ignoreSchemaVersion: false,
};

function issue(
  severity: IssueSeverity,
  code: string,
  message: string,
  noteIndex?: number,
): ChartIssue {
  return noteIndex === undefined ? { severity, code, message } : { severity, code, message, noteIndex };
}

export function validateBeatmap(map: Beatmap, options: ValidationOptions = {}): ValidationResult {
  const opts = { ...DEFAULT_VALIDATION_OPTIONS, ...options };
  const errors: ChartIssue[] = [];
  const warnings: ChartIssue[] = [];

  if (!Number.isInteger(map.schemaVersion) || map.schemaVersion < 1) {
    errors.push(issue('error', 'schema-version', `schemaVersion must be a positive integer, got ${map.schemaVersion}`));
  } else if (!opts.ignoreSchemaVersion && map.schemaVersion > BEATMAP_SCHEMA_VERSION) {
    errors.push(
      issue(
        'error',
        'schema-version-future',
        `beatmap schemaVersion ${map.schemaVersion} is newer than this build supports (${BEATMAP_SCHEMA_VERSION})`,
      ),
    );
  }

  if (typeof map.songId !== 'string' || map.songId.trim().length === 0) {
    errors.push(issue('error', 'song-id', 'songId must be a non-empty string'));
  }
  if (typeof map.title !== 'string' || map.title.trim().length === 0) {
    errors.push(issue('error', 'title', 'title must be a non-empty string'));
  }
  if (!isDifficulty(map.difficulty)) {
    errors.push(issue('error', 'difficulty', `difficulty must be easy|normal|hard|expert, got ${String(map.difficulty)}`));
  }
  if (!Number.isFinite(map.bpm) || map.bpm <= 0) {
    errors.push(issue('error', 'bpm', `bpm must be a finite positive number, got ${map.bpm}`));
  } else if (map.bpm < 40 || map.bpm > 300) {
    warnings.push(issue('warning', 'bpm-range', `bpm ${map.bpm} is outside the typical 40-300 range`));
  }
  if (!Number.isFinite(map.offsetMs)) {
    errors.push(issue('error', 'offset', `offsetMs must be finite, got ${map.offsetMs}`));
  }
  if (!Array.isArray(map.notes) || map.notes.length === 0) {
    errors.push(issue('error', 'notes-empty', 'a beatmap needs at least one note'));
    return finish(errors, warnings);
  }
  if (!Number.isFinite(map.generator?.seed)) {
    warnings.push(issue('warning', 'generator-seed', 'generator.seed is missing or not finite'));
  }
  if (map.laneCount !== undefined) {
    if (!Number.isInteger(map.laneCount) || map.laneCount < MIN_LANE_COUNT || map.laneCount > LANE_COUNT) {
      errors.push(
        issue(
          'error',
          'lane-count',
          `laneCount must be an integer in ${MIN_LANE_COUNT}..${LANE_COUNT}, got ${String(map.laneCount)}`,
        ),
      );
    }
  }

  // Lane bounds are the chart's own lane count, so a four-lane chart cannot smuggle in a note on
  // lane 6 (which the engine would have no key for). Charts without the field are seven lanes.
  const lanes = lanesOf(map);

  let unsorted = false;
  let previousTime = -Infinity;

  map.notes.forEach((note, index) => {
    if (!Number.isFinite(note.timeMs) || note.timeMs < 0) {
      errors.push(issue('error', 'note-time', `note ${index}: timeMs must be finite and >= 0`, index));
    }
    if (!Number.isInteger(note.lane) || note.lane < 0 || note.lane >= lanes) {
      errors.push(
        issue('error', 'note-lane', `note ${index}: lane ${note.lane} is outside 0..${lanes - 1}`, index),
      );
    }
    if (note.type !== 'tap' && note.type !== 'hold') {
      errors.push(issue('error', 'note-type', `note ${index}: unknown type ${String(note.type)}`, index));
    }
    if (note.type === 'hold') {
      if (!Number.isFinite(note.durationMs) || (note.durationMs ?? 0) <= 0) {
        errors.push(issue('error', 'hold-duration', `note ${index}: hold needs durationMs > 0`, index));
      }
    } else if (note.durationMs !== undefined && note.durationMs !== 0) {
      warnings.push(issue('warning', 'tap-duration', `note ${index}: tap carries durationMs; it will be ignored`, index));
    }
    if (note.timeMs < previousTime) unsorted = true;
    previousTime = note.timeMs;
  });

  if (unsorted) {
    warnings.push(issue('warning', 'note-order', 'notes are not ordered by time; they were sorted before validation'));
  }

  // Same-lane checks operate on the sorted view so behaviour does not depend on input order.
  const sorted = sortNotes(map.notes);
  const perLane: ChartNote[][] = Array.from({ length: lanes }, () => []);
  for (const note of sorted) {
    if (!Number.isInteger(note.lane) || note.lane < 0 || note.lane >= lanes) continue;
    perLane[note.lane]!.push(note);
  }

  for (let lane = 0; lane < lanes; lane += 1) {
    const laneNotes = perLane[lane]!;
    for (let i = 1; i < laneNotes.length; i += 1) {
      const previous = laneNotes[i - 1]!;
      const current = laneNotes[i]!;
      const previousEnd = noteEndMs(previous);
      const gap = roundMs(current.timeMs - previousEnd);
      const sameStart = Math.abs(current.timeMs - previous.timeMs) < 0.001;

      if (sameStart) {
        errors.push(
          issue('error', 'duplicate-note', `lane ${lane}: two notes occupy the same instant (${current.timeMs}ms)`),
        );
      } else if (gap < -0.001) {
        errors.push(
          issue(
            'error',
            'overlapping-notes',
            `lane ${lane}: note at ${current.timeMs}ms starts ${Math.abs(gap)}ms before the previous note ends ` +
              `(${previousEnd}ms)`,
          ),
        );
      } else if (gap > 0 && gap < opts.minSpacingMs) {
        // gap === 0 with different onsets is a legal "touching" pair (e.g. a tap exactly at the
        // tail of the previous hold) and is not worth warning about: the hold release grace
        // window gives the player room to switch. Any positive gap below the minimum is flagged.
        warnings.push(
          issue(
            'warning',
            'tight-spacing',
            `lane ${lane}: only ${gap}ms between notes at ${previousEnd}ms and ${current.timeMs}ms ` +
              `(min ${opts.minSpacingMs}ms)`,
          ),
        );
      }
    }
  }

  // Density: sliding one-second window over the sorted onset list.
  const onsets = sorted.map((note) => note.timeMs).filter(Number.isFinite);
  let head = 0;
  let peak = 0;
  let peakAt = 0;
  for (let tail = 0; tail < onsets.length; tail += 1) {
    while (onsets[tail]! - onsets[head]! >= 1000) head += 1;
    const count = tail - head + 1;
    if (count > peak) {
      peak = count;
      peakAt = onsets[head]!;
    }
  }
  if (peak > opts.maxNotesPerSecond) {
    warnings.push(
      issue(
        'warning',
        'dense-section',
        `peak density ${peak} notes/s at ${peakAt}ms exceeds ${opts.maxNotesPerSecond} notes/s`,
      ),
    );
  }

  return finish(errors, warnings);
}

function finish(errors: ChartIssue[], warnings: ChartIssue[]): ValidationResult {
  return { ok: errors.length === 0, errors, warnings };
}

export class ChartValidationError extends Error {
  constructor(readonly result: ValidationResult) {
    const summary = result.errors
      .slice(0, 5)
      .map((e) => `  - [${e.code}] ${e.message}`)
      .join('\n');
    super(`beatmap rejected with ${result.errors.length} error(s):\n${summary}`);
    this.name = 'ChartValidationError';
  }
}

/**
 * Normalise a beatmap: sort notes, drop hold durations on taps, clamp durations to finite
 * positive numbers. Returns a new object; the input is untouched.
 */
export function normalizeBeatmap(map: Beatmap): Beatmap {
  const laneCount = lanesOf(map);
  const notes: ChartNote[] = map.notes
    .filter((note): note is ChartNote => typeof note === 'object' && note !== null)
    .map((note) => {
      const base: ChartNote = {
        timeMs: roundMs(Number.isFinite(note.timeMs) ? note.timeMs : 0),
        lane: note.lane,
        type: note.type === 'hold' ? 'hold' : 'tap',
      };
      if (base.type === 'hold') {
        const duration = Number(note.durationMs);
        base.durationMs = Number.isFinite(duration) && duration > 0 ? roundMs(duration) : 1;
      }
      return base;
    });

  return {
    ...map,
    laneCount,
    offsetMs: Number.isFinite(map.offsetMs) ? map.offsetMs : 0,
    notes: sortNotes(notes),
  };
}

/** Normalise then validate, throwing when the chart cannot be played. */
export function prepareBeatmap(map: Beatmap, options: ValidationOptions = {}): Beatmap {
  const normalized = normalizeBeatmap(map);
  const result = validateBeatmap(normalized, options);
  if (!result.ok) throw new ChartValidationError(result);
  return normalized;
}
