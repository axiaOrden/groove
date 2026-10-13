// @vitest-environment jsdom
/**
 * Slide (swipe) input tests — phase 1.6.
 *
 * A finger that stays on the glass moves between lanes: every column boundary it crosses is a
 * release of the lane it left plus a press of the lane it arrived in, through the same pipeline a
 * tap uses. These tests drive the *real* path: `TouchSurface` columns, an `InputManager` bound to
 * the surface, pointer events with coordinates, and (in the last block) the real `GameEngine`
 * scoring what comes out.
 *
 * The important structural point is that lane resolution comes from the *pointer coordinates*
 * against the surface's cached rectangles, never from `event.target`: `setPointerCapture`
 * retargets the whole gesture to the column the finger started on. To make sure a regression
 * cannot hide behind a lucky target, every move below is dispatched on lane 0's zone.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SongClock } from '../src/audio/AudioSource';
import type { Beatmap, ChartNote } from '../src/chart/ChartTypes';
import { BEATMAP_SCHEMA_VERSION } from '../src/chart/ChartTypes';
import { prepareBeatmap } from '../src/chart/ChartValidator';
import { GameEngine } from '../src/game/GameEngine';
import type { GameEvent } from '../src/game/GameEngine';
import { InputManager } from '../src/game/InputManager';
import { TouchSurface } from '../src/ui/TouchSurface';

/** jsdom ships neither PointerEvent nor pointer capture. */
function pointerEvent(type: string, pointerId: number, clientX: number, clientY: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId, configurable: true },
    pointerType: { value: 'touch', configurable: true },
    isPrimary: { value: pointerId === 1, configurable: true },
    clientX: { value: clientX, configurable: true },
    clientY: { value: clientY, configurable: true },
    buttons: { value: 1, configurable: true },
  });
  return event;
}

// A clean 700 px-wide layout: column n is exactly [100n, 100n + 100).
const VIEWPORT = { width: 700, height: 360 };
const LANE_CENTERS = [50, 150, 250, 350, 450, 550, 650];
const COLUMN_TOP = 60;
const TAP_Y = 300;
const laneX = (lane: number): number => LANE_CENTERS[lane]!;

interface Harness {
  root: HTMLElement;
  surface: TouchSurface;
  input: InputManager;
  zones: HTMLElement[];
  clock: { now: number };
  presses: Array<[number, number]>;
  releases: Array<[number, number]>;
  visuals: Array<[number, boolean]>;
  /** pointerdown on a lane's own column, the way a thumb lands. */
  down(pointerId: number, lane: number): Event;
  /** pointermove: always dispatched on lane 0's column, so only the coordinates can decide. */
  move(pointerId: number, x: number, y?: number): Event;
  /** pointermove to the centre of a lane. */
  slideTo(pointerId: number, lane: number): Event;
  end(type: 'pointerup' | 'pointercancel' | 'lostpointercapture', pointerId: number, lane?: number): Event;
  key(type: 'keydown' | 'keyup', code: string): void;
}

let activeHarness: Harness | null = null;

function makeHarness(): Harness {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const surface = new TouchSurface(root);
  surface.layout({
    laneCentersPx: LANE_CENTERS,
    usable: { left: 0, top: 0, width: VIEWPORT.width, height: VIEWPORT.height },
    topPx: COLUMN_TOP,
    viewportWidth: VIEWPORT.width,
    viewportHeight: VIEWPORT.height,
  });

  const clock = { now: 0 };
  const presses: Array<[number, number]> = [];
  const releases: Array<[number, number]> = [];
  const visuals: Array<[number, boolean]> = [];

  const input = new InputManager({
    nowMs: () => clock.now,
    onLanePress: (lane, songTimeMs) => presses.push([lane, songTimeMs]),
    onLaneRelease: (lane, songTimeMs) => releases.push([lane, songTimeMs]),
    onLaneVisual: (lane, active) => visuals.push([lane, active]),
    onTogglePause: () => undefined,
    onRestart: () => undefined,
    onFocusLost: () => undefined,
  });
  input.attach();
  // The *surface*, not just its element: this is what gives the input layer the cached-rectangle
  // hit test that slides rely on.
  input.attachPointer(surface);
  input.setEnabled(true);

  const zones = [...root.querySelectorAll<HTMLElement>('.touch-zone')];
  const harness: Harness = {
    root,
    surface,
    input,
    zones,
    clock,
    presses,
    releases,
    visuals,
    down(pointerId, lane) {
      const event = pointerEvent('pointerdown', pointerId, laneX(lane), TAP_Y);
      zones[lane]!.dispatchEvent(event);
      return event;
    },
    move(pointerId, x, y = TAP_Y) {
      const event = pointerEvent('pointermove', pointerId, x, y);
      zones[0]!.dispatchEvent(event);
      return event;
    },
    slideTo(pointerId, lane) {
      return harness.move(pointerId, laneX(lane));
    },
    end(type, pointerId, lane = 0) {
      const event = pointerEvent(type, pointerId, laneX(lane), TAP_Y);
      zones[lane]!.dispatchEvent(event);
      return event;
    },
    key(type, code) {
      window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true }));
    },
  };
  activeHarness = harness;
  return harness;
}

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  activeHarness?.input.detachPointer();
  activeHarness?.input.detach();
  activeHarness = null;
  document.body.replaceChildren();
});

describe('sliding across lanes', () => {
  it('presses A, then S, then D without the finger ever being lifted', () => {
    const h = makeHarness();
    h.down(1, 0);
    expect(h.presses).toEqual([[0, 0]]);

    h.clock.now = 120;
    h.slideTo(1, 1);
    h.clock.now = 240;
    h.slideTo(1, 2);

    expect(h.presses).toEqual([
      [0, 0],
      [1, 120],
      [2, 240],
    ]);
    // Each boundary crossed released the lane that was left, in order.
    expect(h.releases).toEqual([
      [0, 120],
      [1, 240],
    ]);
    expect(h.input.pointerLane(1)).toBe(2);
    expect(h.input.isLaneDown(2)).toBe(true);
    expect(h.input.isLaneDown(0)).toBe(false);
    expect(h.input.isLaneDown(1)).toBe(false);
    expect(h.input.activePointers).toBe(1);
    // Visuals: each lane lit as it was entered, cleared as it was left.
    expect(h.visuals).toEqual([
      [0, true],
      [0, false],
      [1, true],
      [1, false],
      [2, true],
    ]);
  });

  it('slides back to A and presses it again', () => {
    const h = makeHarness();
    h.down(1, 0);
    h.slideTo(1, 1);
    h.slideTo(1, 0);

    expect(h.presses.map(([lane]) => lane)).toEqual([0, 1, 0]);
    expect(h.releases.map(([lane]) => lane)).toEqual([0, 1]);
    expect(h.input.isLaneDown(0)).toBe(true);
    expect(h.input.pointerLane(1)).toBe(0);
  });

  it('does not re-press while the pointer moves inside one lane', () => {
    const h = makeHarness();
    h.down(1, 3);
    // Wobble around the lane: its column is [300, 400), so all of these are lane 3.
    for (const x of [301, 320, 380, 399, 350, 305]) h.move(1, x);

    expect(h.presses).toEqual([[3, 0]]);
    expect(h.releases).toEqual([]);
    expect(h.visuals).toEqual([[3, true]]);
  });

  it('hands a boundary pixel to the lane that owns it', () => {
    const h = makeHarness();
    h.down(1, 0);
    h.move(1, 99.9); // still lane 0
    expect(h.input.pointerLane(1)).toBe(0);
    h.move(1, 100); // the first pixel of lane 1
    expect(h.input.pointerLane(1)).toBe(1);
    expect(h.presses.map(([lane]) => lane)).toEqual([0, 1]);
    h.move(1, 199.9); // still lane 1
    expect(h.presses).toHaveLength(2);
    h.move(1, 200); // lane 2
    expect(h.presses.map(([lane]) => lane)).toEqual([0, 1, 2]);
  });

  it('judges only the destination lane when one event jumps several columns', () => {
    const h = makeHarness();
    h.down(1, 0);
    h.move(1, laneX(6)); // 0 -> 6 in a single pointermove

    expect(h.presses.map(([lane]) => lane)).toEqual([0, 6]);
    expect(h.releases.map(([lane]) => lane)).toEqual([0]);
    expect(h.visuals).toEqual([
      [0, true],
      [0, false],
      [6, true],
    ]);
    for (const lane of [1, 2, 3, 4, 5]) {
      expect(h.presses.some(([pressed]) => pressed === lane), `lane ${lane}`).toBe(false);
      expect(h.input.isLaneDown(lane), `lane ${lane}`).toBe(false);
    }
  });

  it('keeps two sliding fingers independent', () => {
    const h = makeHarness();
    h.down(1, 0);
    h.down(2, 6);

    h.slideTo(1, 1);
    h.slideTo(2, 5);
    h.slideTo(1, 2);
    h.slideTo(2, 4);

    expect(h.presses.map(([lane]) => lane)).toEqual([0, 6, 1, 5, 2, 4]);
    expect(h.input.pointerLane(1)).toBe(2);
    expect(h.input.pointerLane(2)).toBe(4);
    expect(h.input.pressedLanes().sort((a, b) => a - b)).toEqual([2, 4]);

    // Lifting one finger leaves the other's lane exactly where it was.
    h.end('pointerup', 1, 2);
    expect(h.input.isLaneDown(2)).toBe(false);
    expect(h.input.isLaneDown(4)).toBe(true);
    expect(h.input.pointerLane(2)).toBe(4);

    h.end('pointerup', 2, 4);
    expect(h.input.pressedLanes()).toEqual([]);
    expect(h.input.activePointers).toBe(0);
  });

  it('treats a move for a pointer that was never on a lane as a no-op', () => {
    const h = makeHarness();
    h.down(1, 0);
    h.move(99, laneX(4)); // never went down
    expect(h.presses).toEqual([[0, 0]]);
    expect(h.input.activePointers).toBe(1);
  });
});

describe('multi-finger ownership while sliding', () => {
  it('does not duplicate a press when a second finger slides into an occupied lane', () => {
    const h = makeHarness();
    h.down(1, 2);
    h.down(2, 5);
    h.clock.now = 50;
    h.slideTo(2, 2); // finger 2 arrives on the lane finger 1 already holds

    expect(h.presses).toEqual([
      [2, 0],
      [5, 0],
    ]); // no third judgment
    expect(h.releases.map(([lane]) => lane)).toEqual([5]); // it did leave lane 5
    expect(h.input.pointerLane(2)).toBe(2);
    expect(h.input.isLaneDown(2)).toBe(true);

    // The first finger slides away: the lane stays down, held by the second.
    h.slideTo(1, 3);
    expect(h.releases.map(([lane]) => lane)).toEqual([5]);
    expect(h.input.isLaneDown(2)).toBe(true);
    expect(h.visuals.filter(([lane, active]) => lane === 2 && !active)).toEqual([]);

    // Only the last finger to leave produces the release.
    h.end('pointerup', 2, 2);
    expect(h.releases.map(([lane]) => lane)).toEqual([5, 2]);
    expect(h.input.isLaneDown(2)).toBe(false);
  });

  it('keeps a lane held when one finger leaves it while another stays', () => {
    const h = makeHarness();
    h.down(1, 4);
    h.down(2, 4);
    h.end('pointerup', 1, 4);
    expect(h.releases).toEqual([]);
    expect(h.input.isLaneDown(4)).toBe(true); // finger 2 still holds it

    h.end('pointerup', 2, 4);
    expect(h.releases).toEqual([[4, 0]]);
    expect(h.input.isLaneDown(4)).toBe(false);
  });

  it('does not steal or double judge a lane held by a key', () => {
    const h = makeHarness();
    h.key('keydown', 'KeyD'); // lane 2 is held by the keyboard
    expect(h.presses).toEqual([[2, 0]]);

    // A finger presses the same lane: the pad lights up, nothing is judged twice.
    h.down(1, 2);
    expect(h.presses).toEqual([[2, 0]]);
    h.slideTo(1, 3); // and slides out: the key still holds lane 2, the finger owns lane 3
    expect(h.releases).toEqual([]);
    expect(h.input.isLaneDown(2)).toBe(true);
    expect(h.input.isLaneDown(3)).toBe(true);

    h.key('keyup', 'KeyD');
    expect(h.releases).toEqual([[2, 0]]);
    expect(h.input.isLaneDown(3)).toBe(true); // the finger's own lane is untouched
    expect(h.input.isLaneDown(2)).toBe(false);
  });

  it('does not duplicate a press when a finger slides into a lane a key already holds', () => {
    const h = makeHarness();
    h.key('keydown', 'KeyJ'); // lane 4, held by the keyboard
    h.down(1, 3);
    h.slideTo(1, 4); // the finger arrives on the lane the key holds

    expect(h.presses.map(([lane]) => lane)).toEqual([4, 3]); // no third judgment
    expect(h.releases.map(([lane]) => lane)).toEqual([3]);
    expect(h.input.isLaneDown(4)).toBe(true);

    h.key('keyup', 'KeyJ');
    expect(h.releases.map(([lane]) => lane)).toEqual([3]); // the finger still holds lane 4
    h.end('pointerup', 1, 4);
    expect(h.releases.map(([lane]) => lane)).toEqual([3, 4]);
  });
});

describe('leaving the surface, cancelling and pausing', () => {
  it('releases the lane when the finger leaves the columns and re-presses on the way back', () => {
    const h = makeHarness();
    h.down(1, 3);
    expect(h.input.isLaneDown(3)).toBe(true);

    // Upwards, over the HUD: outside the column band.
    h.move(1, laneX(3), 10);
    expect(h.releases).toEqual([[3, 0]]);
    expect(h.input.isLaneDown(3)).toBe(false);
    expect(h.input.pointerLane(1)).toBeNull();
    // The finger is still down, so the pointer is still ours to track.
    expect(h.input.activePointers).toBe(1);
    expect(h.input.pointersOnLanes).toBe(0);

    // Back onto the highway, in a different column: pressed again, without a lift.
    h.move(1, laneX(5), TAP_Y);
    expect(h.presses.map(([lane]) => lane)).toEqual([3, 5]);
    expect(h.input.isLaneDown(5)).toBe(true);
    expect(h.input.pointerLane(1)).toBe(5);
  });

  it('tolerates a small drift above the column band without dropping the lane', () => {
    const h = makeHarness();
    h.down(1, 2);
    h.move(1, laneX(2), COLUMN_TOP - 8); // within the vertical slack
    expect(h.input.isLaneDown(2)).toBe(true);
    expect(h.releases).toEqual([]);
  });

  it('settles the lane when the gesture is cancelled mid-slide', () => {
    const h = makeHarness();
    h.down(1, 0);
    h.clock.now = 60;
    h.slideTo(1, 4);
    h.clock.now = 90;
    h.end('pointercancel', 1, 4);

    expect(h.releases).toEqual([
      [0, 60],
      [4, 90],
    ]);
    expect(h.input.pressedLanes()).toEqual([]);
    expect(h.input.activePointers).toBe(0);
    expect(h.input.pointerLane(1)).toBeNull();
  });

  it('settles a slide exactly once when capture is lost afterwards', () => {
    const h = makeHarness();
    h.down(1, 0);
    h.slideTo(1, 1);
    h.end('lostpointercapture', 1, 1);
    h.end('lostpointercapture', 1, 1); // browsers send this again after a real pointerup
    expect(h.releases.map(([lane]) => lane)).toEqual([0, 1]);
    expect(h.input.isLaneDown(1)).toBe(false);
  });

  it('ignores movement while input is disabled and stays unstuck', () => {
    const h = makeHarness();
    h.down(1, 1);
    h.input.setEnabled(false); // pause releases everything
    expect(h.input.pressedLanes()).toEqual([]);
    h.move(1, laneX(3));
    expect(h.presses).toEqual([[1, 0]]);
    expect(h.input.isLaneDown(3)).toBe(false);

    h.input.setEnabled(true);
    h.down(1, 3);
    expect(h.presses.map(([lane]) => lane)).toEqual([1, 3]);
  });

  it('leaves no lane behind when the tab is hidden mid-slide', () => {
    const h = makeHarness();
    h.down(1, 0);
    h.slideTo(1, 5);
    expect(h.input.isLaneDown(5)).toBe(true);

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });

    expect(h.input.pressedLanes()).toEqual([]);
    expect(h.input.activePointers).toBe(0);
    h.move(1, laneX(2)); // the stale finger must not press anything
    expect(h.input.isLaneDown(2)).toBe(false);
  });
});

describe('slide timing and judgment', () => {
  it('timestamps every transition from the audio clock, with nothing deferred', () => {
    const h = makeHarness();
    h.down(1, 0);
    h.clock.now = 1000.5;
    h.slideTo(1, 1);
    h.clock.now = 1012.25;
    h.slideTo(1, 2);
    h.end('pointerup', 1, 2);

    expect(h.presses).toEqual([
      [0, 0],
      [1, 1000.5],
      [2, 1012.25],
    ]);
    expect(h.releases).toEqual([
      [0, 1000.5],
      [1, 1012.25],
      [2, 1012.25],
    ]);
  });
});

// ------------------------------------------------------------------ engine ---

class FakeClock implements SongClock {
  now = 0;
  getSongTimeMs(): number {
    return this.now;
  }
}

function chartOf(notes: ChartNote[]): Beatmap {
  return prepareBeatmap({
    schemaVersion: BEATMAP_SCHEMA_VERSION,
    songId: 'slide-test',
    title: 'Slide Test',
    difficulty: 'normal',
    bpm: 120,
    offsetMs: 0,
    generator: { name: 'test', version: '1.0.0', seed: 1 },
    notes,
  });
}

describe('slides routed through the existing judgment engine', () => {
  it('scores a slide as a run of taps and breaks a hold that is slid away from', () => {
    const h = makeHarness();
    const clock = new FakeClock();
    const engine = new GameEngine({
      chart: chartOf([
        { timeMs: 1000, lane: 0, type: 'tap' },
        { timeMs: 1150, lane: 1, type: 'tap' },
        { timeMs: 1300, lane: 2, type: 'tap' },
        { timeMs: 2000, lane: 4, type: 'hold', durationMs: 1000 },
        { timeMs: 2200, lane: 5, type: 'tap' },
      ]),
      clock,
    });
    engine.begin();

    const events: GameEvent[] = [];
    const input = new InputManager({
      nowMs: () => clock.now,
      onLanePress: (lane, timeMs) => events.push(...engine.pressLane(lane, timeMs)),
      onLaneRelease: (lane, timeMs) => events.push(...engine.releaseLane(lane, timeMs)),
      onTogglePause: () => undefined,
      onRestart: () => undefined,
      onFocusLost: () => undefined,
    });
    input.attachPointer(h.surface);
    input.setEnabled(true);

    // One finger, never lifted, sweeping through three lanes on the beat.
    clock.now = 1000;
    h.down(1, 0);
    clock.now = 1150;
    h.slideTo(1, 1);
    clock.now = 1300;
    h.slideTo(1, 2);

    // A hold pressed on its head, then slid away from 200 ms in (the tail is at 3000).
    clock.now = 2000;
    input.pointerUp(1);
    h.down(2, 4);
    clock.now = 2200;
    h.slideTo(2, 5); // breaks the hold and presses the tap that is landing right now

    clock.now = 3100;
    events.push(...engine.update(clock.now));

    const judgments = events.filter(
      (event): event is Extract<GameEvent, { type: 'judgment' }> => event.type === 'judgment',
    );
    expect(judgments.map((event) => [event.lane, event.judgment])).toEqual([
      [0, 'perfect'],
      [1, 'perfect'],
      [2, 'perfect'],
      [4, 'perfect'],
      [5, 'perfect'],
    ]);
    expect(events.filter((event) => event.type === 'hold-broken')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'hold-complete')).toHaveLength(0);
    expect(engine.scoreSnapshot.counts).toMatchObject({ perfect: 5, good: 0, bad: 0, miss: 0 });
    // Sliding off the hold cost the combo (1..4 built by the head and the taps, then reset), and
    // the tap the finger arrived on started a new one — the phase 1 penalties, unchanged.
    expect(engine.scoreSnapshot.maxCombo).toBe(4);
    expect(engine.scoreSnapshot.combo).toBe(1);
    expect(engine.scoreSnapshot.holdBroken).toBe(1);
    expect(input.pressedLanes()).toEqual([5]);
    input.detachPointer();
  });

  it('produces no judgment of its own for a slide that crosses lanes with no notes', () => {
    const h = makeHarness();
    const clock = new FakeClock();
    const engine = new GameEngine({ chart: chartOf([{ timeMs: 5000, lane: 6, type: 'tap' }]), clock });
    engine.begin();

    const events: GameEvent[] = [];
    const input = new InputManager({
      nowMs: () => clock.now,
      onLanePress: (lane, timeMs) => events.push(...engine.pressLane(lane, timeMs)),
      onLaneRelease: (lane, timeMs) => events.push(...engine.releaseLane(lane, timeMs)),
      onTogglePause: () => undefined,
      onRestart: () => undefined,
      onFocusLost: () => undefined,
    });
    input.attachPointer(h.surface);
    input.setEnabled(true);

    clock.now = 100;
    h.down(1, 0);
    for (const lane of [1, 2, 3, 4, 5]) h.slideTo(1, lane);
    input.pointerUp(1);

    expect(events.filter((event) => event.type === 'judgment')).toEqual([]);
    expect(engine.scoreSnapshot.counts.miss).toBe(0); // the chart note is still pending
    expect(engine.pendingNotes).toBe(1);
    // ... but every crossing was counted as a stray press, like any other empty-lane tap.
    expect(engine.scoreSnapshot.strayPresses).toBe(6);
    input.detachPointer();
  });
});
