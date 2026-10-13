/**
 * Hold rendering (phase 3.1) — through the *real* renderer, not a copy of its maths.
 *
 * `hold-geometry.test.ts` pins the transform down in isolation. This suite drives
 * `NoteRenderer.update` (the code that actually draws) and reads the instance matrices back out of
 * the `InstancedMesh`, which is what proves the three pieces a player sees — head cap, tail cap and
 * body — agree with each other and with the note's chart timestamps:
 *
 *   - head/tail caps sit exactly at the geometry's `headZ`/`tailZ`, for every scroll speed;
 *   - the body's instance scale is exactly the distance between them (so it is connected, never
 *     detached, stretched or shrunk);
 *   - the body follows the note onto its own lane at any lane count;
 *   - a hit hold anchors at the hit line, and a completed/broken hold draws nothing;
 *   - the same song time always draws the same frame, which is what makes pause/resume safe.
 *
 * three.js runs headless here (no WebGL context is needed for an `InstancedMesh`), so this is a
 * node-environment test.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { NoteStatus, RuntimeNote } from '../src/game/JudgmentEngine';
import { NoteRenderer } from '../src/renderer/NoteRenderer';
import { ROAD_LENGTH, holdGeometry, laneToX, leadMsForSpeed } from '../src/renderer/Layout';

const HEAD_MS = 8000;
const DURATION_MS = 900;
const LANE = 3;

function runtimeNote(overrides: Partial<RuntimeNote> = {}): RuntimeNote {
  return {
    index: 0,
    lane: LANE,
    type: 'hold',
    timeMs: HEAD_MS,
    endTimeMs: HEAD_MS + DURATION_MS,
    durationMs: DURATION_MS,
    weight: 2,
    status: 'pending',
    headJudgment: null,
    headErrorMs: null,
    headCombo: null,
    releasedEarly: false,
    ...overrides,
  };
}

function makeRenderer(laneCount = 7): NoteRenderer {
  const parent = new THREE.Object3D();
  const renderer = new NoteRenderer(parent);
  renderer.setLaneCount(laneCount);
  return renderer;
}

/** Decompose one drawn instance back into position and scale. */
function instanceOf(mesh: THREE.InstancedMesh, index: number): { z: number; x: number; length: number } {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(index, matrix);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  return { z: position.z, x: position.x, length: scale.z };
}

describe('a falling hold', () => {
  it('draws its caps and body where the note’s timestamps say', () => {
    for (const speed of [0.5, 0.75, 1, 1.5, 2, 2.5]) {
      const leadMs = leadMsForSpeed(speed);
      const renderer = makeRenderer();
      const note = runtimeNote();
      renderer.update([note], HEAD_MS - 300, leadMs);

      expect(renderer.drawnCaps).toBe(2);
      expect(renderer.drawnBodies).toBe(1);

      const geometry = holdGeometry({
        timeMs: note.timeMs,
        endTimeMs: note.endTimeMs,
        songTimeMs: HEAD_MS - 300,
        leadMs,
        anchoredToLine: false,
      });
      const head = instanceOf(renderer.caps, 0);
      const tail = instanceOf(renderer.caps, 1);
      const body = instanceOf(renderer.bodies, 0);

      expect(head.z).toBeCloseTo(geometry.headZ, 6);
      expect(tail.z).toBeCloseTo(geometry.tailZ, 6);
      expect(body.z).toBeCloseTo(geometry.bodyCenterZ, 6);
      // The drawn body is exactly as long as the gap between the two drawn caps.
      expect(body.length).toBeCloseTo(Math.abs(tail.z - head.z), 6);
      // And it is as long as the note's duration, expressed through the scroll transform — unless
      // the tail is beyond the spawn plane, where the clip (legitimately) shortens the drawn body.
      if (DURATION_MS + 300 < leadMs) {
        expect((body.length / ROAD_LENGTH) * leadMs).toBeCloseTo(DURATION_MS, 4);
      } else {
        expect(instanceOf(renderer.caps, 1).z).toBe(-ROAD_LENGTH);
      }
    }
  });

  it('draws the body and both caps on the note’s own lane', () => {
    for (const laneCount of [4, 5, 7]) {
      const lane = laneCount - 1;
      const renderer = makeRenderer(laneCount);
      renderer.update([runtimeNote({ lane })], HEAD_MS - 200, leadMsForSpeed(1));
      const expectedX = laneToX(lane, laneCount);
      expect(instanceOf(renderer.caps, 0).x).toBeCloseTo(expectedX, 6);
      expect(instanceOf(renderer.caps, 1).x).toBeCloseTo(expectedX, 6);
      expect(instanceOf(renderer.bodies, 0).x).toBeCloseTo(expectedX, 6);
    }
  });

  it('draws nothing for a lane the chart does not have', () => {
    const renderer = makeRenderer(4);
    renderer.update([runtimeNote({ lane: 6 })], HEAD_MS - 200, leadMsForSpeed(1));
    expect(renderer.drawnCaps).toBe(0);
    expect(renderer.drawnBodies).toBe(0);
  });

  it('clips a body that runs past the spawn plane instead of stretching it', () => {
    const renderer = makeRenderer();
    const note = runtimeNote({ timeMs: HEAD_MS, endTimeMs: HEAD_MS + 3000, durationMs: 3000 });
    renderer.update([note], HEAD_MS - 100, leadMsForSpeed(2.5));
    const body = instanceOf(renderer.bodies, 0);
    // The head is 100 ms from the line; the tail would be 2900 ms away, far past a 720 ms lead.
    expect(body.length).toBeLessThanOrEqual(ROAD_LENGTH);
    expect(instanceOf(renderer.caps, 1).z).toBeGreaterThanOrEqual(-ROAD_LENGTH - 1e-9);
  });
});

describe('a held hold', () => {
  it('anchors the remaining body at the hit line', () => {
    const leadMs = leadMsForSpeed(1);
    const renderer = makeRenderer();
    renderer.update([runtimeNote({ status: 'holding' })], HEAD_MS + 300, leadMs);
    // The head has been consumed: only the body remains.
    expect(renderer.drawnCaps).toBe(0);
    expect(renderer.drawnBodies).toBe(1);
    const body = instanceOf(renderer.bodies, 0);
    const geometry = holdGeometry({
      timeMs: HEAD_MS,
      endTimeMs: HEAD_MS + DURATION_MS,
      songTimeMs: HEAD_MS + 300,
      leadMs,
      anchoredToLine: true,
    });
    expect(geometry.headZ).toBe(0);
    expect(body.z).toBeCloseTo(geometry.bodyCenterZ, 6);
    expect(body.length).toBeCloseTo(geometry.bodyLength, 6);
    // Body spans from the hit line to the tail: [tailZ, 0].
    expect(body.z - body.length / 2).toBeCloseTo(geometry.tailZ, 6);
    expect(body.z + body.length / 2).toBeCloseTo(0, 6);
  });

  it('does not jump between the last falling frame and the first held frame', () => {
    const leadMs = leadMsForSpeed(1);
    const falling = makeRenderer();
    falling.update([runtimeNote()], HEAD_MS, leadMs);
    const held = makeRenderer();
    held.update([runtimeNote({ status: 'holding' })], HEAD_MS, leadMs);
    expect(instanceOf(held.bodies, 0)).toEqual(instanceOf(falling.bodies, 0));
  });

  it('stops drawing once the whole hold is behind the visible past', () => {
    const renderer = makeRenderer();
    renderer.update([runtimeNote({ status: 'holding' })], HEAD_MS + DURATION_MS + 250, leadMsForSpeed(1));
    // The engine completes a hold at its tail, so this is the one leftover frame: nothing is drawn.
    expect(renderer.drawnBodies).toBe(0);
    expect(renderer.drawnCaps).toBe(0);
  });

  it('keeps drawing the trail while the player holds, long after the head is gone', () => {
    // The head crossing the line must not make the trail vanish: the note is still live until the
    // tail arrives (this is what made a long hold look like it had lost its head).
    const renderer = makeRenderer();
    const note = runtimeNote({ status: 'holding', timeMs: HEAD_MS, endTimeMs: HEAD_MS + 3000, durationMs: 3000 });
    renderer.update([note], HEAD_MS + 2000, leadMsForSpeed(1));
    expect(renderer.drawnBodies).toBe(1);
    const body = instanceOf(renderer.bodies, 0);
    expect(body.length).toBeCloseTo((1000 / leadMsForSpeed(1)) * ROAD_LENGTH, 4);
  });
});

describe('resolved holds are cleaned up', () => {
  it('draws nothing for completed, broken or interrupted holds', () => {
    for (const status of ['completed', 'broken', 'interrupted'] as NoteStatus[]) {
      const renderer = makeRenderer();
      renderer.update([runtimeNote({ status })], HEAD_MS + 400, leadMsForSpeed(1));
      expect(renderer.drawnCaps, status).toBe(0);
      expect(renderer.drawnBodies, status).toBe(0);
    }
  });

  it('keeps a missed hold on screen as a shrinking cap, with no trail', () => {
    const renderer = makeRenderer();
    renderer.update([runtimeNote({ status: 'missed', headJudgment: 'miss' })], HEAD_MS + 100, leadMsForSpeed(1));
    expect(renderer.drawnCaps).toBe(1);
    expect(renderer.drawnBodies).toBe(0);
  });
});

describe('pause, resume and speed changes', () => {
  it('draws an identical frame for the same song time, whatever happened before', () => {
    const leadMs = leadMsForSpeed(1.5);
    const fresh = makeRenderer();
    fresh.update([runtimeNote()], HEAD_MS - 500, leadMs);
    const first = instanceOf(fresh.bodies, 0);

    // Same clock position after a "pause" and a "resume", plus a different earlier frame.
    const resumed = makeRenderer();
    resumed.update([runtimeNote()], HEAD_MS - 1200, leadMs);
    resumed.update([runtimeNote()], HEAD_MS - 500, leadMs);
    expect(instanceOf(resumed.bodies, 0)).toEqual(first);
  });

  it('keeps the trail aligned with the note at every speed', () => {
    for (const speed of [0.5, 1, 2, 2.5]) {
      const leadMs = leadMsForSpeed(speed);
      const renderer = makeRenderer();
      renderer.update([runtimeNote()], HEAD_MS - 150, leadMs);
      const head = instanceOf(renderer.caps, 0);
      const tail = instanceOf(renderer.caps, 1);
      const body = instanceOf(renderer.bodies, 0);
      expect(body.length).toBeCloseTo(Math.abs(tail.z - head.z), 6);
      expect(body.z).toBeCloseTo((head.z + tail.z) / 2, 6);
    }
  });
});
