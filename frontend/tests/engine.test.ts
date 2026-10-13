import { describe, expect, it } from 'vitest';
import type { SongClock } from '../src/audio/AudioSource';
import type { Beatmap, ChartNote } from '../src/chart/ChartTypes';
import { BEATMAP_SCHEMA_VERSION } from '../src/chart/ChartTypes';
import { prepareBeatmap } from '../src/chart/ChartValidator';
import { buildDemoChart } from '../src/chart/demoChart';
import type { GameEvent } from '../src/game/GameEngine';
import { FINISH_TAIL_MS, GameEngine } from '../src/game/GameEngine';

class FakeClock implements SongClock {
  now = 0;
  getSongTimeMs(): number {
    return this.now;
  }
}

function chartOf(notes: ChartNote[], offsetMs = 0): Beatmap {
  return prepareBeatmap({
    schemaVersion: BEATMAP_SCHEMA_VERSION,
    songId: 'unit-test',
    title: 'Unit Test',
    difficulty: 'normal',
    bpm: 120,
    offsetMs,
    generator: { name: 'test', version: '1.0.0', seed: 7 },
    notes,
  });
}

function makeEngine(
  notes: ChartNote[],
  options: { globalOffsetMs?: number; offsetMs?: number } = {},
): { engine: GameEngine; clock: FakeClock } {
  const clock = new FakeClock();
  const engine = new GameEngine({
    chart: chartOf(notes, options.offsetMs ?? 0),
    clock,
    globalOffsetMs: options.globalOffsetMs ?? 0,
  });
  engine.begin();
  return { engine, clock };
}

type JudgmentEvent = Extract<GameEvent, { type: 'judgment' }>;

function judgmentEvents(events: GameEvent[]): JudgmentEvent[] {
  return events.filter((event): event is JudgmentEvent => event.type === 'judgment');
}

function firstJudgment(events: GameEvent[]): JudgmentEvent | undefined {
  return judgmentEvents(events)[0];
}

describe('tap judgment through the engine', () => {
  it('judges an on-time press PERFECT, consumes the note and scores it', () => {
    const { engine } = makeEngine([{ timeMs: 1000, lane: 3, type: 'tap' }]);
    const events = engine.pressLane(3, 1000);
    const judgment = firstJudgment(events);

    expect(judgment?.judgment).toBe('perfect');
    expect(judgment?.errorMs).toBe(0);
    expect(judgment?.combo).toBe(1);
    expect(judgment?.noteStatus).toBe('hit');
    expect(engine.scoreSnapshot.score).toBe(303); // 300 * (1 + 0.01 * combo 1)
    expect(engine.scoreSnapshot.maxCombo).toBe(1);
    expect(engine.pendingNotes).toBe(0);
    expect(engine.notes[0]!.status).toBe('hit');
  });

  it('applies the windows at their exact boundaries', () => {
    const cases: Array<[number, string]> = [
      [1000, 'perfect'],
      [1045, 'perfect'],
      [1046, 'good'],
      [1100, 'good'],
      [1101, 'bad'],
      [1160, 'bad'],
    ];

    for (const [pressTime, expected] of cases) {
      const { engine } = makeEngine([{ timeMs: 1000, lane: 0, type: 'tap' }]);
      const judgment = firstJudgment(engine.pressLane(0, pressTime));
      expect(judgment?.judgment, `press at ${pressTime}`).toBe(expected);
    }
  });

  it('treats a press outside the window as a stray press and keeps the note pending', () => {
    const { engine } = makeEngine([{ timeMs: 1000, lane: 0, type: 'tap' }]);
    const events = engine.pressLane(0, 1161);

    expect(judgmentEvents(events)).toHaveLength(0);
    expect(events.some((event) => event.type === 'stray-press')).toBe(true);
    expect(engine.scoreSnapshot.strayPresses).toBe(1);
    expect(engine.notes[0]!.status).toBe('pending');
    expect(engine.scoreSnapshot.judgedNotes).toBe(0);

    // Early presses far before the note are strays too.
    const early = makeEngine([{ timeMs: 5000, lane: 2, type: 'tap' }]);
    expect(early.engine.pressLane(2, 4000).some((event) => event.type === 'stray-press')).toBe(true);
  });

  it('only judges the closest pending note in the lane', () => {
    const { engine } = makeEngine([
      { timeMs: 1000, lane: 0, type: 'tap' },
      { timeMs: 1300, lane: 0, type: 'tap' },
    ]);
    const judgment = firstJudgment(engine.pressLane(0, 1250));
    expect(judgment?.noteIndex).toBe(1); // 50 ms from the second note, 250 ms from the first
    expect(engine.notes[0]!.status).toBe('pending');
  });
});

describe('miss resolution', () => {
  it('auto-misses only after the BAD window has elapsed', () => {
    const { engine } = makeEngine([{ timeMs: 1000, lane: 0, type: 'tap' }]);

    expect(judgmentEvents(engine.update(1160))).toHaveLength(0);
    expect(engine.notes[0]!.status).toBe('pending');

    const events = engine.update(1161);
    const judgment = firstJudgment(events);
    expect(judgment?.judgment).toBe('miss');
    expect(judgment?.errorMs).toBeNull();
    expect(engine.notes[0]!.status).toBe('missed');
    expect(engine.scoreSnapshot.counts.miss).toBe(1);
    expect(engine.pendingNotes).toBe(0);
  });

  it('lets a press at exactly the deadline still count as BAD', () => {
    const { engine } = makeEngine([{ timeMs: 1000, lane: 0, type: 'tap' }]);
    engine.update(1150);
    const judgment = firstJudgment(engine.pressLane(0, 1160));
    expect(judgment?.judgment).toBe('bad');
    expect(engine.scoreSnapshot.counts.bad).toBe(1);
  });

  it('never judges a note twice', () => {
    const { engine } = makeEngine([{ timeMs: 1000, lane: 0, type: 'tap' }]);
    engine.pressLane(0, 1000);
    engine.releaseLane(0, 1005);

    const secondPress = engine.pressLane(0, 1010);
    expect(secondPress.some((event) => event.type === 'stray-press')).toBe(true);
    expect(engine.notes[0]!.status).toBe('hit');

    expect(judgmentEvents(engine.update(5000))).toHaveLength(0);
    expect(engine.scoreSnapshot.judgedNotes).toBe(1);
    expect(engine.scoreSnapshot.counts.perfect).toBe(1);
  });

  it('ignores a repeated press while the key is still down', () => {
    const { engine } = makeEngine([
      { timeMs: 1000, lane: 0, type: 'tap' },
      { timeMs: 1050, lane: 0, type: 'tap' },
    ]);
    engine.pressLane(0, 1000);
    const repeated = engine.pressLane(0, 1050);

    expect(repeated).toHaveLength(0);
    expect(engine.scoreSnapshot.strayPresses).toBe(0);
    expect(engine.notes[1]!.status).toBe('pending');

    // The second note is then missed, because the lane was never released.
    engine.update(1211);
    expect(engine.notes[1]!.status).toBe('missed');
    expect(engine.scoreSnapshot.judgedNotes).toBe(2);
  });
});

describe('chords', () => {
  it('judges simultaneous notes in different lanes independently', () => {
    const { engine } = makeEngine([
      { timeMs: 2000, lane: 0, type: 'tap' },
      { timeMs: 2000, lane: 3, type: 'tap' },
      { timeMs: 2000, lane: 6, type: 'tap' },
    ]);

    const a = firstJudgment(engine.pressLane(0, 2000));
    const b = firstJudgment(engine.pressLane(3, 2004));
    const c = firstJudgment(engine.pressLane(6, 1996));

    expect([a?.judgment, b?.judgment, c?.judgment]).toEqual(['perfect', 'perfect', 'perfect']);
    expect(engine.scoreSnapshot.combo).toBe(3);
    expect(engine.pendingNotes).toBe(0);
    expect(engine.scoreSnapshot.maxCombo).toBe(3);
  });
});

describe('holds', () => {
  const hold: ChartNote[] = [{ timeMs: 2000, lane: 4, type: 'hold', durationMs: 800 }];

  it('enters the holding state on the head and completes at the tail', () => {
    const { engine } = makeEngine(hold);
    const head = firstJudgment(engine.pressLane(4, 2000));
    expect(head?.judgment).toBe('perfect');
    expect(head?.noteStatus).toBe('holding');
    expect(engine.scoreSnapshot.holdCompleted).toBe(0);

    engine.update(2699);
    expect(engine.notes[0]!.status).toBe('holding'); // still 1 ms short of the grace window

    const events = engine.update(2700);
    expect(events.some((event) => event.type === 'hold-complete')).toBe(true);
    expect(engine.notes[0]!.status).toBe('completed');
    expect(engine.scoreSnapshot.holdCompleted).toBe(1);
    expect(engine.scoreSnapshot.score).toBe(606); // head 303 + tail 303
    expect(engine.scoreSnapshot.combo).toBe(1); // the tail does not add a second combo step
    expect(engine.pendingNotes).toBe(0);
  });

  it('accepts a release inside the grace window as a completed hold', () => {
    const { engine } = makeEngine(hold);
    engine.pressLane(4, 2000);
    const events = engine.releaseLane(4, 2750); // tail is at 2800, grace is 100 ms
    expect(events.some((event) => event.type === 'hold-complete')).toBe(true);
    expect(engine.notes[0]!.status).toBe('completed');
    expect(engine.scoreSnapshot.score).toBe(606);
  });

  it('breaks the hold and resets combo on an early release, keeping the head score', () => {
    const { engine } = makeEngine(hold);
    engine.pressLane(4, 2000);
    const events = engine.releaseLane(4, 2500);

    expect(events.some((event) => event.type === 'hold-broken')).toBe(true);
    expect(engine.notes[0]!.status).toBe('broken');
    expect(engine.notes[0]!.releasedEarly).toBe(true);
    expect(engine.scoreSnapshot.holdBroken).toBe(1);
    expect(engine.scoreSnapshot.score).toBe(303);
    expect(engine.scoreSnapshot.combo).toBe(0);
    expect(engine.pendingNotes).toBe(0);
    expect(engine.scoreSnapshot.judgedNotes).toBe(1);
  });

  it('misses a hold whose head is never pressed and never pays a tail', () => {
    const { engine } = makeEngine(hold);
    engine.update(2200);
    expect(engine.notes[0]!.status).toBe('missed');
    expect(engine.scoreSnapshot.holdCompleted).toBe(0);
    expect(engine.scoreSnapshot.score).toBe(0);
  });

  it('forfeits the tail when paused mid-hold, without breaking combo', () => {
    const { engine } = makeEngine(hold);
    engine.pressLane(4, 2000);
    engine.update(2100);
    const events = engine.pause();

    expect(events.some((event) => event.type === 'interrupted-hold')).toBe(true);
    expect(engine.notes[0]!.status).toBe('interrupted');
    expect(engine.scoreSnapshot.combo).toBe(1);
    expect(engine.scoreSnapshot.holdBroken).toBe(0);
    expect(engine.scoreSnapshot.interruptedHolds).toBe(1);
    expect(engine.scoreSnapshot.holdCompleted).toBe(0);
    expect(engine.pendingNotes).toBe(0);
  });
});

describe('pause and resume', () => {
  it('does nothing while paused, then continues from the frozen position', () => {
    const { engine } = makeEngine([
      { timeMs: 1000, lane: 0, type: 'hold', durationMs: 400 },
      { timeMs: 3000, lane: 1, type: 'tap' },
    ]);

    engine.pressLane(0, 1000);
    engine.update(1100);
    engine.pause();

    // While paused the clock is frozen, so updates and presses are inert.
    expect(judgmentEvents(engine.update(1100))).toHaveLength(0);
    expect(engine.pressLane(1, 1100)).toHaveLength(0);
    expect(engine.pendingNotes).toBe(1);

    engine.resume();
    engine.update(2990);
    expect(engine.notes[1]!.status).toBe('pending'); // no premature miss

    const judgment = firstJudgment(engine.pressLane(1, 3000));
    expect(judgment?.judgment).toBe('perfect'); // press time still maps to the note exactly
    expect(engine.scoreSnapshot.counts.miss).toBe(0);
    expect(engine.scoreSnapshot.combo).toBe(2); // interrupted hold kept the combo, tap added one
  });

  it('ignores lane presses while paused and recovers after resume', () => {
    const { engine } = makeEngine([{ timeMs: 1000, lane: 5, type: 'tap' }]);
    engine.pause();
    expect(engine.pressLane(5, 1000)).toHaveLength(0);
    expect(engine.scoreSnapshot.strayPresses).toBe(0);
    engine.resume();
    expect(firstJudgment(engine.pressLane(5, 1000))?.judgment).toBe('perfect');
  });

  it('releaseAllLanes settles a hold on focus loss without breaking combo', () => {
    const { engine } = makeEngine([{ timeMs: 1000, lane: 2, type: 'hold', durationMs: 600 }]);
    engine.pressLane(2, 1000);
    engine.releaseAllLanes('blur');
    expect(engine.notes[0]!.status).toBe('interrupted');
    expect(engine.scoreSnapshot.combo).toBe(1);
    expect(engine.pendingNotes).toBe(0);
  });
});

describe('offsets', () => {
  it('shifts judgment by the global offset only', () => {
    const { engine } = makeEngine([{ timeMs: 1000, lane: 0, type: 'tap' }], { globalOffsetMs: 30 });
    // A player who is consistently 30 ms late gets a perfect score...
    expect(firstJudgment(engine.pressLane(0, 1030))?.judgment).toBe('perfect');
    expect(engine.scoreSnapshot.counts.perfect).toBe(1);

    // ...and the miss deadline moves with it.
    const { engine: late } = makeEngine([{ timeMs: 1000, lane: 0, type: 'tap' }], { globalOffsetMs: 30 });
    expect(judgmentEvents(late.update(1190))).toHaveLength(0);
    expect(judgmentEvents(late.update(1191))).toHaveLength(1);
  });

  it('applies the chart offset to note times for judgment', () => {
    const early = makeEngine([{ timeMs: 1000, lane: 0, type: 'tap' }], { offsetMs: 80 });
    expect(early.engine.notes[0]!.timeMs).toBe(1080);
    expect(firstJudgment(early.engine.pressLane(0, 1000))?.judgment).toBe('good'); // 80 ms early

    const onTime = makeEngine([{ timeMs: 1000, lane: 0, type: 'tap' }], { offsetMs: 80 });
    expect(firstJudgment(onTime.engine.pressLane(0, 1080))?.judgment).toBe('perfect');
  });
});

describe('run completion and results', () => {
  it('finishes once, after every note is resolved and the outro tail has passed', () => {
    const notes: ChartNote[] = [
      { timeMs: 1000, lane: 0, type: 'tap' },
      { timeMs: 1500, lane: 1, type: 'tap' },
      { timeMs: 2000, lane: 2, type: 'hold', durationMs: 400 },
    ];
    const { engine } = makeEngine(notes);

    engine.pressLane(0, 1000);
    engine.releaseLane(0, 1020);
    engine.pressLane(1, 1500);
    engine.releaseLane(1, 1520);
    engine.pressLane(2, 2000);
    engine.releaseLane(2, 2350);

    expect(engine.pendingNotes).toBe(0);
    const tooEarly = engine.update(2400 + FINISH_TAIL_MS - 1);
    expect(tooEarly.some((event) => event.type === 'finished')).toBe(false);

    const events = engine.update(2400 + FINISH_TAIL_MS);
    const finished = events.find((event) => event.type === 'finished');
    expect(finished).toBeDefined();
    if (finished?.type !== 'finished') throw new Error('expected finished');

    expect(finished.results.totalNotes).toBe(3);
    expect(finished.results.judgedNotes).toBe(3);
    expect(finished.results.counts).toEqual({ perfect: 3, good: 0, bad: 0, miss: 0 });
    expect(finished.results.accuracy).toBe(1);
    expect(finished.results.grade).toBe('S');
    expect(finished.results.maxCombo).toBe(3);
    expect(finished.results.holdCompleted).toBe(1);
    expect(engine.phase).toBe('finished');

    // No further events, even if the clock keeps running.
    expect(engine.update(99999)).toHaveLength(0);
  });

  it('auto-misses every untouched note and still reports a full result', () => {
    const notes: ChartNote[] = [
      { timeMs: 1000, lane: 0, type: 'tap' },
      { timeMs: 1500, lane: 1, type: 'hold', durationMs: 300 },
      { timeMs: 2000, lane: 2, type: 'tap' },
    ];
    const { engine } = makeEngine(notes);

    let finished: Extract<GameEvent, { type: 'finished' }> | undefined;
    for (let t = 0; t <= 4000; t += 25) {
      for (const event of engine.update(t)) {
        if (event.type === 'finished') finished = event;
      }
    }

    expect(finished).toBeDefined();
    expect(finished!.results.counts.miss).toBe(3);
    expect(finished!.results.judgedNotes).toBe(3);
    expect(finished!.results.accuracy).toBe(0);
    expect(finished!.results.grade).toBe('F');
    expect(finished!.results.score).toBe(0);
    expect(finished!.results.combo).toBe(0);
  });
});

describe('frame-rate independence', () => {
  const notes: ChartNote[] = [
    { timeMs: 1000, lane: 0, type: 'tap' },
    { timeMs: 1500, lane: 3, type: 'tap' },
    { timeMs: 2000, lane: 6, type: 'tap' },
    { timeMs: 2500, lane: 0, type: 'tap' },
  ];

  /** Play the same chart with identical press times but a different update cadence. */
  function play(stepMs: number) {
    const { engine, clock } = makeEngine(notes);
    let last = 0;
    for (const note of notes) {
      for (let t = last; t < note.timeMs; t += stepMs) {
        clock.now = t;
        engine.update(t);
      }
      clock.now = note.timeMs;
      engine.update(note.timeMs);
      engine.pressLane(note.lane, note.timeMs);
      engine.releaseLane(note.lane, note.timeMs + 5);
      last = note.timeMs;
    }
    for (let t = last; t <= 6000; t += stepMs) {
      clock.now = t;
      engine.update(t);
    }
    return engine.getResults();
  }

  it('produces identical results at 5 ms, 16 ms and 120 ms update steps', () => {
    const fine = play(5);
    const sixty = play(16);
    const coarse = play(120);

    expect(sixty.score).toBe(fine.score);
    expect(coarse.score).toBe(fine.score);
    expect(sixty.accuracy).toBe(fine.accuracy);
    expect(coarse.accuracy).toBe(fine.accuracy);
    expect(sixty.maxCombo).toBe(fine.maxCombo);
    expect(coarse.maxCombo).toBe(fine.maxCombo);
    expect(coarse.counts).toEqual(fine.counts);
    expect(fine.counts).toEqual({ perfect: 4, good: 0, bad: 0, miss: 0 });
  });
});

describe('demo chart end to end', () => {
  it('produces a perfect S run when every note is hit on time', () => {
    const demo = buildDemoChart();
    const clock = new FakeClock();
    const engine = new GameEngine({ chart: demo, clock });
    engine.begin();

    const actions: Array<{ time: number; run: () => void }> = [];
    for (const note of demo.notes) {
      const pressAt = note.timeMs;
      actions.push({ time: pressAt, run: () => void engine.pressLane(note.lane, pressAt) });
      if (note.type === 'hold') {
        const releaseAt = note.timeMs + (note.durationMs ?? 0) - 20; // inside the grace window
        actions.push({ time: releaseAt, run: () => void engine.releaseLane(note.lane, releaseAt) });
      } else {
        actions.push({ time: pressAt + 20, run: () => void engine.releaseLane(note.lane, pressAt + 20) });
      }
    }
    actions.sort((a, b) => a.time - b.time);

    let index = 0;
    for (let t = 0; t <= 64_000; t += 20) {
      while (index < actions.length && actions[index]!.time <= t) {
        actions[index]!.run();
        index += 1;
      }
      clock.now = t;
      engine.update(t);
    }

    const results = engine.getResults();
    const holdCount = demo.notes.filter((note) => note.type === 'hold').length;

    expect(results.totalNotes).toBe(demo.notes.length);
    expect(results.judgedNotes).toBe(demo.notes.length);
    expect(results.counts.perfect).toBe(demo.notes.length);
    expect(results.counts.miss).toBe(0);
    expect(results.counts.bad).toBe(0);
    expect(results.accuracy).toBe(1);
    expect(results.grade).toBe('S');
    expect(results.maxCombo).toBe(demo.notes.length);
    expect(results.holdCompleted).toBe(holdCount);
    expect(results.holdBroken).toBe(0);
    expect(results.strayPresses).toBe(0);
    expect(engine.phase).toBe('finished');
  });
});
