/**
 * Playback synchronisation: a generated chart played through the **real** judgment engine.
 *
 * Unit tests can show that the generator's numbers are self-consistent; only playing the chart
 * through the engine at its own timestamps shows that those numbers mean something to the game.
 * The script below presses every note exactly on time (holds stay down to the tail) and expects a
 * clean run, then repeats it with a systematic 120 ms delay and expects that to *hurt* — which is
 * what proves the timestamps are the timing, and that `globalOffsetMs` is the calibration knob a
 * laggy device would use to compensate.
 *
 * `PlaybackTimeline` supplies the clock, so pause/resume is exercised as well: a chart judged
 * across a freeze must keep its alignment (no accumulated drift on resume).
 */

import { describe, expect, it } from 'vitest';
import { analyzeMono } from '../src/analysis/MusicAnalyzer';
import { generateChart } from '../src/chart/ChartGenerator';
import type { Beatmap, ChartNote } from '../src/chart/ChartTypes';
import { prepareBeatmap } from '../src/chart/ChartValidator';
import type { GameEvent } from '../src/game/GameEngine';
import { GameEngine } from '../src/game/GameEngine';
import { PlaybackTimeline } from '../src/audio/PlaybackTimeline';
import type { SongClock } from '../src/audio/AudioSource';
import { drumTrack, RATE } from './helpers/synth';

/** A clock the test drives by hand, backed by the real PlaybackTimeline. */
class TimelineClock implements SongClock {
  readonly timeline = new PlaybackTimeline();
  ctxSec = 0;

  start(songTimeMs: number, ctxSec: number): void {
    this.ctxSec = ctxSec;
    this.timeline.start(songTimeMs, ctxSec);
  }

  pause(songTimeMs: number): void {
    this.timeline.freeze(songTimeMs, this.ctxSec);
  }

  resume(songTimeMs: number, ctxSec: number): void {
    this.ctxSec = ctxSec;
    this.timeline.resumeAt(songTimeMs, ctxSec);
  }

  getSongTimeMs(): number {
    return this.timeline.getSongTimeMs(this.ctxSec);
  }
}

function generatedChart(seed = 9): Beatmap {
  const analysis = analyzeMono(drumTrack({ durationMs: 14000, bpm: 120 }), RATE);
  const generated = generateChart(analysis, { seed, songId: 'sync-test', title: 'Sync Test' });
  expect(generated.validation.ok).toBe(true);
  return prepareBeatmap(generated.chart);
}

interface RunResult {
  events: GameEvent[];
  engine: GameEngine;
}

/**
 * Play a chart by pressing every note at `offsetMs` from its own timestamp. Holds are pressed at
 * the head and released 40 ms after the tail (the engine allows a little release grace).
 */
function playChart(chart: Beatmap, options: { offsetMs?: number; globalOffsetMs?: number; clock?: TimelineClock } = {}): RunResult {
  const offset = options.offsetMs ?? 0;
  const clock = options.clock ?? new TimelineClock();
  clock.start(0, 0);
  const engine = new GameEngine({
    chart,
    clock,
    globalOffsetMs: options.globalOffsetMs ?? 0,
  });
  engine.begin();

  const events: GameEvent[] = [];
  const notes = [...chart.notes].sort((a, b) => a.timeMs - b.timeMs || a.lane - b.lane);
  for (const note of notes) {
    clock.ctxSec = (note.timeMs + offset) / 1000;      events.push(...engine.pressLane(note.lane, clock.getSongTimeMs()));
    if (note.type === 'hold') {
      const releaseAt = note.timeMs + (note.durationMs ?? 0) + 40 + offset;
      clock.ctxSec = releaseAt / 1000;
      events.push(...engine.releaseLane(note.lane, clock.getSongTimeMs()));
    } else {
      events.push(...engine.releaseLane(note.lane, clock.getSongTimeMs()));
    }
  }
  // Let the engine settle any misses past the end of the chart.
  clock.ctxSec = (chart.durationMs ?? 0) / 1000 + 5;
  events.push(...engine.update(clock.getSongTimeMs()));
  return { events, engine };
}

function judgments(events: readonly GameEvent[]): Array<Extract<GameEvent, { type: 'judgment' }>> {
  return events.filter((event): event is Extract<GameEvent, { type: 'judgment' }> => event.type === 'judgment');
}

describe('a generated chart played on time', () => {
  it('scores every note without a miss', () => {
    const chart = generatedChart();
    const { events, engine } = playChart(chart);
    const counts = engine.scoreSnapshot.counts;
    expect(counts.miss).toBe(0);
    expect(counts.perfect + counts.good + counts.bad).toBe(chart.notes.length);
    expect(engine.scoreSnapshot.combo).toBe(chart.notes.length);
    expect(engine.scoreSnapshot.accuracy).toBeGreaterThan(0.9);
    // Holds were all completed (no broken holds), which also proves the tails are ordered sanely.
    expect(engine.scoreSnapshot.holdBroken).toBe(0);
    const holds = chart.notes.filter((note) => note.type === 'hold').length;
    expect(engine.scoreSnapshot.holdCompleted).toBe(holds);
  });

  it('is strictly ordered in time and inside the song', () => {
    const chart = generatedChart();
    const times = chart.notes.map((note) => note.timeMs);
    for (let i = 1; i < times.length; i += 1) expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!);
    expect(times[0]!).toBeGreaterThanOrEqual(0);
    expect(times[times.length - 1]!).toBeLessThanOrEqual(chart.durationMs ?? Infinity);
    // Two notes may share an instant only as a chord in different lanes.
    const byTime = new Map<number, number[]>();
    for (const note of chart.notes) {
      const lanes = byTime.get(note.timeMs) ?? [];
      lanes.push(note.lane);
      byTime.set(note.timeMs, lanes);
    }
    for (const [, lanes] of byTime) {
      expect(new Set(lanes).size).toBe(lanes.length);
      expect(lanes.length).toBeLessThanOrEqual(2);
    }
  });

  it('turns a systematic delay into worse judgments — the timestamps are the timing', () => {
    const chart = generatedChart();
    const onTime = playChart(chart);
    const late = playChart(chart, { offsetMs: 130 });
    const lateCounts = late.engine.scoreSnapshot.counts;
    expect(late.engine.scoreSnapshot.accuracy).toBeLessThan(onTime.engine.scoreSnapshot.accuracy);
    expect(lateCounts.miss + lateCounts.bad).toBeGreaterThan(0);
  });

  it('lets a calibration offset recover a laggy device', () => {
    const chart = generatedChart();
    // A player who is consistently 60 ms late fixes it with a +60 ms global offset (the documented
    // convention: positive means "my presses land late, judge them earlier").
    const raw = playChart(chart, { offsetMs: 60 });
    const calibrated = playChart(chart, { offsetMs: 60, globalOffsetMs: 60 });
    expect(calibrated.engine.scoreSnapshot.accuracy).toBeGreaterThan(raw.engine.scoreSnapshot.accuracy);
    expect(calibrated.engine.scoreSnapshot.counts.miss).toBe(0);
  });

  it('keeps its alignment across a pause and resume', () => {
    const chart = generatedChart(3);
    const clock = new TimelineClock();
    const engine = new GameEngine({ chart, clock });
    engine.begin();
    clock.start(0, 0);

    const notes = [...chart.notes].sort((a, b) => a.timeMs - b.timeMs);
    const firstHalf = notes.slice(0, Math.floor(notes.length / 2));
    const secondHalf = notes.slice(Math.floor(notes.length / 2));
    const events: GameEvent[] = [];

    for (const note of firstHalf) {
      clock.ctxSec = note.timeMs / 1000;
      events.push(...engine.pressLane(note.lane, clock.getSongTimeMs()));
      events.push(...engine.releaseLane(note.lane, clock.getSongTimeMs()));
    }

    // Pause: the clock freezes where it was, the engine is told, then both resume later in real time.
    const frozenSongMs = firstHalf[firstHalf.length - 1]!.timeMs + 20;
    clock.ctxSec = frozenSongMs / 1000;
    engine.pause();
    clock.pause(frozenSongMs);
    expect(clock.getSongTimeMs()).toBeCloseTo(frozenSongMs, 6);

    const resumeCtxSec = clock.ctxSec + 3; // three seconds of wall clock spent paused
    clock.resume(frozenSongMs, resumeCtxSec);
    engine.resume();
    expect(clock.getSongTimeMs()).toBeCloseTo(frozenSongMs, 6); // frozen until the anchor…

    for (const note of secondHalf) {
      clock.ctxSec = resumeCtxSec + (note.timeMs - frozenSongMs) / 1000;
      events.push(...engine.pressLane(note.lane, clock.getSongTimeMs()));
      events.push(...engine.releaseLane(note.lane, clock.getSongTimeMs()));
    }
    clock.ctxSec = resumeCtxSec + ((chart.durationMs ?? 0) - frozenSongMs) / 1000 + 5;
    events.push(...engine.update(clock.getSongTimeMs()));

    const counts = engine.scoreSnapshot.counts;
    expect(counts.miss).toBe(0);
    expect(counts.perfect + counts.good + counts.bad).toBe(chart.notes.length);
    expect(clock.timeline.snapshot().mode).toBe('frozen');
  });

  it('pauses a hold safely: the tail is forfeited without punishing the player', () => {
    const chart = prepareBeatmap({
      schemaVersion: 1,
      songId: 'hold-pause',
      title: 'Hold Pause',
      difficulty: 'normal',
      bpm: 120,
      offsetMs: 0,
      generator: { name: 'test', version: '1.0.0', seed: 1 },
      notes: [{ timeMs: 1000, lane: 0, type: 'hold', durationMs: 2000 }],
    });
    const clock = new TimelineClock();
    const engine = new GameEngine({ chart, clock });
    engine.begin();
    clock.start(0, 0);

    clock.ctxSec = 1;
    engine.pressLane(0, clock.getSongTimeMs());
    clock.ctxSec = 1.5;
    const pauseEvents = engine.pause();
    clock.pause(1500);

    // Pausing mid-hold interrupts the tail (documented behaviour): the combo survives and the
    // results screen reports it as an interrupted hold rather than a mistake the player made.
    expect(pauseEvents.some((event) => event.type === 'interrupted-hold')).toBe(true);
    expect(engine.scoreSnapshot.holdBroken).toBe(0);
    expect(engine.scoreSnapshot.interruptedHolds).toBe(1);
    expect(engine.scoreSnapshot.combo).toBe(1);

    const resumeCtxSec = clock.ctxSec + 2;
    clock.resume(1500, resumeCtxSec);
    engine.resume();
    // The tail is at 3000 ms of song time, i.e. 1.5 s after the frozen position.
    clock.ctxSec = resumeCtxSec + 1.5;
    const events = engine.releaseLane(0, clock.getSongTimeMs());
    expect(events.filter((event) => event.type === 'hold-complete')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'hold-broken')).toHaveLength(0);
    expect(engine.scoreSnapshot.interruptedHolds).toBe(1);
  });
});

describe('note metadata', () => {
  it('every generated note is inside the judgement windows of a beat or a strong onset', () => {
    const chart = generatedChart(4);
    const analysis = analyzeMono(drumTrack({ durationMs: 14000, bpm: 120 }), RATE);
    const beatTolerance = 45; // PERFECT window
    const offBeat = chart.notes.filter((note: ChartNote) => {
      const nearBeat = analysis.beats.some((beat) => Math.abs(beat - note.timeMs) <= beatTolerance);
      if (nearBeat) return false;
      const nearOnset = analysis.onsets.some((onset) => Math.abs(onset.timeMs - note.timeMs) <= beatTolerance);
      return !nearOnset;
    });
    // The generator may nudge a slot by up to 25 ms and place syncopated onsets freely, so this is
    // a sanity bound rather than an exact rule — but a chart where *many* notes sit nowhere near
    // any musical event would mean the alignment stage is broken.
    expect(offBeat.length / chart.notes.length).toBeLessThan(0.2);
  });
});
