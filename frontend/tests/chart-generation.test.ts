/**
 * Chart generation tests.
 *
 * Two kinds of case, deliberately:
 *
 *  - **End to end** — synthetic audio through the real analysis pipeline into the generator, which
 *    is the only way to catch a rule that is individually correct but produces an unplayable chart.
 *  - **Hand-built summaries** for situations audio cannot conveniently produce (an empty beat grid,
 *    a silent track, a specific accent pattern).
 *
 * The assertions the brief cares about are here: determinism, density limits, all seven lanes,
 * chords, holds, no notes in silence, and validation passing.
 */

import { describe, expect, it } from 'vitest';
import { analyzeMono } from '../src/analysis/MusicAnalyzer';
import type { AnalysisSummary, EnergyProfile, OnsetEvent } from '../src/analysis/types';
import { generateChart, seededRandom } from '../src/chart/ChartGenerator';
import { validateBeatmap } from '../src/chart/ChartValidator';
import { LANE_COUNT } from '../src/chart/ChartTypes';

const RATE = 44100;

function noise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1);
  };
}

/** A percussive click track with a kick on every beat, hats on the off-beats and accents every 4. */
function drumTrack(options: {
  durationMs: number;
  bpm?: number;
  quietAfterMs?: number;
  quietGain?: number;
}): Float32Array {
  const bpm = options.bpm ?? 120;
  const length = Math.round((options.durationMs / 1000) * RATE);
  const out = new Float32Array(length);
  const random = noise(0xbeef);
  const beatMs = 60000 / bpm;

  const add = (atMs: number, gain: number, body: (t: number) => number, decay: number, tailMs: number): void => {
    const start = Math.round((atMs / 1000) * RATE);
    for (let i = 0; i < (tailMs / 1000) * RATE; i += 1) {
      const index = start + i;
      if (index >= length) break;
      const t = i / RATE;
      let value = body(t) * Math.exp(-t * decay) * gain;
      if (options.quietAfterMs !== undefined && atMs >= options.quietAfterMs) value *= options.quietGain ?? 0.02;
      out[index] = (out[index] ?? 0) + value;
    }
  };

  for (let beat = 0; beat * beatMs <= options.durationMs; beat += 1) {
    const onBar = beat % 4 === 0;
    add(beat * beatMs, onBar ? 1 : 0.7, (t) => Math.sin(2 * Math.PI * 70 * t) + random() * 0.3, 22, 120);
    // Off-beat hat: gives the analysis something to detect between beats.
    add(beat * beatMs + beatMs / 2, 0.5, (t) => random() * 0.9 + Math.sin(2 * Math.PI * 5000 * t) * 0.4, 90, 40);
    if (onBar) add(beat * beatMs, 0.8, (t) => random() * 0.8 + Math.sin(2 * Math.PI * 3000 * t) * 0.5, 70, 60);
  }
  return out;
}

function summaryOf(samples: Float32Array, sampleRate = RATE): AnalysisSummary {
  return analyzeMono(samples, sampleRate);
}

const BASE_OPTIONS = { seed: 7, songId: 'test-song', title: 'Test Song' } as const;

function emptyEnergy(durationMs: number): EnergyProfile {
  return {
    frameDb: [],
    frameMs: 11.6,
    peakDb: -20,
    meanDb: -20,
    floorDb: -65,
    activeRanges: [{ startMs: 0, endMs: durationMs }],
    lowEnergyRanges: [],
    intensityByBeat: [],
    onsetsPerSecond: [],
  };
}

function summary(overrides: Partial<AnalysisSummary>): AnalysisSummary {
  const durationMs = overrides.durationMs ?? 10000;
  const bpm = overrides.bpm ?? 120;
  const beatMs = overrides.beatMs ?? 60000 / bpm;
  const beats =
    overrides.beats ?? Array.from({ length: Math.floor(durationMs / beatMs) }, (_, index) => index * beatMs);
  return {
    bpm,
    beatMs,
    firstBeatMs: 0,
    beats,
    onsets: [],
    energy: emptyEnergy(durationMs),
    durationMs,
    beatConfidence: 1,
    ...overrides,
  };
}

describe('seededRandom', () => {
  it('is deterministic and stays in [0,1)', () => {
    const a = seededRandom(1234);
    const b = seededRandom(1234);
    for (let i = 0; i < 100; i += 1) {
      const value = a();
      expect(value).toBe(b());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    expect(seededRandom(1235)()).not.toBe(seededRandom(1234)());
  });
});

describe('chart generation from real analysis', () => {
  const analysis = summaryOf(drumTrack({ durationMs: 20000, bpm: 120 }));
  const generated = generateChart(analysis, { ...BASE_OPTIONS });

  it('produces a validated chart with a sane number of notes', () => {
    expect(generated.validation.ok).toBe(true);
    expect(generated.validation.errors).toEqual([]);
    expect(generated.stats.noteCount).toBeGreaterThan(30);
    expect(generated.stats.notesPerSecond).toBeGreaterThan(1);
    expect(generated.stats.notesPerSecond).toBeLessThan(6);
  });

  it('respects the density ceiling in every one-second window', () => {
    const times = generated.chart.notes.map((note) => note.timeMs).sort((a, b) => a - b);
    let peak = 0;
    let head = 0;
    for (let tail = 0; tail < times.length; tail += 1) {
      while (times[tail]! - times[head]! >= 1000) head += 1;
      peak = Math.max(peak, tail - head + 1);
    }
    expect(peak).toBe(generated.stats.peakNotesPerSecond);
    expect(peak).toBeLessThanOrEqual(9);
  });

  it('never places a note in a low-energy section', () => {
    const quiet = summaryOf(drumTrack({ durationMs: 16000, bpm: 120, quietAfterMs: 8000, quietGain: 0.0008 }));
    const result = generateChart(quiet, { ...BASE_OPTIONS });
    expect(quiet.energy.lowEnergyRanges.length).toBeGreaterThan(0);
    for (const note of result.chart.notes) {
      const inSilence = quiet.energy.lowEnergyRanges.some(
        (range) => note.timeMs >= range.startMs && note.timeMs < range.endMs,
      );
      expect(inSilence, `note at ${note.timeMs}ms in silence`).toBe(false);
    }
    // …and the generator is certainly not filling the quiet half with notes.
    const notesInQuietHalf = result.chart.notes.filter((note) => note.timeMs > 9000).length;
    expect(notesInQuietHalf).toBe(0);
  });

  it('uses every lane and keeps per-lane spacing playable', () => {
    expect(generated.stats.lanesUsed).toBe(LANE_COUNT);
    for (let lane = 0; lane < LANE_COUNT; lane += 1) {
      expect(generated.stats.laneUsage[lane]!).toBeGreaterThan(0);
    }
    const perLane = new Map<number, number[]>();
    for (const note of generated.chart.notes) {
      const list = perLane.get(note.lane) ?? [];
      list.push(note.timeMs);
      perLane.set(note.lane, list);
    }
    for (const [, times] of perLane) {
      times.sort((a, b) => a - b);
      for (let i = 1; i < times.length; i += 1) {
        expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(150);
      }
    }
    // The validator agrees (no tight-spacing warnings).
    expect(generated.validation.warnings.filter((w) => w.code === 'tight-spacing')).toEqual([]);
  });

  it('keeps chords and holds within their share of the chart', () => {
    expect(generated.stats.chordRatio).toBeLessThanOrEqual(0.13);
    expect(generated.stats.holdRatio).toBeLessThanOrEqual(0.15);
    for (const note of generated.chart.notes) {
      if (note.type === 'hold') {
        expect(note.durationMs).toBeGreaterThan(0);
        expect(note.durationMs! + note.timeMs).toBeLessThanOrEqual(generated.stats.chartDurationMs);
      } else {
        expect(note.durationMs).toBeUndefined();
      }
    }
    // Two notes may share an instant only as a chord (different lanes, at most two).
    const byTime = new Map<number, number>();
    for (const note of generated.chart.notes) byTime.set(note.timeMs, (byTime.get(note.timeMs) ?? 0) + 1);
    for (const [, count] of byTime) expect(count).toBeLessThanOrEqual(2);
  });

  it('puts every note on a real musical event, and most of them on a beat', () => {
    // Phase 2.1 inverted the emphasis here, deliberately. Phase 2 asserted that >70 % of notes sat
    // on a grid *beat*, which the generator achieved by charting its own grid slots; on this fixture
    // (kick on every beat, hat on every off-beat) that meant half the music was ignored. Notes are
    // now placed on detected events first — measured alignment with onsets is 1.0 — and the grid
    // only supplies the pulse where nothing was detected. `beatAlignRatio` therefore falls to ~0.58,
    // which is what the music does: the off-beat hats are real, and they are charted.
    expect(generated.stats.onsetAlignRatio).toBeGreaterThan(0.8);
    expect(generated.stats.beatAlignRatio).toBeGreaterThan(0.4);
    expect(generated.stats.gridOnlyNotes).toBeLessThan(generated.stats.noteCount);
  });

  it('reports why candidates were dropped', () => {
    expect(generated.stats.candidatesConsidered).toBeGreaterThanOrEqual(generated.stats.noteCount);
    expect(generated.stats.droppedBySilence + generated.stats.droppedByDensity).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic for one seed and varies with another', () => {
    const again = generateChart(analysis, { ...BASE_OPTIONS });
    expect(again.chart).toEqual(generated.chart);
    expect(again.stats).toEqual(generated.stats);

    const other = generateChart(analysis, { ...BASE_OPTIONS, seed: 99 });
    expect(other.stats.noteCount).toBeGreaterThan(0);
    // Same music, same rules: the event times are identical, the lanes may differ.
    expect(other.chart.notes.map((note) => note.timeMs)).toEqual(generated.chart.notes.map((note) => note.timeMs));
    expect(other.chart.generator.seed).toBe(99);
  });

  it('follows intensity: the quiet half of one track gets fewer notes than its loud half', () => {
    // Compare two halves of the *same* performance rather than two different signals. Phase 2.1
    // replaced the old "a fully quiet track gets fewer notes than a loud one" assertion, which was
    // measuring the detector rather than the generator: onset strength is gated relative to the
    // track's own level, so a uniformly quiet file produced *more* detected onsets (120 vs 82 on
    // this fixture) and the comparison had nothing to do with dynamics.
    const dynamic = summaryOf(drumTrack({ durationMs: 20000, bpm: 120, quietAfterMs: 10000, quietGain: 0.02 }));
    const chart = generateChart(dynamic, { ...BASE_OPTIONS });
    const loudHalf = chart.chart.notes.filter((note) => note.timeMs < 10000).length;
    const quietHalf = chart.chart.notes.filter((note) => note.timeMs >= 10000).length;
    expect(loudHalf).toBeGreaterThan(quietHalf * 1.2);
  });
});

describe('chart generation edge cases', () => {
  it('returns an unplayable-but-reported chart for a silent track', () => {
    const silent = summaryOf(new Float32Array(RATE * 3));
    const result = generateChart(silent, { ...BASE_OPTIONS });
    expect(result.chart.notes).toEqual([]);
    expect(result.validation.ok).toBe(false);
    expect(result.validation.errors.map((e) => e.code)).toContain('notes-empty');
  });

  it('handles a summary with no beat grid', () => {
    const result = generateChart(summary({ beats: [], onsets: [] }), { ...BASE_OPTIONS });
    expect(result.chart.notes).toEqual([]);
    expect(result.validation.ok).toBe(false);
  });

  it('refuses to generate without a tempo', () => {
    expect(() => generateChart(summary({ bpm: 0 }), { ...BASE_OPTIONS })).toThrow(/tempo/);
    expect(() => generateChart(summary({ beatMs: 0, beats: [] }), { ...BASE_OPTIONS })).toThrow(/beat grid/);
  });

  it('charts strong syncopated onsets that fall between beats', () => {
    const beatMs = 500;
    const onsets: OnsetEvent[] = Array.from({ length: 20 }, (_, index) => ({
      // 1/3 of a beat after each beat: outside the slot tolerance, so these must be placed on
      // their own rather than snapped onto the beat.
      timeMs: index * beatMs + beatMs / 3,
      strength: 0.9,
      band: index % 2 === 0 ? 'mid' : 'high',
      centroidHz: 2000,
      flux: 5,
    }));
    const result = generateChart(
      summary({ bpm: 120, beatMs, durationMs: 10000, beats: Array.from({ length: 20 }, (_, i) => i * beatMs), onsets }),
      { ...BASE_OPTIONS },
    );
    expect(result.validation.ok).toBe(true);
    const syncopated = result.chart.notes.filter((note) => Math.abs((note.timeMs % beatMs) - beatMs / 3) < 40);
    expect(syncopated.length).toBeGreaterThan(8);
    expect(result.stats.onsetAlignRatio).toBeGreaterThan(0.4);
  });

  it('drops events that would be closer than the minimum gap', () => {
    const onsets: OnsetEvent[] = [
      { timeMs: 1000, strength: 0.9, band: 'low', centroidHz: 80, flux: 5 },
      { timeMs: 1040, strength: 0.85, band: 'high', centroidHz: 6000, flux: 5 },
    ];
    const result = generateChart(summary({ bpm: 120, durationMs: 4000, onsets }), { ...BASE_OPTIONS });
    expect(result.validation.ok).toBe(true);
    expect(result.chart.notes.filter((note) => note.timeMs > 950 && note.timeMs < 1100).length).toBe(1);
  });

  it('never produces overlapping notes in one lane (validator is authoritative)', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const analysis = summaryOf(drumTrack({ durationMs: 12000, bpm: 140 }));
      const result = generateChart(analysis, { ...BASE_OPTIONS, seed });
      expect(validateBeatmap(result.chart).ok).toBe(true);
      expect(result.validation.ok).toBe(true);
    }
  });

  it('clamps note times to the audio and keeps the chart inside the song', () => {
    const analysis = summaryOf(drumTrack({ durationMs: 6000, bpm: 120 }));
    const result = generateChart(analysis, { ...BASE_OPTIONS, durationMs: 6000 });
    for (const note of result.chart.notes) {
      expect(note.timeMs).toBeGreaterThanOrEqual(0);
      expect(note.timeMs).toBeLessThanOrEqual(6000);
    }
  });

  it('is stable when the analysis is at a low tempo and has few beats', () => {
    const analysis = summary({ bpm: 60, beatMs: 1000, durationMs: 8000 });
    const result = generateChart(analysis, { ...BASE_OPTIONS });
    expect(result.validation.ok).toBe(true);
    expect(result.stats.noteCount).toBeGreaterThan(2);
    expect(result.stats.noteCount).toBeLessThan(60);
    expect(result.stats.peakNotesPerSecond).toBeLessThanOrEqual(2);
  });
});
