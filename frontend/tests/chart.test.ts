import { describe, expect, it } from 'vitest';
import type { Beatmap, ChartNote } from '../src/chart/ChartTypes';
import { BEATMAP_SCHEMA_VERSION, noteEndMs } from '../src/chart/ChartTypes';
import { ChartValidationError, normalizeBeatmap, prepareBeatmap, validateBeatmap } from '../src/chart/ChartValidator';
import { ChartParseError, assertUniformStepCount, countSteps, parseBarPattern } from '../src/chart/PatternParser';
import { buildDemoChart, buildDemoNotes, demoChartEndMs } from '../src/chart/demoChart';
import {
  DEMO_BAR_MS,
  DEMO_CHART_STEPS,
  DEMO_DRUM_STEPS,
  SECTIONS,
  demoBarCount,
  demoBars,
  demoSongDurationMs,
} from '../src/content/demoSong';

function chart(notes: ChartNote[], overrides: Partial<Beatmap> = {}): Beatmap {
  return {
    schemaVersion: BEATMAP_SCHEMA_VERSION,
    songId: 'test-song',
    title: 'Test Song',
    difficulty: 'normal',
    bpm: 120,
    offsetMs: 0,
    generator: { name: 'test', version: '1.0.0', seed: 1 },
    notes,
    ...overrides,
  };
}

describe('bar pattern parser', () => {
  it('expands an 8-step (eighth note) grid', () => {
    const notes = parseBarPattern({ pattern: '0 . . . 3 . . .', barStartMs: 0, barDurationMs: 1600 });
    expect(notes).toEqual([
      { timeMs: 0, lane: 0, type: 'tap' },
      { timeMs: 800, lane: 3, type: 'tap' },
    ]);
  });

  it('expands a 16-step (sixteenth note) grid at 100 ms per step', () => {
    const notes = parseBarPattern({
      pattern: '0 . 2 . 4 . 6 . 0 . 2 . 4 . 6 .',
      barStartMs: 1600,
      barDurationMs: 1600,
    });
    expect(notes.map((n) => n.timeMs)).toEqual([1600, 1800, 2000, 2200, 2400, 2600, 2800, 3000]);
    expect(notes.map((n) => n.lane)).toEqual([0, 2, 4, 6, 0, 2, 4, 6]);
  });

  it('supports chords with + and holds with ~', () => {
    const notes = parseBarPattern({ pattern: '0+3~2 . . .', barStartMs: 0, barDurationMs: 1600 });
    expect(notes).toHaveLength(2);
    expect(notes[0]).toEqual({ timeMs: 0, lane: 0, type: 'tap' });
    // 4 steps in the bar -> 400 ms per step, so a 2-step hold lasts 800 ms.
    expect(notes[1]).toEqual({ timeMs: 0, lane: 3, type: 'hold', durationMs: 800 });
    expect(noteEndMs(notes[1]!)).toBe(800);
  });

  it('orders notes by time then lane for chords', () => {
    const notes = parseBarPattern({ pattern: '4+1 . . .', barStartMs: 0, barDurationMs: 1600 });
    expect(notes.map((n) => n.lane)).toEqual([1, 4]);
  });

  it('rejects malformed tokens with a helpful message', () => {
    expect(() => parseBarPattern({ pattern: '0 z . .', barStartMs: 0, barDurationMs: 1600 })).toThrow(ChartParseError);
    expect(() => parseBarPattern({ pattern: '0~ . .', barStartMs: 0, barDurationMs: 1600 })).toThrow(ChartParseError);
    expect(() => parseBarPattern({ pattern: '   ', barStartMs: 0, barDurationMs: 1600 })).toThrow(ChartParseError);
  });

  it('counts steps and can assert a uniform grid', () => {
    expect(countSteps('0 . 2 .')).toBe(4);
    expect(countSteps('  0   .  2   .  ')).toBe(4);
    expect(() => assertUniformStepCount(['0 . 2 .', '0 . . .'], 4, 0)).not.toThrow();
    expect(() => assertUniformStepCount(['0 . 2 .', '0 . .'], 4, 8)).toThrow(/bar 9 declares 3 steps/);
  });
});

describe('beatmap validator', () => {
  it('accepts a clean chart without warnings', () => {
    const result = validateBeatmap(chart([{ timeMs: 0, lane: 0, type: 'tap' }, { timeMs: 500, lane: 6, type: 'tap' }]));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('rejects out-of-range lanes, negative times and unknown types', () => {
    const result = validateBeatmap(
      chart([
        { timeMs: 0, lane: 7, type: 'tap' },
        { timeMs: -5, lane: 0, type: 'tap' },
        { timeMs: 100, lane: 1, type: 'slide' as unknown as 'tap' },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toEqual(
      expect.arrayContaining(['note-lane', 'note-time', 'note-type']),
    );
  });

  it('rejects duplicate notes and overlapping holds in the same lane', () => {
    const duplicate = validateBeatmap(
      chart([{ timeMs: 1000, lane: 2, type: 'tap' }, { timeMs: 1000, lane: 2, type: 'tap' }]),
    );
    expect(duplicate.errors.some((e) => e.code === 'duplicate-note')).toBe(true);

    const overlap = validateBeatmap(
      chart([
        { timeMs: 1000, lane: 2, type: 'hold', durationMs: 500 },
        { timeMs: 1400, lane: 2, type: 'tap' },
      ]),
    );
    expect(overlap.errors.some((e) => e.code === 'overlapping-notes')).toBe(true);
  });

  it('allows a note that starts exactly where the previous one ends', () => {
    const touching = validateBeatmap(
      chart([
        { timeMs: 1000, lane: 2, type: 'hold', durationMs: 400 },
        { timeMs: 1400, lane: 2, type: 'tap' },
      ]),
    );
    expect(touching.ok).toBe(true);
    expect(touching.warnings).toEqual([]);
  });

  it('warns about tight same-lane spacing and about density', () => {
    const tight = validateBeatmap(chart([{ timeMs: 0, lane: 0, type: 'tap' }, { timeMs: 30, lane: 0, type: 'tap' }]));
    expect(tight.ok).toBe(true);
    expect(tight.warnings.some((w) => w.code === 'tight-spacing')).toBe(true);

    const dense: ChartNote[] = [];
    for (let i = 0; i < 30; i += 1) dense.push({ timeMs: i * 30, lane: i % 7, type: 'tap' });
    const denseResult = validateBeatmap(chart(dense));
    expect(denseResult.warnings.some((w) => w.code === 'dense-section')).toBe(true);
  });

  it('rejects holds without a positive duration and a future schema version', () => {
    const badHold = validateBeatmap(chart([{ timeMs: 0, lane: 0, type: 'hold' }]));
    expect(badHold.errors.some((e) => e.code === 'hold-duration')).toBe(true);

    const future = validateBeatmap(chart([{ timeMs: 0, lane: 0, type: 'tap' }], { schemaVersion: 99 }));
    expect(future.errors.some((e) => e.code === 'schema-version-future')).toBe(true);
  });

  it('rejects an empty note list and missing metadata', () => {
    const empty = validateBeatmap(chart([]));
    expect(empty.ok).toBe(false);
    expect(empty.errors.map((e) => e.code)).toContain('notes-empty');

    const noTitle = validateBeatmap(chart([{ timeMs: 0, lane: 0, type: 'tap' }], { title: '  ' }));
    expect(noTitle.errors.map((e) => e.code)).toContain('title');
  });

  it('normalises order and clamps hold durations without mutating the input', () => {
    const input = chart([
      { timeMs: 500, lane: 1, type: 'tap' },
      { timeMs: 100, lane: 0, type: 'hold', durationMs: Number.NaN },
      { timeMs: 300, lane: 2, type: 'tap', durationMs: 250 },
    ]);
    const snapshot = JSON.stringify(input);
    const normalized = normalizeBeatmap(input);

    expect(normalized.notes.map((n) => n.timeMs)).toEqual([100, 300, 500]);
    expect(normalized.notes[0]!.durationMs).toBe(1);
    expect(normalized.notes[1]!.durationMs).toBeUndefined();
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(normalizeBeatmap(input)).not.toBe(input);
  });

  it('throws a descriptive error from prepareBeatmap', () => {
    expect(() => prepareBeatmap(chart([{ timeMs: 0, lane: 9, type: 'tap' }]))).toThrow(ChartValidationError);
  });
});

describe('demo song definition', () => {
  it('keeps every hand-authored bar on the same 16-step grid', () => {
    for (const section of Object.values(SECTIONS)) {
      section.chart.forEach((pattern, index) => {
        expect(countSteps(pattern), `${section.id} bar ${index}`).toBe(DEMO_CHART_STEPS);
      });
    }
  });

  it('keeps the drum grid at 8 steps and the melody at 16', () => {
    for (const section of Object.values(SECTIONS)) {
      expect(section.drums.kick.length).toBe(DEMO_DRUM_STEPS);
      expect(section.drums.snare.length).toBe(DEMO_DRUM_STEPS);
      expect(section.drums.hat.length).toBe(DEMO_DRUM_STEPS);
      expect(section.bass.length).toBe(DEMO_DRUM_STEPS);
      if (section.lead) expect(countSteps(section.lead)).toBe(DEMO_CHART_STEPS);
    }
  });

  it('builds 36 bars over 1600 ms each', () => {
    expect(demoBarCount()).toBe(36);
    expect(DEMO_BAR_MS).toBe(1600);
    expect(demoSongDurationMs()).toBe(57_600);
    expect(demoBars()).toHaveLength(36);
    expect(demoBars()[0]!.startMs).toBe(0);
    expect(demoBars()[35]!.startMs).toBe(35 * 1600);
  });
});

describe('demo chart', () => {
  it('contains exactly one note per authored lane token, counted independently of the parser', () => {
    // Walk the real arrangement (the chorus is played twice) and count lanes by hand:
    // every non-'.' token contributes one note per lane it lists.
    let expected = 0;
    for (const bar of demoBars()) {
      const pattern = SECTIONS[bar.sectionId].chart[bar.barInSection]!;
      for (const token of pattern.trim().split(/\s+/)) {
        if (token === '.') continue;
        expected += token.split('+').length;
      }
    }
    const notes = buildDemoNotes();
    expect(notes).toHaveLength(expected);
    expect(notes).toHaveLength(231);
    expect(notes.filter((note) => note.type === 'hold').length).toBeGreaterThan(5);
  });

  it('validates cleanly: no errors and no warnings', () => {
    const result = validateBeatmap(buildDemoChart());
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('stays inside the lane range and is pre-sorted for the engine', () => {
    const notes = buildDemoNotes();
    for (const note of notes) {
      expect(note.lane).toBeGreaterThanOrEqual(0);
      expect(note.lane).toBeLessThan(7);
      expect(note.timeMs).toBeGreaterThanOrEqual(0);
      if (note.type === 'hold') expect(note.durationMs!).toBeGreaterThan(0);
    }
    const sorted = [...notes].sort((a, b) => a.timeMs - b.timeMs || a.lane - b.lane);
    expect(notes).toEqual(sorted);
  });

  it('ends inside the final bar and is deterministic', () => {
    const first = buildDemoChart();
    const second = buildDemoChart();
    expect(first).toEqual(second);
    expect(demoChartEndMs(first)).toBeGreaterThan(57_000);
    expect(demoChartEndMs(first)).toBeLessThanOrEqual(demoSongDurationMs());
  });

  it('ships metadata that the renderer and results screen rely on', () => {
    const demo = buildDemoChart();
    expect(demo.schemaVersion).toBe(BEATMAP_SCHEMA_VERSION);
    expect(demo.bpm).toBe(150);
    expect(demo.offsetMs).toBe(0);
    // Seven keys, so the demo is Hard (phase 3): its scores carry Hard's weight and its highway is
    // the seven-lane one it always was.
    expect(demo.difficulty).toBe('hard');
    expect(demo.laneCount).toBe(7);
    expect(demo.maxScore).toBeGreaterThan(0);
    expect(demo.title.length).toBeGreaterThan(0);
    expect(prepareBeatmap(demo).notes).toHaveLength(demo.notes.length);
  });
});
