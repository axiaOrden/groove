import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  FOV_MAX,
  FOV_MIN,
  HIT_LINE_FRACTION,
  LANE_SPREAD,
  MIN_COMFORTABLE_LEAD_MS,
  computeFraming,
  desktopPose,
  poseMetrics,
  type CameraPose,
  type FramingInput,
} from '../src/renderer/CameraFraming';
import {
  BASE_LEAD_MS,
  CAMERA_FOV,
  CAMERA_POSITION,
  CAMERA_TARGET,
  CAMERA_FAR,
  CAMERA_NEAR,
  LANE_COUNT,
  laneToX,
} from '../src/renderer/Layout';

/**
 * The framing solver is checked against three.js's *own* projection matrix rather than against
 * a second implementation of the same algebra: build the camera the renderer would build, ask
 * three.js where a world point lands, and compare with the numbers the solver reports.
 */
function project(pose: CameraPose, width: number, height: number, x: number, y: number, z: number) {
  const camera = new THREE.PerspectiveCamera(pose.fov, width / height, CAMERA_NEAR, CAMERA_FAR);
  camera.position.set(pose.position.x, pose.position.y, pose.position.z);
  camera.lookAt(pose.target.x, pose.target.y, pose.target.z);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const ndc = new THREE.Vector3(x, y, z).project(camera);
  return { x: ((ndc.x + 1) / 2) * width, y: ((1 - ndc.y) / 2) * height, z: ndc.z };
}

function frame(width: number, height: number, extra: Partial<FramingInput> = {}) {
  return computeFraming({ viewportWidth: width, viewportHeight: height, touchLayout: false, ...extra });
}

const PHONES: Array<[string, number, number]> = [
  ['Xiaomi-class 20:9', 800, 360],
  ['small 16:9', 667, 375],
  ['compact', 640, 300],
  ['tablet landscape', 1024, 768],
  ['windowed desktop', 1440, 700],
  ['ultra-wide strip', 2400, 300],
  ['portrait phone', 360, 800],
];

describe('computeFraming — desktop mode', () => {
  it('leaves the phase 1 camera exactly as it was', () => {
    const framing = frame(1440, 700);
    expect(framing.mode).toBe('desktop');
    expect(framing.camera.fov).toBe(CAMERA_FOV);
    expect(framing.camera.position).toEqual({ x: CAMERA_POSITION.x, y: CAMERA_POSITION.y, z: CAMERA_POSITION.z });
    expect(framing.camera.target).toEqual({ x: CAMERA_TARGET.x, y: CAMERA_TARGET.y, z: CAMERA_TARGET.z });
    expect(framing.clamped).toBe(false);
  });

  it('reports the whole road as visible (fog hides the far end before the top edge)', () => {
    const framing = frame(1440, 700);
    expect(framing.visibleLeadMs).toBe(BASE_LEAD_MS);
  });

  it('agrees with three.js about the hit line and the lane centres', () => {
    const width = 1440;
    const height = 700;
    const framing = frame(width, height);
    const hit = project(framing.camera, width, height, 0, 0, 0);
    expect(framing.hitLineYPx).toBeCloseTo(hit.y, 6);
    expect(framing.hitLineYPx / height).toBeCloseTo(0.826, 2);
    for (let lane = 0; lane < LANE_COUNT; lane += 1) {
      const point = project(framing.camera, width, height, laneToX(lane), 0, 0);
      expect(framing.laneCentersPx[lane]).toBeCloseTo(point.x, 6);
    }
  });
});

describe('computeFraming — mobile mode', () => {
  it('spreads the seven lanes across the usable width', () => {
    const framing = frame(800, 360, { touchLayout: true });
    expect(framing.mode).toBe('mobile');
    // Seven columns of `laneWidthPx` (measured between column centres) span the spread.
    expect(framing.laneWidthPx).toBeCloseTo((LANE_SPREAD * framing.usable.width) / LANE_COUNT, 6);
    const span = framing.laneCentersPx[LANE_COUNT - 1]! - framing.laneCentersPx[0]!;
    expect(span).toBeCloseTo(framing.laneWidthPx * (LANE_COUNT - 1), 6);
    // the outer columns stay on screen inside the usable rect
    expect(framing.laneCentersPx[0]! - framing.laneWidthPx / 2).toBeGreaterThanOrEqual(framing.usable.left - 1e-6);
    expect(framing.laneCentersPx[LANE_COUNT - 1]! + framing.laneWidthPx / 2).toBeLessThanOrEqual(
      framing.usable.left + framing.usable.width + 1e-6,
    );
    // lane 3 (SPACE) is the centre lane and the road is centred in the usable rect
    expect(framing.laneCentersPx[3]).toBeCloseTo(framing.usable.left + framing.usable.width / 2, 4);
  });

  it('gives every lane a large touch target on a phone', () => {
    for (const [label, width, height] of PHONES) {
      const framing = frame(width, height, { touchLayout: true });
      expect(framing.laneWidthPx, label).toBeGreaterThanOrEqual(width < 400 ? 24 : 48);
    }
  });

  it('puts the hit line where a thumb can reach it', () => {
    const framing = frame(800, 360, { touchLayout: true });
    const target = framing.usable.top + HIT_LINE_FRACTION * framing.usable.height;
    expect(framing.hitLineYPx).toBeCloseTo(target, 3);
    expect(framing.hitLineYPx).toBeLessThan(framing.usable.top + framing.usable.height);
  });

  it('shows the whole road, i.e. the full phase 1 lead, on landscape phones', () => {
    const landscape: Array<[string, number, number]> = [
      ['Xiaomi-class 20:9', 800, 360],
      ['small 16:9', 667, 375],
      ['compact', 640, 300],
    ];
    for (const [label, width, height] of landscape) {
      const framing = frame(width, height, { touchLayout: true });
      expect(framing.visibleLeadMs, label).toBe(BASE_LEAD_MS);
      expect(framing.clamped, label).toBe(false);
    }
  });

  it('keeps every phone above the comfortable read time, and never claims a clamped one is fine', () => {
    for (const [label, width, height] of PHONES) {
      const framing = frame(width, height, { touchLayout: true });
      expect(framing.visibleLeadMs, label).toBeLessThanOrEqual(BASE_LEAD_MS);
      if (!framing.clamped) {
        expect(framing.visibleLeadMs, label).toBeGreaterThanOrEqual(MIN_COMFORTABLE_LEAD_MS);
      }
    }
  });

  it('agrees with three.js about the hit line and the lane centres', () => {
    for (const [label, width, height] of PHONES) {
      const framing = frame(width, height, { touchLayout: true });
      const hit = project(framing.camera, width, height, 0, 0, 0);
      expect(framing.hitLineYPx, `${label} hit line`).toBeCloseTo(hit.y, 4);
      for (let lane = 0; lane < LANE_COUNT; lane += 1) {
        const point = project(framing.camera, width, height, laneToX(lane), 0, 0);
        expect(framing.laneCentersPx[lane], `${label} lane ${lane}`).toBeCloseTo(point.x, 4);
      }
    }
  });

  it('keeps lane centres evenly spaced and monotonic', () => {
    for (const [label, width, height] of PHONES) {
      const framing = frame(width, height, { touchLayout: true });
      const gaps = framing.laneCentersPx.slice(1).map((value, index) => value - framing.laneCentersPx[index]!);
      for (const gap of gaps) expect(gap, label).toBeGreaterThan(0);
      for (const gap of gaps) expect(gap, label).toBeCloseTo(framing.laneWidthPx, 4);
    }
  });

  it('keeps the camera inside a legible fov range on every viewport', () => {
    for (const [label, width, height] of PHONES) {
      const framing = frame(width, height, { touchLayout: true });
      expect(framing.camera.fov, label).toBeGreaterThanOrEqual(FOV_MIN - 1e-9);
      expect(framing.camera.fov, label).toBeLessThanOrEqual(FOV_MAX + 1e-9);
      expect(framing.visibleLeadMs, label).toBeGreaterThanOrEqual(0);
      expect(framing.visibleLeadMs, label).toBeLessThanOrEqual(BASE_LEAD_MS);
      expect(Number.isFinite(framing.hitLineDepth), label).toBe(true);
      expect(framing.hitLineDepth, label).toBeGreaterThan(0);
    }
  });

  it('respects display cutouts: lanes stay inside the usable rect and the road is centred in it', () => {
    const insets = { top: 0, right: 0, bottom: 0, left: 44 };
    const framing = frame(800, 360, { touchLayout: true, insets });
    expect(framing.usable.left).toBe(44);
    expect(framing.usable.width).toBe(756);
    // the road follows the usable centre, so the outer lane stays on screen
    expect(framing.laneCentersPx[3]).toBeCloseTo(44 + 756 / 2, 3);
    expect(framing.laneCentersPx[0]).toBeGreaterThan(44);
    expect(framing.laneCentersPx[LANE_COUNT - 1]).toBeLessThan(756 + 44);
    const hit = project(framing.camera, 800, 360, 0, 0, 0);
    expect(Math.abs(hit.x - (44 + 756 / 2))).toBeLessThan(0.5);
  });

  it('is deterministic', () => {
    const a = frame(800, 360, { touchLayout: true });
    const b = frame(800, 360, { touchLayout: true });
    expect(a).toEqual(b);
  });
});

describe('computeFraming — degenerate input', () => {
  it('never returns NaN for absurd viewports or insets', () => {
    const cases: Array<[number, number, Partial<FramingInput>]> = [
      [0, 0, {}],
      [-100, -100, {}],
      [20000, 100, { touchLayout: true }],
      [300, 300, { touchLayout: true, insets: { left: 5000, right: 5000, top: 5000, bottom: 5000 } }],
      [800, 360, { touchLayout: true, insets: { left: -20, top: Number.NaN } }],
    ];
    for (const [width, height, extra] of cases) {
      const framing = frame(width, height, extra);
      expect(Number.isFinite(framing.camera.fov)).toBe(true);
      expect(Number.isFinite(framing.camera.position.y)).toBe(true);
      expect(Number.isFinite(framing.camera.position.z)).toBe(true);
      expect(Number.isFinite(framing.hitLineYPx)).toBe(true);
      expect(Number.isFinite(framing.visibleLeadMs)).toBe(true);
      expect(framing.laneCentersPx.every((value) => Number.isFinite(value))).toBe(true);
      expect(framing.usable.width).toBeGreaterThan(0);
      expect(framing.usable.height).toBeGreaterThan(0);
    }
  });

  it('reports clamped geometry instead of pretending a target was met', () => {
    const framing = frame(2400, 150, { touchLayout: true });
    expect(Number.isFinite(framing.camera.fov)).toBe(true);
    if (framing.mode === 'mobile-clamped') expect(framing.clamped).toBe(true);
    else expect(framing.visibleLeadMs).toBeGreaterThanOrEqual(MIN_COMFORTABLE_LEAD_MS);
  });
});

describe('poseMetrics', () => {
  it('matches a three.js projection for an arbitrary road point', () => {
    const pose = desktopPose();
    const metrics = poseMetrics(pose, 1280, 720);
    for (const z of [0, -3, -12, -24]) {
      const point = project(pose, 1280, 720, 0, 0, z);
      expect(metrics.screenYForZ(z)).toBeCloseTo(point.y, 6);
    }
  });
});
