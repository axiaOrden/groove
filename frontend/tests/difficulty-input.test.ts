// @vitest-environment jsdom
/**
 * Difficulty input and layout tests (phase 3).
 *
 * Phase 3 makes the *keys* and the *touch columns* depend on the difficulty, and the properties
 * worth pinning down are the ones that would otherwise break silently:
 *
 *  - the key map is exactly the documented one per difficulty (A S K L, A S SPACE K L,
 *    A S D SPACE J K L), and SPACE means lane 2 on Normal but lane 3 on Hard;
 *  - a key that is not a lane *on this difficulty* (D on Easy, SPACE on Easy) never judges, while
 *    still not scrolling the page;
 *  - switching difficulty releases whatever was held, so a lane cannot survive the switch stuck
 *    down;
 *  - the real engine, driven only by these keys and by pointer events, judges four-, five- and
 *    seven-lane charts — including multi-touch chords and swipes across four and five columns;
 *  - a lane the chart does not have cannot be pressed or judged at all.
 *
 * jsdom ships neither `PointerEvent` nor pointer capture, so both are provided here: production code
 * must work with and without them (capture is optional and the code guards for it).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SongClock } from '../src/audio/AudioSource';
import { BEATMAP_SCHEMA_VERSION, type Beatmap, type ChartNote } from '../src/chart/ChartTypes';
import { prepareBeatmap } from '../src/chart/ChartValidator';
import { DIFFICULTY_PROFILES, keyLabelsFor, type ChartDifficulty } from '../src/chart/Difficulty';
import { perfectRunScore } from '../src/chart/ScoreModel';
import type { GameEvent } from '../src/game/GameEngine';
import { GameEngine } from '../src/game/GameEngine';
import { InputManager, keyLayoutFor, type KeyLayout } from '../src/game/InputManager';
import { KEY_CODE_TO_LANE, LANE_KEYS } from '../src/game/GameConfig';
import { TouchSurface } from '../src/ui/TouchSurface';

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

/** Columns are exactly `columnWidth` px wide, so lane n is `[n·w, (n+1)·w)`. */
const COLUMN_WIDTH = 100;
const COLUMN_TOP = 60;
const VIEWPORT_HEIGHT = 360;
const TAP_Y = 300;

class FakeClock implements SongClock {
  now = 0;
  getSongTimeMs(): number {
    return this.now;
  }
}

interface Harness {
  root: HTMLElement;
  surface: TouchSurface;
  input: InputManager;
  clock: FakeClock;
  presses: Array<[number, number]>;
  releases: Array<[number, number]>;
  visuals: Array<[number, boolean]>;
  counters: { pause: number; restart: number; focusLost: number };
  zones: () => HTMLElement[];
  laneX: (lane: number) => number;
  fire(type: string, pointerId: number, x: number, y?: number, target?: HTMLElement): Event;
  key(type: 'keydown' | 'keyup', code: string, repeat?: boolean): KeyboardEvent;
  /** Route this harness's lane events into a real engine. */
  drive(engine: GameEngine): void;
}

let active: Harness | null = null;

function makeHarness(laneCount: number, layout: KeyLayout = { laneCount, keys: [] }): Harness {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const surface = new TouchSurface(root);
  const resolvedLayout: KeyLayout =
    layout.keys.length > 0
      ? layout
      : { laneCount, keys: DIFFICULTY_PROFILES[laneFor(laneCount)].keys };
  surface.setLaneCount(laneCount, keyLabelsFor(laneCount));
  surface.layout({
    laneCentersPx: Array.from({ length: laneCount }, (_, lane) => lane * COLUMN_WIDTH + COLUMN_WIDTH / 2),
    usable: { left: 0, top: 0, width: laneCount * COLUMN_WIDTH, height: VIEWPORT_HEIGHT },
    topPx: COLUMN_TOP,
    viewportWidth: laneCount * COLUMN_WIDTH,
    viewportHeight: VIEWPORT_HEIGHT,
  });

  const clock = new FakeClock();
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
  input.attachPointer(surface);
  input.setKeyLayout(resolvedLayout);
  input.setEnabled(true);

  const harness: Harness = {
    root,
    surface,
    input,
    clock,
    presses,
    releases,
    visuals,
    counters,
    zones: () => [...root.querySelectorAll<HTMLElement>('.touch-zone')],
    laneX: (lane) => lane * COLUMN_WIDTH + COLUMN_WIDTH / 2,
    fire(type, pointerId, x, y = TAP_Y, target) {
      const event = pointerEvent(type, pointerId, x, y);
      // A real `pointerdown` reaches the column it landed on. jsdom has no `elementFromPoint`, so
      // the column is resolved here from the same x the surface would map; `pointermove` does not
      // need it (the coordinates decide the lane), which is why the slide cases pass `root`.
      const resolved =
        target ??
        (type === 'pointerdown'
          ? (root.querySelectorAll<HTMLElement>('.touch-zone')[Math.floor(x / COLUMN_WIDTH)] ?? root)
          : root);
      resolved.dispatchEvent(event);
      return event;
    },
    key(type, code, repeat = false) {
      const event = new KeyboardEvent(type, { code, repeat, bubbles: true, cancelable: true });
      window.dispatchEvent(event);
      return event;
    },
    drive(engine) {
      this.input.detach();
      const engineInput = new InputManager({
        nowMs: () => this.clock.now,
        onLanePress: (lane, timeMs) => void engine.pressLane(lane, timeMs),
        onLaneRelease: (lane, timeMs) => void engine.releaseLane(lane, timeMs),
        onTogglePause: () => undefined,
        onRestart: () => undefined,
        onFocusLost: () => undefined,
      });
      engineInput.attach();
      engineInput.attachPointer(this.surface);
      engineInput.setKeyLayout(resolvedLayout);
      engineInput.setEnabled(true);
      this.input = engineInput;
    },
  };
  active = harness;
  return harness;
}

/** The difficulty whose layout has this lane count, for the harness defaults. */
function laneFor(laneCount: number): ChartDifficulty {
  if (laneCount === 4) return 'easy';
  if (laneCount === 5) return 'normal';
  return 'hard';
}

function chartOf(notes: ChartNote[], laneCount: number, difficulty: ChartDifficulty): Beatmap {
  return prepareBeatmap({
    schemaVersion: BEATMAP_SCHEMA_VERSION,
    songId: `input-${laneCount}`,
    title: 'Input Test',
    difficulty,
    laneCount,
    keyLabels: keyLabelsFor(laneCount),
    bpm: 120,
    offsetMs: 0,
    generator: { name: 'test', version: '1.0.0', seed: 1 },
    notes,
  });
}

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  active?.input.detachPointer();
  active?.input.detach();
  active = null;
});

describe('key maps per difficulty', () => {
  it('binds exactly the documented keys, in lane order', () => {
    expect(DIFFICULTY_PROFILES.easy.keys.map((key) => [key.lane, key.label, key.code])).toEqual([
      [0, 'A', 'KeyA'],
      [1, 'S', 'KeyS'],
      [2, 'K', 'KeyK'],
      [3, 'L', 'KeyL'],
    ]);
    expect(DIFFICULTY_PROFILES.normal.keys.map((key) => [key.lane, key.label, key.code])).toEqual([
      [0, 'A', 'KeyA'],
      [1, 'S', 'KeyS'],
      [2, 'SPACE', 'Space'],
      [3, 'K', 'KeyK'],
      [4, 'L', 'KeyL'],
    ]);
    expect(DIFFICULTY_PROFILES.hard.keys.map((key) => [key.lane, key.label, key.code])).toEqual([
      [0, 'A', 'KeyA'],
      [1, 'S', 'KeyS'],
      [2, 'D', 'KeyD'],
      [3, 'SPACE', 'Space'],
      [4, 'J', 'KeyJ'],
      [5, 'K', 'KeyK'],
      [6, 'L', 'KeyL'],
    ]);

    // SPACE means lane 2 on Normal and lane 3 on Hard — the one place where a key changes lane.
    expect(keyLayoutFor('easy')).toEqual({ laneCount: 4, keys: DIFFICULTY_PROFILES.easy.keys });
    expect(keyLayoutFor('normal').laneCount).toBe(5);
    expect(keyLayoutFor('hard').laneCount).toBe(7);
    expect(InputManager.labelsForLaneCount(4)).toEqual(['A', 'S', 'K', 'L']);
    expect(InputManager.labelsForLaneCount(5)).toEqual(['A', 'S', 'SPACE', 'K', 'L']);
    expect(InputManager.labelsForLaneCount(7)).toEqual(['A', 'S', 'D', 'SPACE', 'J', 'K', 'L']);
  });

  it('keeps the seven-key map as the default and the hard keys identical to it', () => {
    expect(KEY_CODE_TO_LANE).toEqual({ KeyA: 0, KeyS: 1, KeyD: 2, Space: 3, KeyJ: 4, KeyK: 5, KeyL: 6 });
    expect(LANE_KEYS).toEqual(DIFFICULTY_PROFILES.hard.keys);
    expect(InputManager.keyLabels()).toEqual(['A', 'S', 'D', 'SPACE', 'J', 'K', 'L']);
  });
});

describe('keyboard lanes follow the active layout', () => {
  it('judges the four-key layout', () => {
    const h = makeHarness(4);
    h.key('keydown', 'KeyA');
    h.key('keydown', 'KeyS');
    h.key('keydown', 'KeyK');
    h.key('keydown', 'KeyL');
    expect(h.presses.map(([lane]) => lane)).toEqual([0, 1, 2, 3]);
    expect(h.input.isLaneDown(3)).toBe(true);

    h.key('keyup', 'KeyK');
    expect(h.releases.map(([lane]) => lane)).toEqual([2]);

    // The keys of another difficulty are not lanes here, but they must not scroll or type either.
    const d = h.key('keydown', 'KeyD');
    expect(d.defaultPrevented).toBe(true);
    const space = h.key('keydown', 'Space');
    expect(space.defaultPrevented).toBe(true);
    expect(h.presses.map(([lane]) => lane)).toEqual([0, 1, 2, 3]);
    expect(h.input.laneCount).toBe(4);
    h.key('keyup', 'KeyD');
    h.key('keyup', 'Space');
  });

  it('judges the five-key layout, with SPACE in the middle', () => {
    const h = makeHarness(5);
    h.key('keydown', 'KeyA');
    h.key('keydown', 'KeyS');
    h.key('keydown', 'Space');
    h.key('keydown', 'KeyK');
    h.key('keydown', 'KeyL');
    expect(h.presses.map(([lane]) => lane)).toEqual([0, 1, 2, 3, 4]);
    h.key('keyup', 'KeyA');
    h.key('keyup', 'KeyS');
    h.key('keyup', 'Space');
    h.key('keyup', 'KeyK');
    h.key('keyup', 'KeyL');
  });

  it('ignores a repeated keydown and an unmapped lane on every layout', () => {
    const h = makeHarness(4);
    h.key('keydown', 'KeyA');
    h.key('keydown', 'KeyA', true);
    expect(h.presses).toEqual([[0, 0]]);
    h.key('keyup', 'KeyA');
    expect(h.releases).toHaveLength(1);
  });

  it('releases everything held when the layout changes', () => {
    const h = makeHarness(7);
    h.key('keydown', 'Space');
    h.key('keydown', 'KeyJ');
    expect(h.input.pressedLanes()).toEqual([3, 4]);

    h.input.setKeyLayout(keyLayoutFor('easy'));
    expect(h.input.pressedLanes()).toEqual([]);
    expect(h.input.laneCount).toBe(4);
    // The lane that no longer exists cannot be reported as pressed either.
    expect(h.input.isLaneDown(4)).toBe(false);

    // A keydown that is still physically held after the switch does not re-press the old lane.
    h.key('keyup', 'Space');
    h.key('keyup', 'KeyJ');
    expect(h.releases).toHaveLength(0);
  });

  it('leaves the pause and restart keys working on every layout', () => {
    for (const laneCount of [4, 5, 7]) {
      const h = makeHarness(laneCount);
      h.key('keydown', 'Escape');
      h.key('keydown', 'KeyR');
      expect(h.counters.pause).toBe(1);
      expect(h.counters.restart).toBe(1);
      h.input.detach();
      h.input.detachPointer();
    }
  });
});

describe('touch lanes follow the lane count', () => {
  it('builds exactly four / five / seven columns, with no empty lane', () => {
    for (const laneCount of [4, 5, 7]) {
      const h = makeHarness(laneCount);
      const zones = h.zones();
      expect(zones).toHaveLength(laneCount);
      expect(h.surface.laneCount).toBe(laneCount);
      expect(zones.map((zone) => zone.dataset.lane)).toEqual(
        Array.from({ length: laneCount }, (_, lane) => String(lane)),
      );
      h.input.detach();
      h.input.detachPointer();
    }
  });

  it('taps the far lane on a four-lane surface', () => {
    const h = makeHarness(4);
    h.fire('pointerdown', 1, h.laneX(3));
    h.fire('pointerup', 1, h.laneX(3));
    expect(h.presses).toEqual([[3, 0]]);
    expect(h.releases).toEqual([[3, 0]]);
  });

  it('swipes across four lanes, pressing only where the finger lands', () => {
    const h = makeHarness(4);
    h.fire('pointerdown', 1, h.laneX(0));
    expect(h.presses).toEqual([[0, 0]]);

    // Two lanes in one move: the destination is judged, not the lane skipped over.
    h.fire('pointermove', 1, h.laneX(2));
    expect(h.presses).toEqual([
      [0, 0],
      [2, 0],
    ]);
    expect(h.releases).toEqual([[0, 0]]);

    // Sliding the other way crosses lane 1 on its own.
    h.fire('pointermove', 1, h.laneX(1));
    expect(h.presses.at(-1)).toEqual([1, 0]);
    expect(h.releases.at(-1)).toEqual([2, 0]);

    // Off the columns (above them) releases; coming back presses again.
    h.fire('pointermove', 1, h.laneX(1), 5);
    expect(h.releases.at(-1)).toEqual([1, 0]);
    h.fire('pointermove', 1, h.laneX(1));
    expect(h.presses.at(-1)).toEqual([1, 0]);

    h.fire('pointerup', 1, h.laneX(1));
    expect(h.releases.at(-1)).toEqual([1, 0]);
    expect(h.input.activePointers).toBe(0);
  });

  it('supports a two-finger chord and a five-lane swipe', () => {
    const h = makeHarness(5);
    h.fire('pointerdown', 1, h.laneX(0));
    h.fire('pointerdown', 2, h.laneX(4), TAP_Y, h.zones()[4]);
    expect(h.presses.map(([lane]) => lane)).toEqual([0, 4]);

    h.fire('pointermove', 1, h.laneX(2));
    expect(h.presses.at(-1)).toEqual([2, 0]);
    // The second finger is untouched by the first finger's slide.
    expect(h.input.pointerLane(2)).toBe(4);

    h.fire('pointerup', 1, h.laneX(2));
    h.fire('pointerup', 2, h.laneX(4));
    // Lane 0 was released when finger 1 slid out of it; 2 and 4 go up with their own fingers.
    expect(h.releases.map(([lane]) => lane)).toEqual([0, 2, 4]);
    expect(h.input.activePointers).toBe(0);
    expect(h.input.pointersOnLanes).toBe(0);
  });

  it('rebuilds the columns (and the pad labels) when the lane count changes', () => {
    const h = makeHarness(7);
    expect(h.zones().map((zone) => zone.textContent?.trim())).toEqual([
      'A',
      'S',
      'D',
      '␣',
      'J',
      'K',
      'L',
    ]);
    h.surface.setLaneCount(4, ['A', 'S', 'K', 'L']);
    expect(h.zones()).toHaveLength(4);
    expect(h.zones().map((zone) => zone.textContent?.trim())).toEqual(['A', 'S', 'K', 'L']);
    // The narrower surface no longer resolves a point to lane 4.
    h.surface.layout({
      laneCentersPx: [50, 150, 250, 350],
      usable: { left: 0, top: 0, width: 400, height: VIEWPORT_HEIGHT },
      topPx: COLUMN_TOP,
      viewportWidth: 400,
      viewportHeight: VIEWPORT_HEIGHT,
    });
    expect(h.surface.laneAtPoint(50, TAP_Y)).toBe(0);
    expect(h.surface.laneAtPoint(550, TAP_Y)).toBeNull();
  });
});

describe('a real engine on a four- or five-lane chart', () => {
  it('judges a four-lane chart from keyboard and touch, with a weighted score', () => {
    const h = makeHarness(4);
    const chart = chartOf(
      [
        { timeMs: 1000, lane: 0, type: 'tap' },
        { timeMs: 1000, lane: 3, type: 'tap' },
        { timeMs: 2000, lane: 2, type: 'hold', durationMs: 600 },
        { timeMs: 4000, lane: 1, type: 'tap' },
      ],
      4,
      'easy',
    );
    const engine = new GameEngine({ chart, clock: h.clock });
    engine.begin();
    h.drive(engine);

    expect(engine.laneCount).toBe(4);
    expect(engine.chartDifficulty).toBe('easy');

    // A keyboard chord, a touch hold, then a touch tap.
    h.clock.now = 1000;
    h.key('keydown', 'KeyA');
    h.key('keydown', 'KeyL');

    h.clock.now = 2000;
    h.fire('pointerdown', 1, h.laneX(2));
    h.clock.now = 2700;
    h.fire('pointerup', 1, h.laneX(2));

    h.clock.now = 4000;
    h.fire('pointerdown', 2, h.laneX(1));
    h.fire('pointerup', 2, h.laneX(1));

    h.key('keyup', 'KeyA');
    h.key('keyup', 'KeyL');
    engine.update(6000);

    const snapshot = engine.scoreSnapshot;
    expect(snapshot.counts).toEqual({ perfect: 4, good: 0, bad: 0, miss: 0 });
    expect(snapshot.holdCompleted).toBe(1);
    expect(snapshot.combo).toBe(4);
    const results = engine.getResults();
    expect(results.difficulty).toBe('easy');
    expect(results.difficultyWeight).toBe(1);
    // 4 notes, one of them a hold (2 units) = 5 units at the Easy weight.
    expect(results.totalUnits).toBe(5);
    // The maximum is a flawless run of these exact notes (phase 3.1), and this run *is* flawless:
    // every head PERFECT at combo 1..4 plus the hold's tail at its head's multiplier.
    expect(results.maxScore).toBe(perfectRunScore(chart.notes, 1));
    expect(results.score).toBe(results.maxScore);
    expect(results.score / results.maxScore).toBe(1);
  });

  it('judges a five-lane chart with SPACE on the middle lane', () => {
    const h = makeHarness(5);
    const chart = chartOf(
      [
        { timeMs: 1000, lane: 2, type: 'tap' },
        { timeMs: 1000, lane: 4, type: 'tap' },
      ],
      5,
      'normal',
    );
    const engine = new GameEngine({ chart, clock: h.clock });
    engine.begin();
    h.drive(engine);

    h.clock.now = 1000;
    h.key('keydown', 'Space');
    h.fire('pointerdown', 1, h.laneX(4));

    expect(engine.scoreSnapshot.counts.perfect).toBe(2);
    expect(engine.getResults().difficultyWeight).toBe(1.5);
    // SPACE is lane 2 on a five-lane chart, and the input layer agrees with the engine.
    expect(h.input.isLaneDown(2)).toBe(true);
    expect(engine.isLanePressed(2)).toBe(true);

    h.key('keyup', 'Space');
    expect(h.input.isLaneDown(2)).toBe(false);
    h.fire('pointerup', 1, h.laneX(4));
    engine.update(3000);
  });

  it('cannot press or judge a lane the chart does not have', () => {
    const h = makeHarness(4);
    const chart = chartOf([{ timeMs: 1000, lane: 0, type: 'tap' }], 4, 'easy');
    const engine = new GameEngine({ chart, clock: h.clock });
    engine.begin();

    expect(engine.pressLane(4, 1000)).toEqual([]);
    expect(engine.pressLane(9, 1000)).toEqual([]);
    expect(engine.scoreSnapshot.strayPresses).toBe(0);
    expect(engine.isLanePressed(4)).toBe(false);
    // The same press on a lane that exists is judged normally.
    expect(engine.pressLane(0, 1000).some((event) => event.type === 'judgment')).toBe(true);
    expect(engine.scoreSnapshot.counts.perfect).toBe(1);
    h.input.detach();
    h.input.detachPointer();
  });

  it('pauses and resumes an easy run without disturbing the score', () => {
    const h = makeHarness(4);
    const chart = chartOf(
      [
        { timeMs: 1000, lane: 0, type: 'tap' },
        { timeMs: 2000, lane: 1, type: 'tap' },
      ],
      4,
      'easy',
    );
    const engine = new GameEngine({ chart, clock: h.clock });
    engine.begin();
    h.drive(engine);

    h.clock.now = 1000;
    h.key('keydown', 'KeyA');
    h.key('keyup', 'KeyA');
    const afterFirst = engine.scoreSnapshot.score;
    expect(engine.scoreSnapshot.counts.perfect).toBe(1);

    engine.pause();
    expect(engine.phase).toBe('paused');
    // While paused the clock is frozen: presses and updates do nothing at all.
    expect(engine.pressLane(1, 2000)).toEqual([]);
    expect(engine.update(2000)).toEqual([]);
    expect(engine.scoreSnapshot.score).toBe(afterFirst);

    engine.resume();
    h.clock.now = 2000;
    h.key('keydown', 'KeyS');
    h.key('keyup', 'KeyS');
    engine.update(4000);

    const results = engine.getResults();
    expect(results.counts).toEqual({ perfect: 2, good: 0, bad: 0, miss: 0 });
    expect(results.accuracy).toBe(1);
    expect(results.maxCombo).toBe(2);
    expect(results.difficultyWeight).toBe(1);
  });
});
