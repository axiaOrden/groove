import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { ChartNote } from '../src/chart/ChartTypes';
import { createRuntimeNotes } from '../src/game/JudgmentEngine';
import {
  BASE_LEAD_MS,
  LANE_COUNT,
  PAST_VISIBLE_Z,
  laneToX,
  leadMsForSpeed,
  zForTimeToHit,
} from '../src/renderer/Layout';
import { NoteRenderer } from '../src/renderer/NoteRenderer';

/**
 * NoteRenderer is instantiable in Node: it builds three.js objects (geometry, materials,
 * InstancedMesh) but never touches the DOM or a GPU context. That makes the pooling, the cull
 * pointer and the time-to-z mapping testable without a browser.
 */
function makeRenderer(notes: readonly ChartNote[]) {
  const parent = new THREE.Group();
  const renderer = new NoteRenderer(parent);
  return { renderer, runtime: createRuntimeNotes(notes, { chartOffsetMs: 0 }) };
}

/** Translation z of instance `index` in an instanced mesh. */
function instanceZ(mesh: THREE.InstancedMesh, index: number): number {
  return mesh.instanceMatrix.array[index * 16 + 14]!;
}

/** Scale z of instance `index` in an instanced mesh. */
function instanceScaleZ(mesh: THREE.InstancedMesh, index: number): number {
  return mesh.instanceMatrix.array[index * 16 + 10]!;
}

function instanceX(mesh: THREE.InstancedMesh, index: number): number {
  return mesh.instanceMatrix.array[index * 16 + 12]!;
}

describe('NoteRenderer', () => {
  it('draws only the notes inside the visual lead time', () => {
    const { renderer, runtime } = makeRenderer([
      { timeMs: 500, lane: 0, type: 'tap' },
      { timeMs: 1700, lane: 1, type: 'tap' },
      { timeMs: 9000, lane: 2, type: 'tap' },
    ]);
    const leadMs = leadMsForSpeed(1);

    renderer.update(runtime, 0, leadMs);
    expect(renderer.drawnCaps).toBe(2); // 500 and 1700 are within 1800 ms; 9000 is not
    expect(renderer.caps.count).toBe(2);
    expect(renderer.bodies.count).toBe(0);

    // Far ahead of the lead the 9000 note is not drawn, and the two overdue notes are skipped
    // rather than drawn ~20 units behind the hit line (see the defensive skip in update).
    renderer.update(runtime, 4000, leadMs);
    expect(renderer.drawnCaps).toBe(0);
  });

  it('stops drawing notes that were hit, and keeps missed notes falling near the line', () => {
    const { renderer, runtime } = makeRenderer([{ timeMs: 1000, lane: 3, type: 'tap' }]);
    const leadMs = BASE_LEAD_MS;

    runtime[0]!.status = 'hit';
    renderer.update(runtime, 900, leadMs);
    expect(renderer.drawnCaps).toBe(0);

    runtime[0]!.status = 'missed';
    renderer.update(runtime, 1000, leadMs);
    expect(renderer.drawnCaps).toBe(1);

    // Clamped: a miss only 180 ms past its time would otherwise sit 2.4 units behind the line.
    renderer.update(runtime, 1180, leadMs);
    expect(renderer.drawnCaps).toBe(1);
    expect(instanceZ(renderer.caps, 0)).toBeLessThanOrEqual(PAST_VISIBLE_Z + 1e-6);

    // Past the visible-past window the note is gone for good.
    renderer.update(runtime, 1500, leadMs);
    expect(renderer.drawnCaps).toBe(0);
    expect(renderer.culledFrom).toBe(1);
  });

  it('maps time to z through laneToX so the hit line is reached exactly on time', () => {
    const { renderer, runtime } = makeRenderer([
      { timeMs: 1000, lane: 0, type: 'tap' },
      { timeMs: 1000, lane: 6, type: 'tap' },
    ]);
    const leadMs = BASE_LEAD_MS;

    renderer.update(runtime, 1000, leadMs);
    expect(instanceZ(renderer.caps, 0)).toBeCloseTo(0, 6);
    expect(instanceX(renderer.caps, 0)).toBeCloseTo(laneToX(0), 6);
    expect(instanceX(renderer.caps, 1)).toBeCloseTo(laneToX(6), 6);

    renderer.update(runtime, 100, leadMs);
    expect(instanceZ(renderer.caps, 0)).toBeCloseTo(zForTimeToHit(900, leadMs), 4);

    renderer.update(runtime, 1000 + leadMs, leadMs);
    expect(renderer.drawnCaps).toBe(0); // exactly at the spawn plane is the outer limit
  });

  it('renders hold heads, tails and a body of the right length', () => {
    const { renderer, runtime } = makeRenderer([{ timeMs: 1000, lane: 2, type: 'hold', durationMs: 800 }]);
    const leadMs = BASE_LEAD_MS;

    renderer.update(runtime, 500, leadMs);
    expect(renderer.drawnCaps).toBe(2); // head cap + tail cap
    expect(renderer.drawnBodies).toBe(1);
    expect(instanceScaleZ(renderer.bodies, 0)).toBeCloseTo((800 / leadMs) * 24, 4);
    // The instance matrix stores float32, so read-backs are compared at 1e-4.
    expect(instanceZ(renderer.caps, 0)).toBeCloseTo(zForTimeToHit(500, leadMs), 4);
    expect(instanceZ(renderer.caps, 1)).toBeCloseTo(zForTimeToHit(1300, leadMs), 4);

    // While holding, the consumed part is gone: the body spans from the line to the tail only.
    runtime[0]!.status = 'holding';
    renderer.update(runtime, 1200, leadMs);
    expect(renderer.drawnCaps).toBe(0);
    expect(renderer.drawnBodies).toBe(1);
    expect(instanceScaleZ(renderer.bodies, 0)).toBeCloseTo((600 / leadMs) * 24, 4);
  });

  it('rewinds the cull pointer when the clock moves backwards (resume with count-in / seek)', () => {
    const { renderer, runtime } = makeRenderer([
      { timeMs: 1000, lane: 0, type: 'tap' },
      { timeMs: 2000, lane: 1, type: 'tap' },
      { timeMs: 3000, lane: 2, type: 'tap' },
    ]);
    const leadMs = BASE_LEAD_MS;
    runtime[0]!.status = 'hit';
    runtime[1]!.status = 'hit';

    renderer.update(runtime, 4000, leadMs);
    expect(renderer.culledFrom).toBe(2);

    renderer.update(runtime, 1900, leadMs); // backwards jump
    // Without the rewind the pointer would still be 2 and nothing would be drawn again; the
    // first note is legitimately re-culled because it is already resolved and out of range.
    expect(renderer.culledFrom).toBeLessThanOrEqual(1);
    expect(renderer.drawnCaps).toBe(1); // the third note is within the lead again
  });

  it('never overflows its instance pools, however dense the chart is', () => {
    const notes: ChartNote[] = [];
    for (let lane = 0; lane < LANE_COUNT; lane += 1) {
      for (let i = 0; i < 400; i += 1) {
        notes.push({ timeMs: i * 2, lane, type: i % 5 === 0 ? 'hold' : 'tap', durationMs: 40 });
      }
    }
    const { renderer, runtime } = makeRenderer(notes);
    renderer.update(runtime, 0, BASE_LEAD_MS);

    expect(renderer.caps.count).toBeLessThanOrEqual(renderer.caps.instanceMatrix.count);
    expect(renderer.bodies.count).toBeLessThanOrEqual(renderer.bodies.instanceMatrix.count);
    expect(renderer.drawnCaps).toBe(renderer.caps.count);

    renderer.reset();
    expect(renderer.caps.count).toBe(0);
    expect(renderer.bodies.count).toBe(0);
    expect(renderer.culledFrom).toBe(0);
  });
});
