/**
 * Difficulty chart generation (phase 3): one analysis in, three playable charts out.
 *
 * What is asserted here is what a player would notice, and what the brief asks for explicitly:
 *
 *  - four-, five- and seven-lane charts all generate, validate, and use exactly their own lanes;
 *  - Easy and Normal are **not** Hard with lanes hidden — the lane mapping and the density budgets
 *    differ, so the three charts are genuinely different selections from the same event timeline;
 *  - note density increases with difficulty, so does the maximum chord size, and no chart exceeds
 *    its difficulty's budget;
 *  - generation is deterministic for one analysis, seed and generator version;
 *  - notes stay on the music: every note lands on a detected onset or on the beat grid, so the
 *    chart cannot drift from the audio.
 *
 * Audio fixtures come from the shared `helpers/synth` drums; the lane-mapping cases use hand-built
 * summaries, because "a kick on every beat must go to SPACE" is a rule about the mapping, not about
 * the analyser, and audio would only make it harder to read.
 */

import { describe, expect, it } from 'vitest';
import { analyzeMono } from '../src/analysis/MusicAnalyzer';
import type { AnalysisSummary, EnergyProfile, OnsetBand, OnsetEvent } from '../src/analysis/types';
import { GENERATOR_NAME, GENERATOR_VERSION, generateChart } from '../src/chart/ChartGenerator';
import {
  CHART_SET_VERSION,
  availableDifficulties,
  chartSetFromCharts,
  defaultDifficultyOf,
  deriveDifficultySeed,
  difficultySummary,
  seedForDifficulty,
  generateChartSet,
  primaryChart,
} from '../src/chart/DifficultySet';
import {
  CHART_DIFFICULTIES,
  DIFFICULTY_PROFILES,
  difficultyProfile,
  isChartDifficulty,
  keyLabelsFor,
} from '../src/chart/Difficulty';
import { laneProfileFor } from '../src/chart/LaneProfile';
import { maxTheoreticalScoreOf, perfectRunScore, totalNoteUnits } from '../src/chart/ScoreModel';
import { validateBeatmap } from '../src/chart/ChartValidator';
import { LANE_COUNT, type ChartNote } from '../src/chart/ChartTypes';
import { drumTrack, RATE } from './helpers/synth';

const SONG = { seed: 5, songId: 'phase3-song', title: 'Phase 3 Song' } as const;
const GEN = GENERATOR_NAME;
const VERS = GENERATOR_VERSION;

function analysisOf(durationMs = 20000, bpm = 120): AnalysisSummary {
  return analyzeMono(drumTrack({ durationMs, bpm }), RATE);
}

const analysis = analysisOf();
const set = generateChartSet(analysis, SONG);

/** Notes sharing an instant, i.e. the largest chord in a chart. */
function maxSimultaneous(notes: readonly ChartNote[]): number {
  const byTime = new Map<number, number>();
  for (const note of notes) byTime.set(note.timeMs, (byTime.get(note.timeMs) ?? 0) + 1);
  let most = 0;
  for (const count of byTime.values()) most = Math.max(most, count);
  return most;
}

function laneCountUsed(notes: readonly ChartNote[]): number {
  return notes.reduce((max, note) => Math.max(max, note.lane), -1) + 1;
}

describe('a chart set for every difficulty', () => {
  it('generates all three from one analysis, each with its own metadata', () => {
    expect(Object.keys(set.charts).sort()).toEqual(['easy', 'hard', 'normal']);
    expect(availableDifficulties(set)).toEqual(['easy', 'normal', 'hard']);

    for (const difficulty of CHART_DIFFICULTIES) {
      const entry = set.charts[difficulty]!;
      const profile = DIFFICULTY_PROFILES[difficulty];
      expect(entry.difficulty).toBe(difficulty);
      expect(entry.chart.difficulty).toBe(difficulty);
      expect(entry.chart.laneCount).toBe(profile.laneCount);
      expect(entry.chart.keyLabels).toEqual(profile.keys.map((key) => key.label));
      expect(entry.chart.generator.name).toBe(GENERATOR_NAME);
      expect(entry.chart.generator.version).toBe(GENERATOR_VERSION);
      // Easy and Normal hash the base seed; Hard *is* the base seed so its seven-key chart
      // reproduces the phase 2.x one (see `seedForDifficulty`).
      expect(entry.chart.generator.seed).toBe(seedForDifficulty(SONG.seed, difficulty));
      expect(entry.chart.bpm).toBe(analysis.bpm);
      expect(entry.chart.durationMs).toBe(analysis.durationMs);
      expect(entry.chart.notes.length).toBeGreaterThan(0);
      expect(entry.chart.noteDensity).toBeCloseTo(entry.stats.notesPerSecond, 2);
      expect(entry.stats.laneCount).toBe(profile.laneCount);
      expect(entry.validation.ok).toBe(true);
    }
  });

  it('keeps chart timing locked to the audio: every note is on an onset or a beat', () => {
    const beatMs = analysis.beatMs;
    for (const difficulty of CHART_DIFFICULTIES) {
      const chart = set.charts[difficulty]!.chart;
      for (const note of chart.notes) {
        const onOnset = analysis.onsets.some((onset) => Math.abs(onset.timeMs - note.timeMs) <= 60);
        const onGrid = Math.abs(note.timeMs - Math.round(note.timeMs / beatMs) * beatMs) <= 25;
        expect(onOnset || onGrid, `${difficulty} note at ${note.timeMs}ms is off the music`).toBe(true);
      }
      // …and the metrics agree that the chart follows the performance.
      const stats = set.charts[difficulty]!.stats;
      expect(stats.onsetAlignRatio).toBeGreaterThan(0.5);
      expect(stats.lastNoteEndMs).toBeLessThanOrEqual(analysis.durationMs + 1);
    }
  });

  it('uses every lane it renders, and never a lane it does not have', () => {
    for (const difficulty of CHART_DIFFICULTIES) {
      const entry = set.charts[difficulty]!;
      const lanes = entry.profile.laneCount;
      expect(entry.stats.lanesUsed).toBe(lanes);
      for (let lane = 0; lane < lanes; lane += 1) {
        expect(entry.stats.laneUsage[lane]!, `${difficulty} lane ${lane}`).toBeGreaterThan(0);
      }
      expect(laneCountUsed(entry.chart.notes)).toBeLessThanOrEqual(lanes);
      // The validator uses the chart's own lane count, so a stray lane 6 in a 4-lane chart fails.
      expect(validateBeatmap(entry.chart).ok).toBe(true);
    }
  });

  it('raises note density and chord size with difficulty, never above the budget', () => {
    const easy = set.charts.easy!;
    const normal = set.charts.normal!;
    const hard = set.charts.hard!;

    expect(easy.stats.notesPerSecond).toBeLessThan(normal.stats.notesPerSecond);
    expect(normal.stats.notesPerSecond).toBeLessThan(hard.stats.notesPerSecond);
    expect(easy.chart.notes.length).toBeLessThan(normal.chart.notes.length);
    expect(normal.chart.notes.length).toBeLessThan(hard.chart.notes.length);

    for (const entry of [easy, normal, hard]) {
      const budget = entry.profile.generation;
      expect(maxSimultaneous(entry.chart.notes)).toBeLessThanOrEqual(budget.maxChordSize);
      expect(entry.stats.maxSimultaneous).toBeLessThanOrEqual(budget.maxChordSize);
      // Holds are real holds: a positive length inside the song, and never more than the budget.
      expect(entry.stats.holdRatio).toBeLessThanOrEqual(budget.maxHoldRatio + 0.02);
      for (const note of entry.chart.notes) {
        if (note.type !== 'hold') continue;
        expect(note.durationMs).toBeGreaterThan(0);
        expect(note.timeMs + note.durationMs!).toBeLessThanOrEqual(entry.stats.chartDurationMs + 1);
      }
    }
  });

  it('keeps notes spaced playably for each difficulty', () => {
    for (const difficulty of CHART_DIFFICULTIES) {
      const entry = set.charts[difficulty]!;
      const perLane = new Map<number, number[]>();
      for (const note of entry.chart.notes) {
        const list = perLane.get(note.lane) ?? [];
        list.push(note.timeMs);
        perLane.set(note.lane, list);
      }
      for (const [, times] of perLane) {
        times.sort((a, b) => a - b);
        for (let index = 1; index < times.length; index += 1) {
          expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(
            entry.profile.generation.minLaneGapMs,
          );
        }
      }
      expect(entry.validation.warnings.filter((warning) => warning.code === 'tight-spacing')).toEqual([]);
    }
  });

  it('does not build Easy and Normal by hiding lanes of Hard', () => {
    const hard = set.charts.hard!;
    const easy = set.charts.easy!;
    // Hard restricted to the four lanes Easy has is not what Easy is.
    const hardCutDown = hard.chart.notes.filter((note) => note.lane < 4);
    expect(easy.chart.notes).not.toEqual(hardCutDown);
    expect(easy.chart.notes.length).not.toBe(hardCutDown.length);
    // Nor is it Hard's notes re-labelled onto four lanes. Both are selections from the same event
    // timeline, so the interesting case is a *shared* instant: the lane must have been chosen by
    // Easy's own lane profile, not copied from Hard's — and on a layout with no centre key, the
    // accent key Hard uses for the beat does not even exist.
    const hardLanesAt = (timeMs: number): number[] =>
      hard.chart.notes.filter((note) => note.timeMs === timeMs).map((note) => note.lane).sort();
    const shared = easy.chart.notes
      .map((note) => note.timeMs)
      .filter((timeMs, index, all) => all.indexOf(timeMs) === index && hardLanesAt(timeMs).length > 0);
    expect(shared.length).toBeGreaterThan(5);
    let differing = 0;
    for (const timeMs of shared) {
      const easyLanes = easy.chart.notes
        .filter((note) => note.timeMs === timeMs)
        .map((note) => note.lane)
        .sort();
      if (easyLanes.join() !== hardLanesAt(timeMs).join()) differing += 1;
    }
    expect(differing / shared.length).toBeGreaterThan(0.5);
  });

  it('is deterministic for the same analysis, seed and generator version', () => {
    const again = generateChartSet(analysis, SONG);
    expect(again.charts).toEqual(set.charts);
    expect(again.charts.hard!.chart.notes).toEqual(set.charts.hard!.chart.notes);
    expect(again.generator).toEqual({ name: GENERATOR_NAME, version: GENERATOR_VERSION, seed: SONG.seed });
    expect(CHART_SET_VERSION).toMatch(/^\d+\.\d+\.\d+$/);

    // A different seed reshuffles every difficulty, and each keeps its own independent seed.
    const other = generateChartSet(analysis, { ...SONG, seed: 6 });
    for (const difficulty of CHART_DIFFICULTIES) {
      expect(other.charts[difficulty]!.chart.generator.seed).toBe(seedForDifficulty(6, difficulty));
      expect(other.charts[difficulty]!.chart.notes).not.toEqual(set.charts[difficulty]!.chart.notes);
    }
    expect(deriveDifficultySeed(5, 'easy')).not.toBe(deriveDifficultySeed(5, 'hard'));
    expect(deriveDifficultySeed(5, 'hard')).toBe(deriveDifficultySeed(5, 'hard'));
  });

  it('can generate a subset of difficulties when only some are wanted', () => {
    const single = generateChartSet(analysis, { ...SONG, difficulties: ['easy'] });
    expect(availableDifficulties(single)).toEqual(['easy']);
    expect(single.charts.hard).toBeUndefined();
  });
});

describe('accents, chords and the lane mapping per difficulty', () => {
  const BEAT_MS = 500;
  const SPACE_7 = 3;
  const SPACE_5 = 2;

  function loudEnergy(durationMs: number): EnergyProfile {
    const beatCount = Math.floor(durationMs / BEAT_MS);
    return {
      frameDb: [],
      frameMs: 11.6,
      peakDb: -20,
      meanDb: -20,
      floorDb: -65,
      activeRanges: [{ startMs: 0, endMs: durationMs }],
      lowEnergyRanges: [],
      intensityByBeat: new Array<number>(beatCount).fill(0.9),
      onsetsPerSecond: new Array<number>(Math.ceil(durationMs / 1000)).fill(4),
    };
  }

  function onset(timeMs: number, band: OnsetBand, strength = 0.7): OnsetEvent {
    return { timeMs, strength, band, centroidHz: band === 'low' ? 80 : band === 'high' ? 6000 : 1500, flux: 5 };
  }

  function handBuilt(onsets: OnsetEvent[], durationMs = 20000): AnalysisSummary {
    return {
      bpm: 120,
      beatMs: BEAT_MS,
      firstBeatMs: 0,
      beats: Array.from({ length: Math.floor(durationMs / BEAT_MS) }, (_, index) => index * BEAT_MS),
      onsets,
      energy: loudEnergy(durationMs),
      durationMs,
      beatConfidence: 0.8,
      beatAlignRatio: 0.7,
      barPhase: { phase: 0, scores: [1, 0.6, 0.8, 0.5], margin: 0.2, downbeatMs: 0 },
    };
  }

  /** Kick on every beat, accent every four, off-beat hats: a chartable groove with a clear pulse. */
  function drumBreakdown(durationMs = 20000): OnsetEvent[] {
    const onsets: OnsetEvent[] = [];
    for (let timeMs = 0; timeMs + BEAT_MS <= durationMs; timeMs += BEAT_MS) {
      const beat = Math.round(timeMs / BEAT_MS);
      onsets.push(onset(timeMs, 'low', beat % 4 === 0 ? 1 : 0.8));
      onsets.push(onset(timeMs + BEAT_MS / 2, 'high', 0.5));
    }
    return onsets;
  }

  const groove = generateChartSet(handBuilt(drumBreakdown()), { seed: 11, songId: 'groove', title: 'Groove' });

  function usageOf(notes: readonly ChartNote[], lanes: number): number[] {
    const usage = new Array<number>(lanes).fill(0);
    for (const note of notes) usage[note.lane] = (usage[note.lane] ?? 0) + 1;
    return usage;
  }

  it('sends the primary beat to SPACE on the layouts that have one', () => {
    expect(laneProfileFor(7).centerLane).toBe(SPACE_7);
    expect(laneProfileFor(5).centerLane).toBe(SPACE_5);
    // An even lane count has no middle key at all: the accent pair takes the beat instead.
    expect(laneProfileFor(4).centerLane).toBeNull();

    expect(usageOf(groove.charts.hard!.chart.notes, 7)[SPACE_7]!).toBeGreaterThan(0);
    expect(usageOf(groove.charts.normal!.chart.notes, 5)[SPACE_5]!).toBeGreaterThan(0);
    expect(groove.charts.normal!.stats.spaceRatio).toBeGreaterThan(0);
    // Four lanes cannot render a SPACE lane, so it must never be used.
    expect(laneCountUsed(groove.charts.easy!.chart.notes)).toBeLessThanOrEqual(4);
  });

  it('keeps a key’s colour-carrying role stable across lane counts', () => {
    // Easy (A S K L) and Hard (A S D SPACE J K L) share A, S, K, L: the accents that land on the
    // centre pair of Easy land on keys that exist in both layouts, which is what makes an Easy
    // chart readable to somebody who has played Hard.
    const easy = groove.charts.easy!;
    const usage = usageOf(easy.chart.notes, 4);
    expect(usage[1]! + usage[2]!).toBeGreaterThan(usage[0]! + usage[3]!);
    expect(keyLabelsFor(4)).toEqual(['A', 'S', 'K', 'L']);
    expect(keyLabelsFor(5)).toEqual(['A', 'S', 'SPACE', 'K', 'L']);
    expect(keyLabelsFor(7)).toEqual(['A', 'S', 'D', 'SPACE', 'J', 'K', 'L']);
  });

  it('never adds notes just to make a chart harder', () => {
    // Every note of every chart must come from a candidate event: the generator cannot invent notes,
    // so the note count can never exceed the number of candidates it considered.
    for (const difficulty of CHART_DIFFICULTIES) {
      const stats = set.charts[difficulty]!.stats;
      expect(stats.candidatesConsidered).toBeGreaterThanOrEqual(stats.noteCount);
      expect(stats.gridOnlyNotes).toBeLessThanOrEqual(stats.noteCount);
    }
  });

  it('honours an explicit lane count and chord size passed to the generator', () => {
    const six = generateChart(analysis, { ...SONG, laneCount: 6, difficulty: 'normal', maxChordSize: 2 });
    expect(six.chart.laneCount).toBe(6);
    expect(six.stats.laneCount).toBe(6);
    expect(maxSimultaneous(six.chart.notes)).toBeLessThanOrEqual(2);
    expect(laneCountUsed(six.chart.notes)).toBeLessThanOrEqual(6);
    // A derived profile keeps the mapping total for a lane count without a tuned table.
    expect(laneProfileFor(6).allLanes).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('maximum theoretical score', () => {
  it('is the score of a flawless run of the chart, at its difficulty weight', () => {
    for (const difficulty of CHART_DIFFICULTIES) {
      const entry = set.charts[difficulty]!;
      const expected = perfectRunScore(entry.chart.notes, entry.profile.scoreWeight);
      expect(entry.chart.maxScore).toBe(expected);
      expect(maxTheoreticalScoreOf(entry.chart.notes, entry.profile.scoreWeight)).toBe(expected);
      // Strictly below the "every unit at the capped 2× multiplier" bound: the first notes of a real
      // run are worth 1×, and reaching 2× takes 100 combo. Phase 3.1 replaced that unreachable bound
      // with this reachable one.
      const cappedBound = totalNoteUnits(entry.chart.notes) * 300 * 2 * entry.profile.scoreWeight;
      expect(entry.chart.maxScore).toBeLessThan(cappedBound);
    }
  });

  it('rises with both note density and difficulty weight', () => {
    // A hold is worth two units, so the same note count at a higher hold ratio raises the maximum:
    // the maximum is a property of the note *mix*, not only of how many notes there are.
    const mixed: ChartNote[] = [
      { timeMs: 0, lane: 0, type: 'tap' },
      { timeMs: 500, lane: 1, type: 'hold', durationMs: 200 },
    ];
    const tapsOnly: ChartNote[] = [
      { timeMs: 0, lane: 0, type: 'tap' },
      { timeMs: 500, lane: 1, type: 'tap' },
    ];
    expect(totalNoteUnits(mixed)).toBe(3);
    expect(totalNoteUnits(tapsOnly)).toBe(2);
    expect(maxTheoreticalScoreOf(mixed, 1)).toBeGreaterThan(maxTheoreticalScoreOf(tapsOnly, 1));

    // Weight scaling is per award: exact at ×2 (every award is an integer), and within a point or
    // two per note at ×1.5, where the rounding can land on a half point.
    const notes = set.charts.easy!.chart.notes;
    const easy = maxTheoreticalScoreOf(notes, 1);
    expect(maxTheoreticalScoreOf(notes, 2)).toBe(easy * 2);
    expect(maxTheoreticalScoreOf(notes, 1.5)).toBeCloseTo(easy * 1.5, -2);

    // And the real charts: a denser, heavier chart has the bigger maximum.
    const maxima = CHART_DIFFICULTIES.map((difficulty) => difficultySummary(set, difficulty)!.maxScore);
    expect(maxima[0]).toBeLessThan(maxima[1]!);
    expect(maxima[1]).toBeLessThan(maxima[2]!);
  });
});

describe('chart sets without a full analysis', () => {
  it('treats a hand-built or legacy set as a set of one, without faking the others', () => {
    const hard = set.charts.hard!;
    const single = chartSetFromCharts({
      songId: 'legacy',
      title: 'Legacy',
      durationMs: hard.chart.durationMs ?? 0,
      bpm: hard.chart.bpm,
      generator: { ...hard.chart.generator },
      charts: [hard],
    });
    expect(availableDifficulties(single)).toEqual(['hard']);
    expect(defaultDifficultyOf(single)).toBe('hard');
    expect(primaryChart(single)).toEqual({ difficulty: 'hard', chart: hard.chart });
    expect(difficultySummary(single, 'easy')).toBeNull();
    expect(single.warnings).toEqual([]);
  });

  it('opens a set on Hard, and on the hardest available when Hard is absent', () => {
    expect(defaultDifficultyOf(set)).toBe('hard');
    const easyOnly = generateChartSet(analysis, { ...SONG, difficulties: ['easy'] });
    expect(defaultDifficultyOf(easyOnly)).toBe('easy');
    const two = generateChartSet(analysis, { ...SONG, difficulties: ['easy', 'normal'] });
    expect(defaultDifficultyOf(two)).toBe('normal');
    expect(primaryChart(two, 'hard')?.difficulty).toBe('normal');
    expect(availableDifficulties(chartSetFromCharts({
      songId: 'empty',
      title: 'Empty',
      durationMs: 1000,
      bpm: 120,
      generator: { name: GEN, version: VERS, seed: 1 },
      charts: [],
    }))).toEqual([]);
  });

  it('guards the difficulty values the schema and the UI must agree on', () => {
    expect(CHART_DIFFICULTIES).toEqual(['easy', 'normal', 'hard']);
    expect(isChartDifficulty('normal')).toBe(true);
    expect(isChartDifficulty('expert')).toBe(false);
    expect(isChartDifficulty(undefined)).toBe(false);
    // `expert` stays a valid *schema* value and falls back to the hard profile.
    expect(difficultyProfile('hard').laneCount).toBe(LANE_COUNT);
  });
});
