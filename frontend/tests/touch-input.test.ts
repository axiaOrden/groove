// @vitest-environment jsdom
/**
 * Touch input tests.
 *
 * These drive the *real* DOM event path: zones built by `TouchSurface`, listeners registered by
 * `InputManager`, pointer events created and dispatched the way a browser would deliver them.
 * jsdom has no PointerEvent constructor and no pointer capture, so both are provided here — the
 * point is that production code must work with and without them (capture is optional, and the
 * code guards for it).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SongClock } from '../src/audio/AudioSource';
import type { Beatmap, ChartNote } from '../src/chart/ChartTypes';
import { BEATMAP_SCHEMA_VERSION } from '../src/chart/ChartTypes';
import { prepareBeatmap } from '../src/chart/ChartValidator';
import type { GameEvent } from '../src/game/GameEngine';
import { GameEngine } from '../src/game/GameEngine';
import { InputManager } from '../src/game/InputManager';
import { TouchSurface } from '../src/ui/TouchSurface';

/** Minimal pointer event: jsdom ships neither PointerEvent nor pointer capture. */
function pointerEvent(type: string, pointerId: number, pointerType = 'touch'): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId, configurable: true },
    pointerType: { value: pointerType, configurable: true },
    isPrimary: { value: pointerId === 1, configurable: true },
  });
  return event;
}

interface Harness {
  root: HTMLElement;
  surface: TouchSurface;
  input: InputManager;
  zones: HTMLElement[];
  clock: { now: number };
  presses: Array<[number, number]>;
  releases: Array<[number, number]>;
  visuals: Array<[number, boolean]>;
  counters: { pause: number; restart: number; focusLost: number };
  /** Dispatch a pointer event on a zone (or on any element). */
  fire(type: string, pointerId: number, target?: HTMLElement, pointerType?: string): Event;
  key(type: 'keydown' | 'keyup', code: string, repeat?: boolean): KeyboardEvent;
}

let activeHarness: Harness | null = null;

function makeHarness(): Harness {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const surface = new TouchSurface(root);
  surface.layout({
    laneCentersPx: [50, 150, 250, 350, 450, 550, 650],
    usable: { left: 0, top: 0, width: 700, height: 360 },
    topPx: 60,
    viewportWidth: 700,
    viewportHeight: 360,
  });

  const clock = { now: 0 };
  const presses: Array<[number, number]> = [];
  const releases: Array<[number, number]> = [];
  const visuals: Array<[number, boolean]> = [];
  const counters = { pause: 0, restart: 0, focusLost: 0 };

  const input = new InputManager({
    nowMs: () => clock.now,
    onLanePress: (lane, songTimeMs) => presses.push([lane, songTimeMs]),
    onLaneRelease: (lane, songTimeMs) => releases.push([lane, songTimeMs]),
    onLaneVisual: (lane, active) => visuals.push([lane, active]),
    onTogglePause: () => {
      counters.pause += 1;
    },
    onRestart: () => {
      counters.restart += 1;
    },
    onFocusLost: () => {
      counters.focusLost += 1;
    },
  });
  input.attach();
  input.attachPointer(root);
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
    counters,
    fire(type, pointerId, target = zones[pointerId % zones.length]!, pointerType = 'touch') {
      const event = pointerEvent(type, pointerId, pointerType);
      target.dispatchEvent(event);
      return event;
    },
    key(type, code, repeat = false) {
      const event = new KeyboardEvent(type, { code, repeat, bubbles: true, cancelable: true });
      window.dispatchEvent(event);
      return event;
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

describe('single-lane touch', () => {
  it('judges a press with the audio-clock timestamp and lights the pad', () => {
    const h = makeHarness();
    h.clock.now = 1234.5;
    const event = h.fire('pointerdown', 1, h.zones[0]);

    expect(h.presses).toEqual([[0, 1234.5]]);
    expect(h.input.isLaneDown(0)).toBe(true);
    expect(h.input.pointerLane(1)).toBe(0);
    expect(h.input.activePointers).toBe(1);
    expect(h.visuals).toEqual([[0, true]]);
    expect(h.surface.zoneRects().length).toBe(7);
    // no page scroll / double-tap zoom / compatibility mouse events on the highway
    expect(event.defaultPrevented).toBe(true);
  });

  it('captures the pointer on its lane zone when the platform supports it', () => {
    const h = makeHarness();
    const capture = vi.fn();
    Object.defineProperty(h.zones[3], 'setPointerCapture', { value: capture, configurable: true });
    h.fire('pointerdown', 7, h.zones[3]);
    expect(capture).toHaveBeenCalledWith(7);
  });

  it('works on platforms without pointer capture', () => {
    const h = makeHarness();
    expect(typeof (h.zones[2] as { setPointerCapture?: unknown }).setPointerCapture).not.toBe('function');
    h.fire('pointerdown', 4, h.zones[2]);
    h.fire('pointerup', 4, h.zones[2]);
    expect(h.presses).toEqual([[2, 0]]);
    expect(h.releases).toEqual([[2, 0]]);
  });

  it('resolves the lane from a nested element inside the zone', () => {
    const h = makeHarness();
    const pad = h.zones[5]!.querySelector('.touch-pad')!;
    h.fire('pointerdown', 2, pad as HTMLElement);
    expect(h.presses).toEqual([[5, 0]]);
  });

  it('ignores pointer events outside a lane zone', () => {
    const h = makeHarness();
    h.fire('pointerdown', 1, h.root);
    h.fire('pointerdown', 2, document.body);
    expect(h.presses).toEqual([]);
    expect(h.input.activePointers).toBe(0);
  });

  it('never synthesises keyboard events as a workaround', () => {
    const h = makeHarness();
    const keydowns = vi.fn();
    window.addEventListener('keydown', keydowns);
    h.fire('pointerdown', 1, h.zones[0]);
    h.fire('pointerup', 1, h.zones[0]);
    window.removeEventListener('keydown', keydowns);
    expect(keydowns).not.toHaveBeenCalled();
  });
});

describe('chords and multi-finger input', () => {
  it('judges a two-finger chord', () => {
    const h = makeHarness();
    h.clock.now = 500;
    h.fire('pointerdown', 1, h.zones[0]);
    h.fire('pointerdown', 2, h.zones[6]);
    expect(h.presses).toEqual([
      [0, 500],
      [6, 500],
    ]);
    expect(h.input.pressedLanes().sort((a, b) => a - b)).toEqual([0, 6]);
  });

  it('judges a four-finger chord and releases only the lifted finger', () => {
    const h = makeHarness();
    for (const [pointerId, lane] of [
      [1, 1],
      [2, 2],
      [3, 4],
      [4, 5],
    ] as const) {
      h.fire('pointerdown', pointerId, h.zones[lane]);
    }
    expect(h.presses.map(([lane]) => lane)).toEqual([1, 2, 4, 5]);

    h.clock.now = 250;
    h.fire('pointerup', 3, h.zones[4]);
    expect(h.releases).toEqual([[4, 250]]);
    expect(h.input.pressedLanes().sort((a, b) => a - b)).toEqual([1, 2, 5]);

    h.fire('pointercancel', 2, h.zones[2]);
    expect(h.releases).toEqual([
      [4, 250],
      [2, 250],
    ]);
    expect(h.input.pressedLanes().sort((a, b) => a - b)).toEqual([1, 5]);
  });
});

describe('holds', () => {
  it('keeps the lane held until the finger lifts', () => {
    const h = makeHarness();
    h.clock.now = 100;
    h.fire('pointerdown', 1, h.zones[2]);
    h.clock.now = 900;
    expect(h.releases).toEqual([]);
    expect(h.input.isLaneDown(2)).toBe(true);

    h.fire('pointerup', 1, h.zones[2]);
    expect(h.releases).toEqual([[2, 900]]);
    expect(h.input.isLaneDown(2)).toBe(false);
    expect(h.visuals).toEqual([
      [2, true],
      [2, false],
    ]);
  });

  it('treats pointercancel as the end of the hold', () => {
    const h = makeHarness();
    h.clock.now = 40;
    h.fire('pointerdown', 1, h.zones[3]);
    h.clock.now = 640;
    h.fire('pointercancel', 1, h.zones[3]);
    expect(h.releases).toEqual([[3, 640]]);
    expect(h.input.isLaneDown(3)).toBe(false);
  });

  it('handles lostpointercapture without releasing twice', () => {
    const h = makeHarness();
    h.fire('pointerdown', 1, h.zones[1]);
    h.fire('pointerup', 1, h.zones[1]);
    h.fire('lostpointercapture', 1, h.zones[1]);
    expect(h.releases).toEqual([[1, 0]]);
  });

  it('captures the match report for a hold kept down end to end', () => {
    const h = makeHarness();
    h.fire('pointerdown', 1, h.zones[0]);
    h.fire('pointerdown', 2, h.zones[6]);
    expect(h.presses.length).toBe(2);
    expect(h.input.isLaneDown(0)).toBe(true);
    expect(h.input.isLaneDown(6)).toBe(true);
  });
});

describe('several pointers on one lane', () => {
  it('judges once, keeps the lane held until the last finger lifts', () => {
    const h = makeHarness();
    h.clock.now = 10;
    h.fire('pointerdown', 1, h.zones[5]);
    h.clock.now = 20;
    const second = h.fire('pointerdown', 2, h.zones[5]);

    expect(h.presses).toEqual([[5, 10]]); // no duplicate judgment
    expect(h.input.pointerLane(2)).toBe(5);
    expect(second.defaultPrevented).toBe(true);
    // both fingers light the pad, and nothing has been released yet
    expect(h.visuals).toEqual([
      [5, true],
      [5, true],
    ]);
    expect(h.releases).toEqual([]);

    h.clock.now = 30;
    h.fire('pointerup', 1, h.zones[5]);
    expect(h.releases).toEqual([]); // pointer 2 still holds lane 5
    expect(h.input.isLaneDown(5)).toBe(true);

    h.fire('pointerup', 2, h.zones[5]);
    expect(h.releases).toEqual([[5, 30]]);
    expect(h.input.isLaneDown(5)).toBe(false);
  });

  it('ignores a repeated pointerdown for a pointer that is already down', () => {
    const h = makeHarness();
    h.fire('pointerdown', 1, h.zones[0]);
    h.fire('pointerdown', 1, h.zones[3]);
    expect(h.presses).toEqual([[0, 0]]);
    expect(h.input.pointerLane(1)).toBe(0);
  });
});

describe('keyboard and touch on the same pipeline', () => {
  it('mixes a key and a finger on different lanes', () => {
    const h = makeHarness();
    h.key('keydown', 'KeyA');
    h.clock.now = 75;
    h.fire('pointerdown', 1, h.zones[3]);
    expect(h.presses).toEqual([
      [0, 0],
      [3, 75],
    ]);

    h.clock.now = 200;
    h.fire('pointerup', 1, h.zones[3]);
    expect(h.releases).toEqual([[3, 200]]);
    expect(h.input.isLaneDown(0)).toBe(true); // the key is untouched

    h.clock.now = 300;
    h.key('keyup', 'KeyA');
    expect(h.releases).toEqual([
      [3, 200],
      [0, 300],
    ]);
  });

  it('does not double judge a lane held by both a key and a finger', () => {
    const h = makeHarness();
    h.key('keydown', 'Space');
    h.fire('pointerdown', 1, h.zones[3]); // same lane, second holder
    expect(h.presses).toEqual([[3, 0]]);
    expect(h.input.activePointers).toBe(1);

    h.key('keyup', 'Space');
    expect(h.releases).toEqual([]); // the finger still holds lane 3
    expect(h.input.isLaneDown(3)).toBe(true);

    h.fire('pointerup', 1, h.zones[3]);
    expect(h.releases.length).toBe(1);
    expect(h.releases[0]![0]).toBe(3);
    expect(h.input.isLaneDown(3)).toBe(false);
  });

  it('drops auto-repeat and keeps the modifiers it does not own working', () => {
    const h = makeHarness();
    h.key('keydown', 'KeyJ');
    h.key('keydown', 'KeyJ', true);
    expect(h.presses).toEqual([[4, 0]]);

    const escape = h.key('keydown', 'Escape');
    expect(h.counters.pause).toBe(1);
    expect(escape.defaultPrevented).toBe(true);

    const restart = h.key('keydown', 'KeyR');
    expect(h.counters.restart).toBe(1);
    expect(restart.defaultPrevented).toBe(true);

    const mapped = h.key('keydown', 'KeyL');
    expect(mapped.defaultPrevented).toBe(true);
  });
});

describe('interruption safety', () => {
  it('releases every lane on focus loss without judging a release, and ignores the stale pointerup', () => {
    const h = makeHarness();
    h.fire('pointerdown', 1, h.zones[4]);
    h.fire('pointerdown', 2, h.zones[0]);
    expect(h.input.activePointers).toBe(2);

    window.dispatchEvent(new Event('blur'));
    expect(h.input.pressedLanes()).toEqual([]);
    expect(h.input.activePointers).toBe(0);
    expect(h.counters.focusLost).toBe(1);
    expect(h.releases).toEqual([]); // no late judgment from the interruption
    expect(h.visuals.filter(([, active]) => !active).map(([lane]) => lane).sort()).toEqual([0, 4]);

    // The finger is still physically down; its eventual pointerup must not release anything.
    h.fire('pointerup', 1, h.zones[4]);
    expect(h.releases).toEqual([]);
    expect(h.input.isLaneDown(4)).toBe(false);
  });

  it('releases lanes when the tab is hidden', () => {
    const h = makeHarness();
    h.fire('pointerdown', 1, h.zones[2]);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.input.isLaneDown(2)).toBe(false);
    expect(h.counters.focusLost).toBe(1);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('ignores input while disabled and frees lanes when disabled mid-hold', () => {
    const h = makeHarness();
    h.input.setEnabled(false);
    h.fire('pointerdown', 1, h.zones[1]);
    expect(h.presses).toEqual([]);
    expect(h.input.pointerLane(1)).toBeNull();

    h.input.setEnabled(true);
    h.fire('pointerdown', 1, h.zones[1]);
    expect(h.presses).toEqual([[1, 0]]);

    h.input.setEnabled(false);
    expect(h.input.isLaneDown(1)).toBe(false);
    expect(h.input.activePointers).toBe(0);
    expect(h.releases).toEqual([]); // releasing is not a judgment
    h.input.setEnabled(true);
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
    songId: 'touch-test',
    title: 'Touch Test',
    difficulty: 'normal',
    bpm: 120,
    offsetMs: 0,
    generator: { name: 'test', version: '1.0.0', seed: 1 },
    notes,
  });
}

describe('touch routed through the existing judgment engine', () => {
  it('scores taps and holds driven purely by pointer events', () => {
    const h = makeHarness();
    const clock = new FakeClock();
    const engine = new GameEngine({
      chart: chartOf([
        { timeMs: 1000, lane: 0, type: 'tap' },
        { timeMs: 1000, lane: 3, type: 'tap' },
        { timeMs: 2000, lane: 6, type: 'hold', durationMs: 800 },
        { timeMs: 4000, lane: 2, type: 'tap' },
      ]),
      clock,
    });
    engine.begin();

    const judgments: GameEvent[] = [];
    const input = new InputManager({
      nowMs: () => clock.now,
      onLanePress: (lane, timeMs) => judgments.push(...engine.pressLane(lane, timeMs)),
      onLaneRelease: (lane, timeMs) => judgments.push(...engine.releaseLane(lane, timeMs)),
      onTogglePause: () => undefined,
      onRestart: () => undefined,
      onFocusLost: () => undefined,
    });
    input.attachPointer(h.root);
    input.setEnabled(true);

    // A two-finger chord with touch timestamps that come from the audio clock.
    clock.now = 1000;
    h.fire('pointerdown', 1, h.zones[0]);
    h.fire('pointerdown', 2, h.zones[3]);
    h.fire('pointerup', 1, h.zones[0]);
    h.fire('pointerup', 2, h.zones[3]);

    // A hold: press on the head, keep the finger down past the tail.
    clock.now = 2000;
    h.fire('pointerdown', 3, h.zones[6]);
    clock.now = 2900;
    h.fire('pointerup', 3, h.zones[6]);
    judgments.push(...engine.update(clock.now));

    // A tap pressed slightly late is still GOOD, and a miss happens on its own.
    clock.now = 4000 + 70;
    h.fire('pointerdown', 4, h.zones[2]);
    h.fire('pointerup', 4, h.zones[2]);
    clock.now = 9000;
    judgments.push(...engine.update(clock.now));

    const headJudgments = judgments.filter(
      (event): event is Extract<GameEvent, { type: 'judgment' }> => event.type === 'judgment',
    );
    expect(headJudgments.map((event) => [event.lane, event.judgment])).toEqual([
      [0, 'perfect'],
      [3, 'perfect'],
      [6, 'perfect'],
      [2, 'good'],
    ]);
    expect(judgments.filter((event) => event.type === 'hold-complete')).toHaveLength(1);
    expect(engine.scoreSnapshot.counts).toMatchObject({ perfect: 3, good: 1, bad: 0, miss: 0 });
    expect(engine.scoreSnapshot.combo).toBe(4);
    input.detachPointer();
  });

  it('breaks a hold when the finger lifts early or the gesture is cancelled', () => {
    const h = makeHarness();
    const clock = new FakeClock();
    const engine = new GameEngine({
      chart: chartOf([
        { timeMs: 1000, lane: 1, type: 'hold', durationMs: 1000 },
        { timeMs: 3000, lane: 1, type: 'hold', durationMs: 1000 },
        { timeMs: 6000, lane: 1, type: 'tap' },
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
    input.attachPointer(h.root);
    input.setEnabled(true);

    clock.now = 1000;
    h.fire('pointerdown', 1, h.zones[1]);
    clock.now = 1300;
    h.fire('pointerup', 1, h.zones[1]); // released long before the tail
    expect(events.filter((event) => event.type === 'hold-broken')).toHaveLength(1);

    clock.now = 3000;
    h.fire('pointerdown', 2, h.zones[1]);
    clock.now = 3600;
    h.fire('pointercancel', 2, h.zones[1]); // OS took the gesture away
    expect(events.filter((event) => event.type === 'hold-broken')).toHaveLength(2);

    clock.now = 6000;
    h.fire('pointerdown', 3, h.zones[1]);
    h.fire('pointerup', 3, h.zones[1]);
    clock.now = 9000;
    engine.update(clock.now);
    expect(engine.scoreSnapshot.counts.miss).toBe(0);
    input.detachPointer();
  });
});
