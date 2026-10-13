/**
 * Highway layout: the single place that maps *time* to *world space*.
 *
 * A note's z position is a linear function of how long until it must be hit:
 *
 *     z(timeToHitMs) = -(timeToHitMs / leadMs) * ROAD_LENGTH
 *
 * so `z = 0` is the hit line for every note, whatever the scroll speed, and the mapping is
 * stateless — nothing accumulates, so frame rate cannot shift a note.
 *
 * This module contains no three.js import on purpose: the mapping is unit tested in Node.
 */

export const LANE_COUNT = 7;

/** Distance between lane centres. */
export const LANE_WIDTH = 1.4;
export const LANE_PITCH = LANE_WIDTH + 0.06;

/** World length of the visible highway, from the hit line (z = 0) to the spawn plane. */
export const ROAD_LENGTH = 24;

/** Duration (ms) a note is visible at speed 1.0. Higher speed => shorter lead. */
export const BASE_LEAD_MS = 1800;

export const NOTE_SPEED_MIN = 0.5;
export const NOTE_SPEED_MAX = 2.5;

/**
 * How long a resolved (missed) note stays on screen after its time, so the miss is seen
 * crossing the hit line. Kept short because a note past the hit line is much closer to the
 * camera and therefore drawn much larger.
 */
export const PAST_VISIBLE_MS = 200;

/** Hard limit on how far past the hit line a note may be drawn (world units). */
export const PAST_VISIBLE_Z = 2.2;

export const ROAD_WIDTH = LANE_COUNT * LANE_PITCH + 0.5;

/** Lane colours (lane 3, SPACE, is intentionally near-white and reads as "centre"). */
export const LANE_COLORS: readonly number[] = [
  0x22d3ee, 0x34d399, 0xa3e635, 0xf8fafc, 0xfbbf24, 0xfb7185, 0xa78bfa,
];

export const JUDGMENT_COLORS: Readonly<Record<string, number>> = {
  perfect: 0x7dd3fc,
  good: 0x4ade80,
  bad: 0xfbbf24,
  miss: 0xf87171,
  hold: 0x22d3ee,
  stray: 0x94a3b8,
};

export const CAMERA_FOV = 52;
export const CAMERA_NEAR = 0.1;
export const CAMERA_FAR = 220;
export const CAMERA_POSITION = { x: 0, y: 7, z: 9 } as const;
export const CAMERA_TARGET = { x: 0, y: 0, z: -10 } as const;

export const FOG_COLOR = 0x070b14;
export const FOG_NEAR = 16;
export const FOG_FAR = 58;

/** World x of a lane centre (lane 3 is at 0). */
export function laneToX(lane: number): number {
  return (lane - (LANE_COUNT - 1) / 2) * LANE_PITCH;
}

/** Clamp a user speed setting into the supported range. */
export function clampNoteSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1;
  return Math.min(NOTE_SPEED_MAX, Math.max(NOTE_SPEED_MIN, speed));
}

/** Visual lead time for a note-speed setting. */
export function leadMsForSpeed(speed: number): number {
  return BASE_LEAD_MS / clampNoteSpeed(speed);
}

/** World z for a note that must be hit in `timeToHitMs`. */
export function zForTimeToHit(timeToHitMs: number, leadMs: number, roadLength = ROAD_LENGTH): number {
  const safeLead = leadMs > 0 ? leadMs : BASE_LEAD_MS;
  return -(timeToHitMs / safeLead) * roadLength;
}

/** Inverse of `zForTimeToHit`, used by the phase 4 editor and by tests. */
export function timeToHitForZ(z: number, leadMs: number, roadLength = ROAD_LENGTH): number {
  const safeLead = leadMs > 0 ? leadMs : BASE_LEAD_MS;
  return (-z / roadLength) * safeLead;
}

/** Length in world units of a hold body of `durationMs`. */
export function holdLengthForDuration(durationMs: number, leadMs: number, roadLength = ROAD_LENGTH): number {
  return Math.abs(zForTimeToHit(durationMs, leadMs, roadLength));
}
