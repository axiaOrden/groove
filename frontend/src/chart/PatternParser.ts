/**
 * Hand-authoring notation for beatmap bars.
 *
 * A bar is written as a whitespace-separated list of steps. The number of steps decides the
 * grid resolution, so a bar can be authored as quarters (4 steps), eighths (8) or
 * sixteenths (16):
 *
 *   "."            empty step
 *   "3"            a tap in lane 3 at this step
 *   "3~4"          a hold in lane 3 whose length is 4 steps
 *   "0+3"          a chord: lanes 0 and 3 at the same step ("0~8+3" mixes a hold and a tap)
 *
 *   parseBarPattern({ pattern: '0 . 2 . 4~2 . . .', barStartMs: 0, barDurationMs: 1600 })
 *
 * Pattern strings are *authored content* (checked in, hand written, unit tested). They are
 * not a parser for untrusted input: beatmaps arriving from JSON/IndexedDB/API are validated
 * with `validateBeatmap` instead, which never assumes a well-formed grid.
 */

import type { ChartNote } from './ChartTypes';
import { roundMs } from './ChartTypes';

/** lane, optionally followed by "~<steps>" for a hold. */
const LANE_TOKEN = /^([0-9])(?:~([0-9]+))?$/;

export class ChartParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChartParseError';
  }
}

export interface ParseBarOptions {
  pattern: string;
  /** Chart time of step 0 of this bar, in ms. */
  barStartMs: number;
  /** Total length of the bar in ms (may be fractional for odd tempos). */
  barDurationMs: number;
}

/** Number of grid steps declared by a pattern (used by tests and authoring assertions). */
export function countSteps(pattern: string): number {
  return pattern.trim().split(/\s+/).filter((token) => token.length > 0).length;
}

export class ChartPatternError extends Error {
  constructor(
    message: string,
    readonly barIndex: number,
  ) {
    super(message);
    this.name = 'ChartPatternError';
  }
}

/** Parse one authored bar into explicit chart notes (sorted by step, then lane). */
export function parseBarPattern(options: ParseBarOptions): ChartNote[] {
  const tokens = options.pattern.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    throw new ChartParseError('bar pattern is empty');
  }
  const stepMs = options.barDurationMs / tokens.length;
  const notes: ChartNote[] = [];

  for (let step = 0; step < tokens.length; step += 1) {
    const token = tokens[step]!;
    if (token === '.') continue;

    for (const part of token.split('+')) {
      const match = LANE_TOKEN.exec(part);
      if (!match) {
        throw new ChartParseError(
          `invalid step token "${token}" at step ${step + 1}/${tokens.length} ` +
            `(expected ".", "<lane>", "<lane>~<steps>" or a "+" chord of those)`,
        );
      }
      const lane = Number(match[1]);
      const holdSteps = match[2] === undefined ? 0 : Number(match[2]);
      const timeMs = roundMs(options.barStartMs + step * stepMs);

      if (holdSteps > 0) {
        notes.push({ timeMs, lane, type: 'hold', durationMs: roundMs(holdSteps * stepMs) });
      } else {
        notes.push({ timeMs, lane, type: 'tap' });
      }
    }
  }

  return notes.sort((a, b) => a.timeMs - b.timeMs || a.lane - b.lane);
}

/** Assert that every bar of an authored section declares the same number of steps. */
export function assertUniformStepCount(patterns: readonly string[], expectedSteps: number, barOffset: number): void {
  patterns.forEach((pattern, index) => {
    const steps = countSteps(pattern);
    if (steps !== expectedSteps) {
      throw new ChartPatternError(
        `bar ${barOffset + index} declares ${steps} steps but the section grid expects ${expectedSteps} ` +
          `(keep hand-authored bars aligned to the same subdivision): "${pattern}"`,
        barOffset + index,
      );
    }
  });
}
