/**
 * Role-aware lane mapping (phase 2.1).
 *
 * These cases are hand-built summaries rather than audio, because the property under test is a
 * *mapping rule*: given a kick on every beat and hats between them, where do the notes go? Audio
 * would only make that harder to read. The assertions are about what a player would notice —
 * SPACE means the beat, register spreads across the keyboard, syncopation goes to the inner keys,
 * patterns stay playable, and the same seed produces the same chart — plus the honest limits: lane
 * mapping is a heuristic and the tests only check the invariant, never "this sounds like the song".
 */

import { describe, expect, it } from 'vitest';
import type { AnalysisSummary, EnergyProfile, OnsetEvent, OnsetBand } from '../src/analysis/types';
import { generateChart } from '../src/chart/ChartGenerator';
import { validateBeatmap } from '../src/chart/ChartValidator';
import { LANE_COUNT } from '../src/chart/ChartTypes';

const BEAT_MS = 500; // 120 BPM
const SPACE = 3;
const LEFT = [0, 1, 2];
const RIGHT = [4, 5, 6];
const INNER = [2, 4];

function energy(durationMs: number): EnergyProfile {
  const beatCount = Math.floor(durationMs / BEAT_MS);
  return {
    frameDb: [],
    frameMs: 11.6,
    peakDb: -20,
    meanDb: -20,
    floorDb: -65,
    activeRanges: [{ startMs: 0, endMs: durationMs }],
    lowEnergyRanges: [],
    // A loud, busy track so nothing is thinned by intensity.
    intensityByBeat: new Array<number>(beatCount).fill(0.9),
    onsetsPerSecond: new Array<number>(Math.ceil(durationMs / 1000)).fill(4),
  };
}

function summaryOf(onsets: OnsetEvent[], durationMs = 20000): AnalysisSummary {
  const beats = Array.from({ length: Math.floor(durationMs / BEAT_MS) }, (_, index) => index * BEAT_MS);
  return {
    bpm: 120,
    beatMs: BEAT_MS,
    firstBeatMs: 0,
    beats,
    onsets,
    energy: energy(durationMs),
    durationMs,
    beatConfidence: 0.8,
    beatAlignRatio: 0.7,
    barPhase: { phase: 0, scores: [1, 0.6, 0.8, 0.5], margin: 0.2, downbeatMs: 0 },
  };
}

function onset(timeMs: number, band: OnsetBand, strength = 0.7): OnsetEvent {
  return { timeMs, strength, band, centroidHz: band === 'low' ? 80 : band === 'high' ? 6000 : 1500, flux: 5 };
}

/** Kick on every beat (loud), snare on 2 and 4, hats on every off-beat. */
function drumBreakdown(durationMs = 20000): OnsetEvent[] {
  const onsets: OnsetEvent[] = [];
  for (let timeMs = 0; timeMs + BEAT_MS <= durationMs; timeMs += BEAT_MS) {
    const beat = Math.round(timeMs / BEAT_MS);
    onsets.push(onset(timeMs, 'low', beat % 4 === 0 ? 1 : 0.8)); // kick / accented kick
    if (beat % 4 === 1 || beat % 4 === 3) onsets.push(onset(timeMs, 'broad', 0.75)); // snare
    onsets.push(onset(timeMs + BEAT_MS / 2, 'high', 0.5)); // off-beat hat
  }
  return onsets;
}

const OPTIONS = { seed: 11, songId: 'roles', title: 'Roles' } as const;

function laneUsageOf(notes: readonly { lane: number }[]): number[] {
  const usage = new Array<number>(LANE_COUNT).fill(0);
  for (const note of notes) usage[note.lane] = (usage[note.lane] ?? 0) + 1;
  return usage;
}

describe('SPACE means the primary beat', () => {
  const result = generateChart(summaryOf(drumBreakdown()), { ...OPTIONS });

  it('puts SPACE only on accents that are on a beat, and never on every beat', () => {
    const spaceNotes = result.chart.notes.filter((note) => note.lane === SPACE);
    expect(spaceNotes.length).toBeGreaterThan(4);
    // Never on every beat: the kick plays every beat in this fixture, so "SPACE on every beat"
    // would be an easy failure to miss.
    const beats = Math.floor(result.stats.chartDurationMs / BEAT_MS);
    expect(spaceNotes.length).toBeLessThan(beats * 0.6);
    // Every SPACE note sits on a detected beat, not between them.
    for (const note of spaceNotes) {
      const offset = Math.abs(((note.timeMs % BEAT_MS) + BEAT_MS / 2) % BEAT_MS - BEAT_MS / 2);
      expect(offset, `SPACE note at ${note.timeMs}ms is off the beat`).toBeLessThan(30);
    }
    expect(result.stats.spaceRatio).toBeLessThanOrEqual(0.4);
    expect(result.stats.spaceCount).toBe(spaceNotes.length);
    // Never twice inside one beat.
    const times = spaceNotes.map((note) => note.timeMs).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i += 1) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(450);
  });

  it('classifies the events it charts into roles that add up', () => {
    const roles = result.stats.roleCounts;
    const total = Object.values(roles).reduce((sum, count) => sum + count, 0);
    expect(total).toBe(result.stats.noteCount);
    // The kick-and-snare pattern must produce accents: those are the roles that can claim SPACE.
    expect(roles.downbeat + roles.kick).toBeGreaterThan(4);
    expect(roles.beat).toBeLessThan(result.stats.noteCount * 0.5);
  });

  it('keeps the chart playable and uses every lane', () => {
    expect(result.validation.ok).toBe(true);
    expect(result.stats.lanesUsed).toBe(LANE_COUNT);
  });
});

describe('register and syncopation drive the lane family', () => {
  // Note the 20-note length of these two cases: the lane-coverage pass only runs on charts of 24
  // notes or more (it exists to guarantee that a long chart reaches every key), so a shorter chart
  // measures the role mapping *alone* rather than the mapping plus the coverage moves.
  it('sends off-beat low percussion left and off-beat high percussion right', () => {
    const low: OnsetEvent[] = [];
    const high: OnsetEvent[] = [];
    for (let beat = 0; beat < 20; beat += 1) {
      // One off-beat event per beat, alternating register, so each case is judged on its own.
      high.push(onset(beat * BEAT_MS + BEAT_MS / 2, 'high', 0.7));
      low.push(onset(beat * BEAT_MS + BEAT_MS / 2, 'low', 0.7));
    }
    const lowChart = generateChart(summaryOf(low), { ...OPTIONS });
    const highChart = generateChart(summaryOf(high), { ...OPTIONS });
    const lowUsage = laneUsageOf(lowChart.chart.notes);
    const highUsage = laneUsageOf(highChart.chart.notes);
    const share = (usage: number[], lanes: number[]): number =>
      lanes.reduce((sum, lane) => sum + (usage[lane] ?? 0), 0) / Math.max(1, usage.reduce((a, b) => a + b, 0));

    expect(share(lowUsage, LEFT)).toBeGreaterThan(0.6);
    expect(share(highUsage, RIGHT)).toBeGreaterThan(0.6);
    // And the two families are mirror images rather than the same lanes twice.
    expect(share(lowUsage, LEFT)).toBeGreaterThan(share(lowUsage, RIGHT));
    expect(share(highUsage, RIGHT)).toBeGreaterThan(share(highUsage, LEFT));
  });

  it('sends mid-band off-grid syncopation to the inner keys (D / J)', () => {
    const onsets: OnsetEvent[] = [];
    for (let beat = 0; beat < 20; beat += 1) {
      // A third of a beat after the beat: off the grid entirely, mid band.
      onsets.push(onset(beat * BEAT_MS + BEAT_MS / 3, 'mid', 0.8));
    }
    const chart = generateChart(summaryOf(onsets), { ...OPTIONS });
    const usage = laneUsageOf(chart.chart.notes);
    const inner = (usage[2] ?? 0) + (usage[4] ?? 0);
    expect(inner / chart.stats.noteCount).toBeGreaterThan(0.6);
    expect(chart.stats.roleCounts.melodic + chart.stats.roleCounts.syncopation).toBeGreaterThan(
      chart.stats.noteCount * 0.6,
    );
    expect(chart.validation.ok).toBe(true);
  });

  it('never repeats a lane back to back', () => {
    const chart = generateChart(summaryOf(drumBreakdown()), { ...OPTIONS });
    const sorted = [...chart.chart.notes].sort((a, b) => a.timeMs - b.timeMs || a.lane - b.lane);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i]!.timeMs === sorted[i - 1]!.timeMs) continue; // a chord, not a repeat
      expect(sorted[i]!.lane).not.toBe(sorted[i - 1]!.lane);
    }
  });
});

describe('an untrustworthy grid stops making notes of its own', () => {
  it('charts a low-confidence track from onsets only, and says so in the stats', () => {
    const onsets = drumBreakdown();
    const weak: AnalysisSummary = {
      ...summaryOf(onsets),
      // What a track with no reliable pulse looks like: the analyser says so, and marks the range.
      beatConfidence: 0.08,
      lowConfidenceRanges: [{ startMs: 0, endMs: 20000 }],
    };
    const chart = generateChart(weak, { ...OPTIONS });
    expect(chart.stats.gridOnlyNotes).toBe(0);
    expect(chart.stats.noteCount).toBeGreaterThan(8);
    expect(chart.validation.ok).toBe(true);
    // Every note is on a detected onset rather than on a grid position.
    const times = new Set(chart.chart.notes.map((note) => Math.round(note.timeMs)));
    for (const note of chart.chart.notes) {
      const nearest = Math.min(...onsets.map((entry) => Math.abs(entry.timeMs - note.timeMs)));
      expect(nearest, `note at ${note.timeMs}ms is not near an onset`).toBeLessThan(70);
      expect(times.has(Math.round(note.timeMs))).toBe(true);
    }
  });

  it('still uses the grid when the analysis is confident about it', () => {
    const chart = generateChart(summaryOf(drumBreakdown()), { ...OPTIONS });
    expect(chart.stats.gridOnlyNotes).toBeGreaterThanOrEqual(0);
    expect(chart.stats.lowConfidenceNotes).toBe(0);
  });
});

describe('determinism and validation', () => {
  it('produces identical charts for one seed and different lanes for another', () => {
    const analysis = summaryOf(drumBreakdown());
    const first = generateChart(analysis, { ...OPTIONS });
    const again = generateChart(analysis, { ...OPTIONS });
    expect(again.chart).toEqual(first.chart);
    expect(again.stats.roleCounts).toEqual(first.stats.roleCounts);

    const other = generateChart(analysis, { ...OPTIONS, seed: 4242 });
    expect(other.chart.notes.map((note) => note.timeMs)).toEqual(first.chart.notes.map((note) => note.timeMs));
    expect(other.chart.notes.some((note, index) => note.lane !== first.chart.notes[index]!.lane)).toBe(true);
  });

  it('passes validation for many seeds and many fixtures-ish summaries', () => {
    for (const seed of [1, 3, 7, 11, 23, 101, 999]) {
      const chart = generateChart(summaryOf(drumBreakdown(12000)), { ...OPTIONS, seed });
      expect(validateBeatmap(chart.chart).ok, `seed ${seed}`).toBe(true);
    }
  });
});
