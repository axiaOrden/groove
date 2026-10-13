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
 * Phase 3 made the highway **lane-count agnostic**: the road is `laneCount` lanes wide, lane 0 is
 * the left edge and the centre lane sits at `x = 0` whatever the count. `LANE_COUNT` (7) stays the
 * default and the maximum, so every pre-phase-3 caller and test keeps its seven-lane geometry
 * verbatim; a four- or five-lane chart simply gets a narrower, evenly spaced road.
 *
 * This module contains no three.js import on purpose: the mapping is unit tested in Node.
 */

import { keyLabelsFor } from '../chart/Difficulty';

/** Lanes on the default (hard) highway. Also the maximum: the schema allows no more. */
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

/** Road width for a lane count (the default is `ROAD_WIDTH`). */
export function roadWidthFor(laneCount: number = LANE_COUNT): number {
  return laneCount * LANE_PITCH + 0.5;
}

/*
 * --------------------------------------------------------------------------------- lane palette --
 *
 * Phase 3.1 replaced the seven-colour per-key palette with **three colours**, and the whole of that
 * design lives here — one place, so a lane's note caps, hold head, hold body, receptor, background
 * strip and keyboard/touch indicator cannot disagree about what colour it is.
 *
 * The pattern is per *lane index* and differs by difficulty, because a lane's role in the layout
 * differs (the brief fixes each one exactly):
 *
 *     Hard    7 keys   A S D SPACE J K L   1 2 1 O 1 2 1
 *     Normal  5 keys   A S SPACE K L       1 2 O 2 1
 *     Easy    4 keys   A S K L             1 2 1 2
 *
 * Note what that implies: K is colour 1 on Easy (it is the fourth lane, the "melody" side of the
 * layout) but colour 2 on Hard (where it is the inner right-hand lane). Lane roles come from the
 * layout, not from the key name — which is why the table is indexed by lane, not by label.
 */

/** Which of a palette's three colours a lane uses. */
export type LaneColorRole = 'primary' | 'secondary' | 'space';

/**
 * A lane palette: colour 1, colour 2, and the SPACE colour.
 *
 * Only three values exist because that is the whole visual language: the outer lanes, the inner
 * lanes, and the one key that means "the beat". Both palettes keep SPACE orange, so "the orange lane
 * is the beat" survives the player switching theme.
 */
export interface LanePalette {
  id: string;
  /** Label for the settings control. */
  name: string;
  /** Colour 1 — the outer lanes (A, D, J, L; and A/K on Easy). */
  primary: number;
  /** Colour 2 — the inner lanes (S, K; and S/L on Easy). */
  secondary: number;
  /** The SPACE lane. */
  space: number;
}

export const LANE_PALETTES: readonly LanePalette[] = [
  { id: 'ice', name: 'White · Blue · Orange', primary: 0xf1f5f9, secondary: 0x3b82f6, space: 0xf59e0b },
  { id: 'signal', name: 'Green · Red · Orange', primary: 0x34d399, secondary: 0xef4444, space: 0xf59e0b },
];

export const DEFAULT_LANE_PALETTE_ID = 'ice';

/** Lane roles for the layouts this game renders, in lane order. */
const LANE_COLOR_ROLES: Readonly<Record<number, readonly LaneColorRole[]>> = {
  7: ['primary', 'secondary', 'primary', 'space', 'primary', 'secondary', 'primary'],
  5: ['primary', 'secondary', 'space', 'secondary', 'primary'],
  4: ['primary', 'secondary', 'primary', 'secondary'],
};

let activePaletteId = DEFAULT_LANE_PALETTE_ID;

export function isLanePaletteId(value: unknown): value is string {
  return typeof value === 'string' && LANE_PALETTES.some((palette) => palette.id === value);
}

export function lanePalette(id: string = activePaletteId): LanePalette {
  return LANE_PALETTES.find((palette) => palette.id === id) ?? LANE_PALETTES[0]!;
}

/** Which palette the renderers and the UI use. Unknown ids fall back to the default. */
export function setActiveLanePalette(id: string): LanePalette {
  activePaletteId = isLanePaletteId(id) ? id : DEFAULT_LANE_PALETTE_ID;
  return lanePalette(activePaletteId);
}

export function activeLanePalette(): LanePalette {
  return lanePalette(activePaletteId);
}

/** The three colours of a palette, in the order a lane role indexes them. */
export function lanePaletteColors(palette: LanePalette = activeLanePalette()): Record<LaneColorRole, number> {
  return { primary: palette.primary, secondary: palette.secondary, space: palette.space };
}

/**
 * Lane roles for a lane count. Four, five and seven lanes use the fixed patterns above; any other
 * count is derived symmetrically (colour 1 outside, colour 2 inside, SPACE in the middle when the
 * count is odd), so a hand-edited chart still renders with three colours.
 */
export function laneColorRoles(laneCount: number = LANE_COUNT): LaneColorRole[] {
  const fixed = LANE_COLOR_ROLES[laneCount];
  if (fixed) return [...fixed];
  const count = Math.max(1, Math.round(laneCount) || LANE_COUNT);
  return Array.from({ length: count }, (_, lane) => {
    if (count % 2 === 1 && lane === (count - 1) / 2) return 'space';
    return lane % 2 === 0 ? 'primary' : 'secondary';
  });
}

/** Lane colours for a lane count, in lane order, from a palette (the active one by default). */
export function laneColorsFor(
  laneCount: number = LANE_COUNT,
  palette: LanePalette = activeLanePalette(),
): number[] {
  const colors = lanePaletteColors(palette);
  return laneColorRoles(laneCount).map((role) => colors[role]);
}

/**
 * Lane colour roles for a chart's key labels (diagnostics and the tests): the same patterns as
 * `laneColorRoles`, expressed on the keys the player actually presses.
 */
export function laneColorRoleLabels(laneCount: number = LANE_COUNT): { label: string; role: LaneColorRole }[] {
  const labels = keyLabelsFor(laneCount);
  return laneColorRoles(laneCount).map((role, lane) => ({ label: labels[lane] ?? String(lane + 1), role }));
}

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

/** World x of a lane centre (the centre lane is at 0, for any lane count). */
export function laneToX(lane: number, laneCount: number = LANE_COUNT): number {
  return (lane - (laneCount - 1) / 2) * LANE_PITCH;
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

/**
 * Geometry of a hold note, as the renderer draws it.
 *
 * One function for both of a hold's visual states, because "the head and the tail must use the same
 * authoritative clock and the same scroll transformation" (phase 3.1) is exactly the property that
 * having two code paths loses:
 *
 *   - **falling** (`anchoredToLine: false`): the head cap is at the head's own z, the tail cap at
 *     the tail's, and the body spans the two.
 *   - **holding** (`anchoredToLine: true`): the head has been consumed, so the remaining body runs
 *     from the hit line (`z = 0`) to the tail.
 *
 * Both endpoints come from `zForTimeToHit` on the note's *own* chart timestamps, and both are
 * clamped to the visible playfield (`[-ROAD_LENGTH, PAST_VISIBLE_Z]`) so a long hold is **clipped at
 * the spawn plane instead of stretched past it** — a 3-second hold at 2.5× speed would otherwise be
 * a body ~100 world units long on a 24-unit road, which is the "inaccurate trail" the fix targets.
 *
 * The returned length is measured between the two clamped endpoints, so the body always ends exactly
 * where the two caps are drawn (nothing detaches, stretches or drifts), at any speed and lane count.
 */
export interface HoldGeometry {
  /** z of the head cap. */
  headZ: number;
  /** z of the tail cap. */
  tailZ: number;
  /** World length of the body: `|tailZ - headZ|`. */
  bodyLength: number;
  /** z of the body's centre. */
  bodyCenterZ: number;
  /** False when the whole hold is outside the visible strip (nothing to draw). */
  visible: boolean;
}

export interface HoldGeometryInput {
  /** Chart time of the head, in ms (already includes the chart offset). */
  timeMs: number;
  /** Chart time of the tail, in ms. */
  endTimeMs: number;
  /** Current song time, in ms. */
  songTimeMs: number;
  /** Visual lead time for the current speed setting. */
  leadMs: number;
  /** True when the head has been hit: the body is then anchored at the hit line. */
  anchoredToLine: boolean;
  roadLength?: number;
}

export function holdGeometry(input: HoldGeometryInput): HoldGeometry {
  const roadLength = input.roadLength ?? ROAD_LENGTH;
  const rawHeadZ = input.anchoredToLine ? 0 : zForTimeToHit(input.timeMs - input.songTimeMs, input.leadMs, roadLength);
  const rawTailZ = zForTimeToHit(input.endTimeMs - input.songTimeMs, input.leadMs, roadLength);
  const headZ = clampZ(rawHeadZ, roadLength);
  // The tail is never in front of the head: once the tail's time has passed while the player still
  // holds, the body collapses to the hit line rather than flipping to the near side of it.
  const tailZ = input.anchoredToLine ? Math.min(clampZ(rawTailZ, roadLength), headZ) : clampZ(rawTailZ, roadLength);
  const bodyLength = Math.abs(tailZ - headZ);
  return {
    headZ,
    tailZ,
    bodyLength,
    bodyCenterZ: (headZ + tailZ) / 2,
    // A hold with no visible length yet (or whose whole body is past the camera) draws nothing.
    visible: Math.max(headZ, tailZ) > -roadLength && Math.min(headZ, tailZ) < PAST_VISIBLE_Z,
  };
}

/** Keep a z inside the visible playfield: the spawn plane behind, the past-visible strip in front. */
function clampZ(z: number, roadLength: number): number {
  if (!Number.isFinite(z)) return 0;
  const clamped = Math.min(PAST_VISIBLE_Z, Math.max(-roadLength, z));
  // Normalise `-0` (which `zForTimeToHit(0, …)` produces) to `0`: the two are the same position,
  // and comparing geometry objects should not turn on the sign of zero.
  return clamped === 0 ? 0 : clamped;
}
