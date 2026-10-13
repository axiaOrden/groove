/**
 * CameraFraming — where the seven lanes sit on screen, on any viewport.
 *
 * Phase 1 used one fixed camera and let the highway occupy whatever fraction of a desktop
 * window it happened to occupy. That does not survive a phone in landscape: at 2.2:1 the same
 * camera leaves the road in the middle ~43% of a wide, short viewport, so each lane would get
 * a ~50 px touch target and the DOM touch columns could not line up with the 3D lanes.
 *
 * So the mobile camera is *solved* from the layout requirements instead of being hard-coded:
 *
 *   hard A — the seven lane columns span `LANE_SPREAD` of the usable width. This is what makes
 *            the touch targets large, and because the DOM touch zones are derived from the
 *            same projection it is also what makes them line up with the 3D lanes.
 *   hard B — the hit line sits at `HIT_LINE_FRACTION` of the usable height (thumb reach, and
 *            it keeps the notes in the upper part of the screen where they can be read).
 *   soft C — notes should be visible for as long as possible before their hit time, up to the
 *            full phase 1 lead: aim to place the spawn plane at the top of the usable area.
 *   limit D — the vertical field of view must stay legible (`FOV_MIN`..`FOV_MAX`) and the
 *            camera must not run off to infinity (`MOBILE_DISTANCE_*`). D wins over C, never
 *            over A or B.
 *
 * Geometry family
 * ---------------
 * Every camera in this game is `position (cx, h, u)` looking at `(cx, 0, -k)`; the desktop
 * camera `(0, 7, 9) -> (0, 0, -10)` is exactly `h = 7, u = 9, k = 10`. All seven lanes live at
 * `y = 0` and the camera has no roll, so for a road point `(x, 0, z)`:
 *
 *     L      = hypot(h, k + u)
 *     depth  = (h^2 - (z - u)(k + u)) / L
 *     yView  = -h (k + z) / L                          (up-positive, camera space)
 *     f      = (viewportHeight / 2) / tan(fov / 2)     (focal length in px)
 *     screenY(z) = H/2 - f * yView / depth
 *     screenX(x) = W/2 + f * (x - cx) / depthHit       (all lanes share depthHit at z = 0)
 *
 * Substituting gives `screenY(0) = H/2 + f h k / (h^2 + u(k+u))` and a lane spacing of
 * `LANE_PITCH f / depthHit`. Requiring A turns into `f / depthHit = S` for a known `S`, and
 * keeping the desktop view steepness `q = h / (k+u)` then makes both A and B *exact* for a
 * single fixed `k`:
 *
 *     k = deltaY * hypot(1, 1/q) / S      (deltaY = hit line offset below the viewport centre)
 *     h = q (u + k)                       (so the camera distance u is the only parameter)
 *
 * Everything else — focal length, fov, the read time, the depth to the hit line — follows from
 * `u` alone, and `u` is chosen by a bisection on soft C. The whole module imports no three.js
 * and touches no DOM; the tests cross-check its projection against three.js's own.
 */

import {
  BASE_LEAD_MS,
  CAMERA_FOV,
  CAMERA_POSITION,
  CAMERA_TARGET,
  LANE_COUNT,
  LANE_PITCH,
  ROAD_LENGTH,
  laneToX,
} from './Layout';

export interface SafeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface FramingInput {
  viewportWidth: number;
  viewportHeight: number;
  insets?: Partial<SafeInsets>;
  /** True when the coarse-pointer (touch) layout is active. */
  touchLayout: boolean;
}

export interface CameraPose {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  /** Vertical field of view in degrees, i.e. three.js's `PerspectiveCamera.fov`. */
  fov: number;
}

export type FramingMode =
  /** The phase 1 desktop camera, unchanged. */
  | 'desktop'
  /** Solved mobile camera that meets both hard requirements and the read-time aim. */
  | 'mobile'
  /** Solved mobile camera where a limit (fov or distance) had to be applied. */
  | 'mobile-clamped';

export interface Framing {
  mode: FramingMode;
  camera: CameraPose;
  /** Usable viewport rectangle (viewport minus display cutouts), in CSS px. */
  usable: { left: number; top: number; width: number; height: number };
  /** Projected lane centres at the hit line, in viewport px, lanes 0..6. */
  laneCentersPx: number[];
  /** Projected width of one lane column at the hit line, in px. */
  laneWidthPx: number;
  /** Projected y of the hit line, in viewport px from the top. */
  hitLineYPx: number;
  /**
   * How long (ms) a note is on screen before its hit time at speed 1.0, never above
   * BASE_LEAD_MS. The renderer caps its visual lead to this, so a note that is already past
   * the top edge is not submitted to the GPU at all.
   */
  visibleLeadMs: number;
  /** Camera distance to the hit line, in world units (fog tuning and debugging). */
  hitLineDepth: number;
  /** True when a limit in D had to be applied, i.e. a soft target is not met exactly. */
  clamped: boolean;
}

/** Fraction of the usable width taken by the seven lane columns. */
export const LANE_SPREAD = 0.9;
/** Hit line position as a fraction of the usable height. */
export const HIT_LINE_FRACTION = 0.82;
/** Below this read time the layout counts as clamped (documented expectation, not a target). */
export const MIN_COMFORTABLE_LEAD_MS = 1100;
/** Camera distance range, in world units. */
export const MOBILE_DISTANCE_MIN = 4;
export const MOBILE_DISTANCE_MAX = 24;
export const FOV_MIN = 10;
export const FOV_MAX = 80;
/** Smallest playable viewport we will try to frame. */
const MIN_VIEWPORT_PX = 96;

/** Desktop view steepness: how far the view axis drops per unit travelled along it. */
export const VIEW_STEEPNESS = CAMERA_POSITION.y / (CAMERA_POSITION.z - CAMERA_TARGET.z);

const BISECTION_ITERATIONS = 64;

/** Desktop pose, i.e. the phase 1 camera. */
export function desktopPose(): CameraPose {
  return {
    position: { x: CAMERA_POSITION.x, y: CAMERA_POSITION.y, z: CAMERA_POSITION.z },
    target: { x: CAMERA_TARGET.x, y: CAMERA_TARGET.y, z: CAMERA_TARGET.z },
    fov: CAMERA_FOV,
  };
}

// -------------------------------------------------------------- screen mapping --

export interface PoseMetrics {
  /** Depth from the camera to the hit line (world z = 0). */
  depthHit: number;
  /** Focal length in px. */
  focalPx: number;
  /** Projected width of one lane column at the hit line, in px. */
  laneWidthPx: number;
  /** Projected lane centres at the hit line, in px from the left. */
  laneCentersPx: number[];
  /** Projected y of the hit line, in px from the top. */
  hitLineYPx: number;
  /** Projected y of an arbitrary road point (`y = 0`), in px from the top. */
  screenYForZ(z: number): number;
}

/**
 * Screen-space projection of one camera pose. Shared by `computeFraming`, the touch layer and
 * the tests, which check it against three.js's projection matrix.
 */
export function poseMetrics(pose: CameraPose, viewportWidth: number, viewportHeight: number): PoseMetrics {
  const h = pose.position.y;
  const u = pose.position.z;
  const camX = pose.position.x;
  const k = -pose.target.z;
  const axis = k + u;
  const axisLength = Math.hypot(h, axis);
  const focalPx = viewportHeight / 2 / Math.tan((pose.fov * Math.PI) / 360);
  const depthFor = (z: number): number => (h * h - (z - u) * axis) / axisLength;
  const depthHit = depthFor(0);

  const screenYForZ = (z: number): number => {
    const depth = depthFor(z);
    if (depth <= 0) return Number.NEGATIVE_INFINITY;
    return viewportHeight / 2 + (focalPx * h * (k + z)) / (axisLength * depth);
  };

  const laneCentersPx: number[] = [];
  for (let lane = 0; lane < LANE_COUNT; lane += 1) {
    laneCentersPx.push(viewportWidth / 2 + (focalPx * (laneToX(lane) - camX)) / depthHit);
  }

  return {
    depthHit,
    focalPx,
    laneWidthPx: (LANE_PITCH * focalPx) / depthHit,
    laneCentersPx,
    hitLineYPx: screenYForZ(0),
    screenYForZ,
  };
}

/**
 * Read time (ms) between the top edge `topPx` and the hit line, capped at BASE_LEAD_MS. When
 * no road point is that high on screen the whole road is visible and the cap applies; that is
 * the desktop case, where the road disappears into fog well before the top of the window.
 */
export function visibleLeadMs(pose: CameraPose, viewportWidth: number, viewportHeight: number, topPx: number): number {
  const metrics = poseMetrics(pose, viewportWidth, viewportHeight);
  // screenY grows downwards, so a far end at or below `topPx` means every road point is on
  // screen from the moment it spawns: the full phase 1 lead applies.
  if (metrics.screenYForZ(-ROAD_LENGTH) >= topPx) return BASE_LEAD_MS;
  if (metrics.hitLineYPx < topPx) return 0; // degenerate: the hit line is off the top

  // screenY is monotone increasing in z, so bisect the road for the point sitting at `topPx`.
  let lo = -ROAD_LENGTH;
  let hi = 0;
  for (let i = 0; i < BISECTION_ITERATIONS; i += 1) {
    const mid = (lo + hi) / 2;
    if (metrics.screenYForZ(mid) > topPx) hi = mid;
    else lo = mid;
  }
  return (BASE_LEAD_MS * -(lo + hi)) / (2 * ROAD_LENGTH);
}

// ------------------------------------------------------------------- solving ---

/** Usable rectangle from the viewport and the display cutout insets. */
export function usableRect(viewportWidth: number, viewportHeight: number, insets: SafeInsets): Framing['usable'] {
  const left = clamp(insets.left, 0, Math.max(0, viewportWidth - MIN_VIEWPORT_PX));
  const right = clamp(insets.right, 0, Math.max(0, viewportWidth - MIN_VIEWPORT_PX - left));
  const top = clamp(insets.top, 0, Math.max(0, viewportHeight - MIN_VIEWPORT_PX));
  const bottom = clamp(insets.bottom, 0, Math.max(0, viewportHeight - MIN_VIEWPORT_PX - top));
  return {
    left,
    top,
    width: Math.max(MIN_VIEWPORT_PX, viewportWidth - left - right),
    height: Math.max(MIN_VIEWPORT_PX, viewportHeight - top - bottom),
  };
}

/** Everything the solved camera family needs, derived once per viewport. */
interface MobileGeometry {
  width: number;
  height: number;
  usable: Framing['usable'];
  /** `f / depthHit`, i.e. px of lane spacing per world unit of depth (hard A). */
  spread: number;
  /** Fixed `k`, from hard A and hard B with the desktop view steepness. */
  k: number;
  /** `hypot(1, 1/q)`: `L = h * axisScale`. */
  axisScale: number;
}

function mobileGeometry(width: number, height: number, usable: Framing['usable']): MobileGeometry {
  const q = VIEW_STEEPNESS;
  const axisScale = Math.hypot(1, 1 / q);
  const spread = (LANE_SPREAD * usable.width) / (LANE_COUNT * LANE_PITCH);
  const deltaY = usable.top + HIT_LINE_FRACTION * usable.height - height / 2;
  // screenY(0) = H/2 + S h k / L with L = h axisScale  =>  k = deltaY axisScale / S, and hard B
  // then holds exactly for every camera distance, which is what makes the hit line stable
  // while the read time is tuned.
  return { width, height, usable, spread, k: (deltaY * axisScale) / spread, axisScale };
}

/** Pose of the solved camera family for one candidate distance. */
function poseAtDistance(u: number, geometry: MobileGeometry): CameraPose {
  const { width, height, usable, spread, k, axisScale } = geometry;
  const h = VIEW_STEEPNESS * (u + k);
  const axis = k + u; // = h / VIEW_STEEPNESS
  const depthHit = (h * h + u * axis) / (h * axisScale);
  const focalPx = spread * depthHit;
  // Sideways offset so the road centre lands on the centre of the usable rectangle: relevant
  // in landscape, where a camera cutout eats one side of the screen. Moving the camera the
  // other way moves the road towards the +x side of the screen, hence the sign.
  const camX = (-(usable.left + usable.width / 2 - width / 2) * depthHit) / focalPx;
  return {
    position: { x: camX, y: h, z: u },
    target: { x: camX, y: 0, z: -k },
    fov: (2 * Math.atan(height / 2 / focalPx) * 180) / Math.PI,
  };
}

/**
 * Narrow the distance range so the fov stays legible. The fov is monotonically decreasing in
 * `u`, so the two limits are found by bisection. Returns the interval and whether it binds.
 */
function legibleDistanceRange(geometry: MobileGeometry): { min: number; max: number; clamped: boolean } {
  const fovAt = (u: number): number => poseAtDistance(u, geometry).fov;
  let min = MOBILE_DISTANCE_MIN;
  let max = MOBILE_DISTANCE_MAX;
  let clamped = false;

  if (fovAt(min) > FOV_MAX) {
    // Even the closest allowed camera is wider than we allow: move back to fov = FOV_MAX.
    min = bisectTransition((u) => fovAt(u) <= FOV_MAX, min, max, true);
    clamped = true;
  }
  if (fovAt(max) < FOV_MIN) {
    // Even the farthest camera is a telephoto: come closer to fov = FOV_MIN.
    max = bisectTransition((u) => fovAt(u) >= FOV_MIN, min, max, false);
    clamped = true;
  }
  if (max < min) {
    // The legible window is empty (absurd viewport): take the middle of the allowed range.
    const middle = (MOBILE_DISTANCE_MIN + MOBILE_DISTANCE_MAX) / 2;
    return { min: middle, max: middle, clamped: true };
  }
  return { min, max, clamped };
}

/**
 * Solve the mobile camera. Hard A and hard B are exact for every candidate; `u` is chosen so
 * that the spawn plane sits as close as possible to the top of the usable area (soft C),
 * inside the legible distance window (limit D).
 */
function solveMobilePose(width: number, height: number, usable: Framing['usable']): { pose: CameraPose; clamped: boolean } {
  const geometry = mobileGeometry(width, height, usable);
  const range = legibleDistanceRange(geometry);

  const distanceForSpawnAtTop = (u: number): number =>
    poseMetrics(poseAtDistance(u, geometry), width, height).screenYForZ(-ROAD_LENGTH) - usable.top;

  // `spawnOvershoot` is > 0 while the spawn plane is still below the top edge and < 0 once it
  // is above it, and it decreases as the camera moves back. The aim is the *closest* camera
  // that just shows the whole road: further back only narrows the fov and wastes geometry.
  let distance = range.min;
  let clamped = range.clamped;
  const atMin = distanceForSpawnAtTop(range.min);
  const atMax = distanceForSpawnAtTop(range.max);
  if (atMin <= 0) {
    distance = range.min; // the whole road already fits from the closest camera
  } else if (atMax >= 0) {
    distance = range.max; // never far enough back: the longest available read time
    clamped = true;
  } else {
    let lo = range.min;
    let hi = range.max;
    for (let i = 0; i < BISECTION_ITERATIONS; i += 1) {
      const mid = (lo + hi) / 2;
      if (distanceForSpawnAtTop(mid) > 0) lo = mid;
      else hi = mid;
    }
    distance = (lo + hi) / 2;
  }

  return { pose: poseAtDistance(distance, geometry), clamped };
}

/**
 * Find where a monotone predicate flips inside [min, max]. `trueAbove` says whether the
 * predicate holds for the larger values: if it does, the result is the smallest `u` that
 * satisfies it, otherwise the largest.
 */
function bisectTransition(
  predicate: (u: number) => boolean,
  min: number,
  max: number,
  trueAbove: boolean,
): number {
  let lo = min;
  let hi = max;
  for (let i = 0; i < BISECTION_ITERATIONS; i += 1) {
    const mid = (lo + hi) / 2;
    // When the predicate holds where we expect it to, the transition is at or below `mid`.
    const holds = predicate(mid);
    if (holds === trueAbove) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

// -------------------------------------------------------------- public entry ---

/**
 * Compute the camera pose and the derived screen layout for a viewport. Deterministic and
 * cheap: it runs on resize and on device-profile changes, never per frame.
 */
export function computeFraming(input: FramingInput): Framing {
  const viewportWidth = Math.max(MIN_VIEWPORT_PX, Math.round(input.viewportWidth) || MIN_VIEWPORT_PX);
  const viewportHeight = Math.max(MIN_VIEWPORT_PX, Math.round(input.viewportHeight) || MIN_VIEWPORT_PX);
  const usable = usableRect(viewportWidth, viewportHeight, normalizeInsets(input.insets));

  let pose: CameraPose;
  let mode: FramingMode;
  let clamped = false;

  if (input.touchLayout) {
    const solved = solveMobilePose(viewportWidth, viewportHeight, usable);
    pose = solved.pose;
    clamped = solved.clamped;
    mode = clamped ? 'mobile-clamped' : 'mobile';
  } else {
    pose = desktopPose();
    mode = 'desktop';
  }

  const metrics = poseMetrics(pose, viewportWidth, viewportHeight);
  return {
    mode,
    camera: pose,
    usable,
    laneCentersPx: metrics.laneCentersPx,
    laneWidthPx: metrics.laneWidthPx,
    hitLineYPx: metrics.hitLineYPx,
    visibleLeadMs: visibleLeadMs(pose, viewportWidth, viewportHeight, usable.top),
    hitLineDepth: metrics.depthHit,
    clamped,
  };
}

export function normalizeInsets(insets: Partial<SafeInsets> | undefined): SafeInsets {
  return {
    top: sanitize(insets?.top),
    right: sanitize(insets?.right),
    bottom: sanitize(insets?.bottom),
    left: sanitize(insets?.left),
  };
}

function sanitize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (max < min) return min;
  return value < min ? min : value > max ? max : value;
}
