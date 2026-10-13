import { describe, expect, it } from 'vitest';
import { LanePressTracker } from '../src/game/LanePressTracker';

const key = (code: string) => LanePressTracker.keyboardSource(code);
const pointer = (id: number) => LanePressTracker.pointerSource(id);

describe('LanePressTracker', () => {
  it('reports the up -> down transition exactly once per lane', () => {
    const tracker = new LanePressTracker();
    expect(tracker.acquire(0, key('KeyA'))).toBe('pressed');
    expect(tracker.acquire(0, key('KeyA'))).toBe('duplicate');
    expect(tracker.isDown(0)).toBe(true);
    expect(tracker.pressedLanes()).toEqual([0]);

    expect(tracker.release(key('KeyA'))).toEqual({ lane: 0, sourceId: 'key:KeyA', remaining: 0 });
    expect(tracker.isDown(0)).toBe(false);
    expect(tracker.release(key('KeyA'))).toBeNull();
  });

  it('lets one finger releasing not release another finger of the same lane', () => {
    const tracker = new LanePressTracker();
    expect(tracker.acquire(4, pointer(1))).toBe('pressed');
    expect(tracker.acquire(4, pointer(2))).toBe('duplicate');
    expect(tracker.sourcesOn(4).sort()).toEqual([pointer(1), pointer(2)].sort());

    expect(tracker.release(pointer(1))).toBeNull(); // lane is still held by pointer 2
    expect(tracker.isDown(4)).toBe(true);
    expect(tracker.release(pointer(2))).toEqual({ lane: 4, sourceId: 'pointer:2', remaining: 0 });
    expect(tracker.isDown(4)).toBe(false);
  });

  it('treats a keyboard key and a finger on one lane as two holders', () => {
    const tracker = new LanePressTracker();
    expect(tracker.acquire(2, key('KeyD'))).toBe('pressed');
    expect(tracker.acquire(2, pointer(9))).toBe('duplicate'); // no second judgment
    expect(tracker.release(key('KeyD'))).toBeNull(); // the finger still holds lane 2
    expect(tracker.isDown(2)).toBe(true);
    expect(tracker.release(pointer(9))?.lane).toBe(2);
    expect(tracker.isDown(2)).toBe(false);
  });

  it('keeps simultaneous lanes independent (chords)', () => {
    const tracker = new LanePressTracker();
    tracker.acquire(0, pointer(1));
    tracker.acquire(3, pointer(2));
    tracker.acquire(6, pointer(3));
    expect(tracker.pressedLanes()).toEqual([0, 3, 6]);

    expect(tracker.release(pointer(2))?.lane).toBe(3);
    expect(tracker.pressedLanes()).toEqual([0, 6]);
    expect(tracker.isDown(3)).toBe(false);
  });

  it('never lets a source migrate to another lane', () => {
    const tracker = new LanePressTracker();
    expect(tracker.acquire(0, pointer(5))).toBe('pressed');
    expect(tracker.acquire(6, pointer(5))).toBe('duplicate');
    expect(tracker.laneOf(pointer(5))).toBe(0);
    expect(tracker.isDown(6)).toBe(false);
  });

  it('ignores out-of-range lanes and unknown sources', () => {
    const tracker = new LanePressTracker();
    expect(tracker.acquire(-1, pointer(1))).toBe('duplicate');
    expect(tracker.acquire(7, pointer(1))).toBe('duplicate');
    expect(tracker.acquire(1.5, pointer(1))).toBe('duplicate');
    expect(tracker.isDown(7)).toBe(false);
    expect(tracker.isDown(-1)).toBe(false);
    expect(tracker.sourcesOn(99)).toEqual([]);
    expect(tracker.release('nobody')).toBeNull();
    expect(tracker.laneOf('nobody')).toBeNull();
  });

  it('drops every holder on releaseAll and reports the lanes that were down', () => {
    const tracker = new LanePressTracker();
    tracker.acquire(1, key('KeyS'));
    tracker.acquire(1, pointer(1));
    tracker.acquire(5, pointer(2));
    expect(tracker.releaseAll()).toEqual([1, 5]);
    expect(tracker.pressedLanes()).toEqual([]);
    expect(tracker.activeSourceCount).toBe(0);
    expect(tracker.releaseAll()).toEqual([]);
    expect(tracker.isDown(1)).toBe(false);
  });

  it('releaseLane frees one lane without touching the others', () => {
    const tracker = new LanePressTracker();
    tracker.acquire(3, pointer(1));
    tracker.acquire(3, key('Space'));
    tracker.acquire(4, pointer(2));
    // Two holders, but only the last release is a lane transition, so there is one release.
    const releases = tracker.releaseLane(3);
    expect(releases.map((entry) => entry.lane)).toEqual([3]);
    expect(tracker.sourcesOn(3)).toEqual([]);
    expect(tracker.isDown(3)).toBe(false);
    expect(tracker.isDown(4)).toBe(true);
    expect(tracker.activeSourceCount).toBe(1);
    expect(tracker.releaseLane(3)).toEqual([]);
  });

  it('tracks the active source count across acquire/release', () => {
    const tracker = new LanePressTracker();
    tracker.acquire(0, pointer(1));
    tracker.acquire(1, pointer(2));
    tracker.acquire(1, pointer(3));
    expect(tracker.activeSourceCount).toBe(3);
    tracker.release(pointer(2));
    expect(tracker.activeSourceCount).toBe(2);
  });
});
