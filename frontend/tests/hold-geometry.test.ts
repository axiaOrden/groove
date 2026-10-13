/**
 * Hold-note geometry (phase 3.1).
 *
 * The bug this suite pins down: a long hold's trail did not match its note. Two causes, both
 * measurable without a GPU:
 *
 *  1. the head and tail were positioned by different expressions in different render paths, so the
 *     body could detach or jump when the head was hit;
 *  2. a hold longer than the visible road was **stretched past the spawn plane** instead of clipped
 *     (a 3 s hold at 2.5× speed is ~100 world units on a 24-unit road).
 *
 * `Layout.holdGeometry` is now the one function that produces all three pieces (head z, tail z, body
 * span), from the note's own chart timestamps through the same scroll transform, which is what makes
 * these properties testable:
 *
 *   - both ends equal `zForTimeToHit` of the note's timestamps (nothing else contributes);
 *   - the body's world length is exactly the timestamp difference under that transform;
 *   - the body always spans its two caps (connected, never detached or drifted);
 *   - every drawn z is inside the visible playfield (clipped, never stretched);
 *   - the geometry is a pure function of (times, song time, speed, anchored), so a pause and resume
 *     at the same song time produce the identical trail.
 */

import { describe, expect, it } from 'vitest';
import {
  PAST_VISIBLE_Z,
  ROAD_LENGTH,
  BASE_LEAD_MS,
  holdGeometry,
  holdLengthForDuration,
  leadMsForSpeed,
  zForTimeToHit,
} from '../src/renderer/Layout';

const HEAD_MS = 5000;
const SPEEDS = [0.5, 0.75, 1, 1.5, 2, 2.5];

function input(overrides: Partial<Parameters<typeof holdGeometry>[0]> = {}) {
  return {
    timeMs: HEAD_MS,
    endTimeMs: HEAD_MS + 1200,
    songTimeMs: HEAD_MS,
    leadMs: leadMsForSpeed(1),
    anchoredToLine: false,
    ...overrides,
  };
}

/** A hold of `durationMs` whose whole body is inside the visible window at these times. */
function fitsInWindow(durationMs: number, leadMs: number): boolean {
  return durationMs < leadMs;
}

/** What the transform says, with the playfield clip applied (the renderer's own rule). */
function clippedZ(z: number): number {
  const clamped = Math.max(-ROAD_LENGTH, Math.min(PAST_VISIBLE_Z, z));
  return clamped === 0 ? 0 : clamped;
}

describe('a hold trail is derived from its chart timestamps', () => {
  it('places the head and tail at the same transform every other note uses', () => {
    for (const speed of SPEEDS) {
      const leadMs = leadMsForSpeed(speed);
      for (const songTimeMs of [HEAD_MS - 900, HEAD_MS - 300, HEAD_MS, HEAD_MS + 200]) {
        const geometry = holdGeometry(input({ leadMs, songTimeMs }));
        expect(geometry.headZ).toBeCloseTo(clippedZ(zForTimeToHit(HEAD_MS - songTimeMs, leadMs)), 10);
        expect(geometry.tailZ).toBeCloseTo(clippedZ(zForTimeToHit(HEAD_MS + 1200 - songTimeMs, leadMs)), 10);
      }
    }
  });

  it('is exactly as long as the difference between its timestamps', () => {
    // Only speeds at which the whole hold is inside the visible window: the clip is asserted
    // separately below, and it *should* shorten a body that runs past the spawn plane.
    for (const speed of SPEEDS.filter((entry) => fitsInWindow(1200, leadMsForSpeed(entry)))) {
      const leadMs = leadMsForSpeed(speed);
      const geometry = holdGeometry(input({ leadMs, songTimeMs: HEAD_MS - 300 }));
      expect(geometry.bodyLength).toBeCloseTo(holdLengthForDuration(1200, leadMs), 10);
      // …and the same statement in *time*: the world length, mapped back through the scroll
      // transform, is the hold's duration. This is the property a stretched body breaks.
      expect((geometry.bodyLength / ROAD_LENGTH) * leadMs).toBeCloseTo(1200, 6);
    }
  });

  it('keeps the body connected to both caps', () => {
    for (const speed of SPEEDS) {
      const leadMs = leadMsForSpeed(speed);
      const geometry = holdGeometry(input({ leadMs, songTimeMs: HEAD_MS - 400, anchoredToLine: false }));
      const low = Math.min(geometry.headZ, geometry.tailZ);
      const high = Math.max(geometry.headZ, geometry.tailZ);
      expect(geometry.bodyCenterZ - geometry.bodyLength / 2).toBeCloseTo(low, 10);
      expect(geometry.bodyCenterZ + geometry.bodyLength / 2).toBeCloseTo(high, 10);
      expect(geometry.headZ - geometry.tailZ).toBeCloseTo(geometry.bodyLength, 10);
    }
  });

  it('clips a long hold at the spawn plane instead of stretching it', () => {
    // 3 s hold at 2.5× speed: unclipped, the tail would sit at z = -100 on a 24-unit road.
    const leadMs = leadMsForSpeed(2.5);
    const rawTailZ = zForTimeToHit(3000, leadMs);
    expect(rawTailZ).toBeLessThan(-ROAD_LENGTH);
    expect(holdLengthForDuration(3000, leadMs)).toBeGreaterThan(ROAD_LENGTH);

    const geometry = holdGeometry(input({ endTimeMs: HEAD_MS + 3000, leadMs, songTimeMs: HEAD_MS }));
    expect(geometry.headZ).toBe(0);
    expect(geometry.tailZ).toBe(-ROAD_LENGTH);
    expect(geometry.bodyLength).toBeLessThanOrEqual(ROAD_LENGTH);
    // The *relationship* survives the clip: the body still ends where the tail cap is drawn.
    expect(geometry.headZ - geometry.tailZ).toBeCloseTo(geometry.bodyLength, 10);
  });

  it('never draws outside the visible playfield', () => {
    for (const speed of SPEEDS) {
      const leadMs = leadMsForSpeed(speed);
      for (const durationMs of [100, 500, 1200, 3000, 8000]) {
        for (const offsetMs of [-200, 0, 400, 1500, 4000]) {
          for (const anchoredToLine of [false, true]) {
            const geometry = holdGeometry(
              input({ endTimeMs: HEAD_MS + durationMs, leadMs, songTimeMs: HEAD_MS + offsetMs, anchoredToLine }),
            );
            for (const z of [geometry.headZ, geometry.tailZ, geometry.bodyCenterZ]) {
              expect(z).toBeGreaterThanOrEqual(-ROAD_LENGTH - 1e-9);
              expect(z).toBeLessThanOrEqual(PAST_VISIBLE_Z + 1e-9);
            }
            expect(geometry.bodyLength).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });
});

describe('holding a note', () => {
  it('anchors the remaining body at the hit line and collapses as the tail arrives', () => {
    const leadMs = leadMsForSpeed(1);
    const atHead = holdGeometry(input({ leadMs, songTimeMs: HEAD_MS, anchoredToLine: true }));
    expect(atHead.headZ).toBe(0);
    expect(atHead.tailZ).toBe(zForTimeToHit(1200, leadMs));

    const midway = holdGeometry(input({ leadMs, songTimeMs: HEAD_MS + 600, anchoredToLine: true }));
    expect(midway.headZ).toBe(0);
    expect(midway.bodyLength).toBeCloseTo(atHead.bodyLength / 2, 6);

    // The tail has passed (the engine completes within its 100 ms grace): nothing left to draw.
    const past = holdGeometry(input({ leadMs, songTimeMs: HEAD_MS + 1400, anchoredToLine: true }));
    expect(past.headZ).toBe(0);
    expect(past.tailZ).toBe(0);
    expect(past.bodyLength).toBe(0);
  });

  it('does not jump when the head is hit', () => {
    // The falling trail and the holding trail agree at the instant of the hit, which is what keeps
    // the body from shifting the frame the key goes down.
    const leadMs = leadMsForSpeed(1);
    const falling = holdGeometry(input({ leadMs, songTimeMs: HEAD_MS, anchoredToLine: false }));
    const holding = holdGeometry(input({ leadMs, songTimeMs: HEAD_MS, anchoredToLine: true }));
    expect(holding.headZ).toBe(falling.headZ);
    expect(holding.tailZ).toBe(falling.tailZ);
    expect(holding.bodyLength).toBe(falling.bodyLength);
  });

  it('is a pure function of the clock, so pause and resume cannot drift it', () => {
    const leadMs = leadMsForSpeed(1);
    const before = holdGeometry(input({ leadMs, songTimeMs: HEAD_MS - 400 }));
    // "Pause": the clock stops. "Resume at a count-in": the clock is still at that value.
    const afterPause = holdGeometry(input({ leadMs, songTimeMs: HEAD_MS - 400 }));
    expect(afterPause).toEqual(before);
    // Time advances by 150 ms: the head moves exactly 150 ms of world distance, the length is
    // unchanged (nothing accumulates, nothing drifts).
    const later = holdGeometry(input({ leadMs, songTimeMs: HEAD_MS - 250 }));
    expect(later.bodyLength).toBeCloseTo(before.bodyLength, 10);
    expect(later.headZ - before.headZ).toBeCloseTo((150 / leadMs) * ROAD_LENGTH, 10);
  });

  it('depends on nothing but time and the scroll transform', () => {
    // Same two objects for any lane: a four-lane chart and a seven-lane one draw a hold of the same
    // length, so a lane count change cannot stretch a trail.
    const geometry = holdGeometry(input({ leadMs: BASE_LEAD_MS, songTimeMs: HEAD_MS - 200 }));
    expect(holdGeometry(input({ leadMs: BASE_LEAD_MS, songTimeMs: HEAD_MS - 200 }))).toEqual(geometry);
  });
});
