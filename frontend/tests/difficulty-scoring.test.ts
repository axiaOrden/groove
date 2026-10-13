/**
 * Weighted scoring and per-difficulty high scores (phase 3).
 *
 * The model under test:
 *
 *     note score = base judgment points × units × combo multiplier × difficulty weight
 *
 * Three properties matter, and all three are asserted here:
 *
 *  1. **Score is ordered as expected**: for identical play, Hard scores exactly twice Easy and
 *     Normal exactly 1.5×, because the weight multiplies every award.
 *  2. **Accuracy does not move with the weight**: the same judgments at different weights produce
 *     the same accuracy and the same grade. Accuracy stays normalised so Easy and Hard runs are
 *     comparable — which is the whole reason the weight is applied to points, not to judgments.
 *  3. **High scores are separate per song *and* difficulty**, are versioned, and keep the weight
 *     they were earned with rather than re-deriving it from a table that a later build may retune.
 *
 * Charts come out of the real generator so the tests run on the same notes a player would.
 */

import { describe, expect, it } from 'vitest';
import { analyzeMono } from '../src/analysis/MusicAnalyzer';
import { generateChartSet } from '../src/chart/DifficultySet';
import { CHART_DIFFICULTIES, difficultyProfile } from '../src/chart/Difficulty';
import { DIFFICULTY_WEIGHTS, perfectRunOrder, perfectRunScore, totalNoteUnits } from '../src/chart/ScoreModel';
import { BEATMAP_SCHEMA_VERSION, type Beatmap, type ChartNote } from '../src/chart/ChartTypes';
import { ScoreManager } from '../src/game/ScoreManager';
import { GameEngine } from '../src/game/GameEngine';
import type { SongClock } from '../src/audio/AudioSource';
import { DEFAULT_SCORE_RULES } from '../src/game/GameConfig';
import {
  MemoryScoreStore,
  SCORE_RECORD_VERSION,
  ScoreRecordError,
  decodeScoreEntry,
  encodeScoreEntry,
  entryFromSubmission,
  isBetterEntry,
  scoreKey,
  type ScoreEntry,
  type ScoreSubmission,
} from '../src/storage/ScoreStore';
import { MemorySongStore } from '../src/storage/SongLibrary';
import { chartOf, decodeSongRecord, buildSongRecord, makeSongId } from '../src/storage/SongRecord';
import { drumTrack, RATE } from './helpers/synth';

const SONG = { seed: 5, songId: 'scoring-song', title: 'Scoring Song' } as const;
const analysis = analyzeMono(drumTrack({ durationMs: 14000, bpm: 120 }), RATE);
const set = generateChartSet(analysis, SONG);

class FakeClock implements SongClock {
  now = 0;
  getSongTimeMs(): number {
    return this.now;
  }
}

/**
 * Play a whole chart perfectly and return the finished results, at the given difficulty.
 *
 * Notes are pressed in `perfectRunOrder`, the order the maximum is computed in — that is what makes
 * "a perfect run scores exactly the maximum" a statement about the same play the maximum describes.
 */
function playPerfect(difficulty: 'easy' | 'normal' | 'hard', order?: readonly ChartNote[]) {
  const chart = set.charts[difficulty]!.chart;
  const clock = new FakeClock();
  const engine = new GameEngine({ chart, clock });
  engine.begin();
  for (const note of order ?? perfectRunOrder(chart.notes)) {
    engine.pressLane(note.lane, note.timeMs);
    if (note.type === 'hold') engine.releaseLane(note.lane, note.timeMs + (note.durationMs ?? 0) - 10);
    else engine.releaseLane(note.lane, note.timeMs + 10);
  }
  engine.update((chart.durationMs ?? 0) + 60_000);
  return { chart, results: engine.getResults() };
}

describe('difficulty weights', () => {
  it('is Easy 1.0, Normal 1.5, Hard 2.0', () => {
    expect(DIFFICULTY_WEIGHTS.easy).toBe(1);
    expect(DIFFICULTY_WEIGHTS.normal).toBe(1.5);
    expect(DIFFICULTY_WEIGHTS.hard).toBe(2);
    for (const difficulty of CHART_DIFFICULTIES) {
      expect(difficultyProfile(difficulty).scoreWeight).toBe(DIFFICULTY_WEIGHTS[difficulty]);
    }
  });

  it('multiplies every award, and leaves the judgment rules untouched', () => {
    const weights = { easy: 1, normal: 1.5, hard: 2 } as const;
    for (const difficulty of CHART_DIFFICULTIES) {
      const score = new ScoreManager(DEFAULT_SCORE_RULES, { difficulty });
      expect(score.difficultyWeight).toBe(weights[difficulty]);
      // Base points are unchanged: 300 × 1.01 (combo 1) × weight.
      expect(score.awardHead('perfect').points).toBe(
        Math.round(300 * 1.01 * weights[difficulty]),
      );
      expect(score.pointsFor('good', 1, 10)).toBe(Math.round(200 * 1.1 * weights[difficulty]));
      // The combo multiplier itself is a difficulty-independent property of the combo.
      expect(score.multiplierFor(50)).toBeCloseTo(1.5, 10);
    }
    // No difficulty named keeps the pre-phase-3 arithmetic (weight 1) for pure judgment callers.
    expect(new ScoreManager().difficultyWeight).toBe(1);
    expect(new ScoreManager().awardHead('perfect').points).toBe(303);
  });

  it('applies the weight to hold tails as well as heads', () => {
    const easy = new ScoreManager(DEFAULT_SCORE_RULES, { difficulty: 'easy' });
    easy.awardHead('perfect');
    expect(easy.awardHoldTail('perfect')).toBe(303);

    const hard = new ScoreManager(DEFAULT_SCORE_RULES, { difficulty: 'hard' });
    hard.awardHead('perfect');
    expect(hard.awardHoldTail('perfect')).toBe(606);
    expect(hard.score).toBe(1212);
  });
});

describe('accuracy is independent of the difficulty weight', () => {
  it('reports the same accuracy and grade for the same judgments at any weight', () => {
    const judgments = ['perfect', 'perfect', 'good', 'bad', 'perfect', 'miss'] as const;
    const results = CHART_DIFFICULTIES.map((difficulty) => {
      const score = new ScoreManager(DEFAULT_SCORE_RULES, { difficulty });
      for (const judgment of judgments) score.awardHead(judgment);
      return score.results(judgments.length, 1000);
    });

    expect(results[0]!.accuracy).toBeCloseTo(results[1]!.accuracy, 12);
    expect(results[1]!.accuracy).toBeCloseTo(results[2]!.accuracy, 12);
    // 0.667 accuracy is a D by the documented boundaries — and the same grade at every weight.
    expect(results.map((entry) => entry.grade)).toEqual(['D', 'D', 'D']);
    // (300 + 300 + 200 + 100 + 300) / (300 × 6)
    expect(results[0]!.accuracy).toBeCloseTo(1200 / 1800, 12);
    expect(results.map((entry) => entry.counts.perfect)).toEqual([3, 3, 3]);
    // The multiplier only ever grows with combo, so the order of the judgments does not matter
    // either: PERFECT, PERFECT, GOOD reaches combo 3 before BAD resets it.
    expect(results.map((entry) => entry.maxCombo)).toEqual([3, 3, 3]);

    // Scores are ordered exactly by the weight, not re-derived from accuracy.
    expect(results[1]!.score / results[0]!.score).toBeGreaterThan(1.4);
    expect(results[2]!.score / results[0]!.score).toBeGreaterThan(1.9);
  });

  it('scales the reachable maximum by the weight and the note mix', () => {
    const notes = set.charts.hard!.chart.notes;
    const taps = notes.map((note) => ({ ...note, type: 'tap' as const, durationMs: undefined }));
    // The maximum is a *simulated* run, so the weight multiplies each award and is then rounded.
    // Weight 2 keeps every award an integer (head points are 300 + 3·combo), so it is exact;
    // weight 1.5 can land on a half point and the rounding is per award, so it is checked to the
    // nearest note (≤ 1 point per award).
    expect(perfectRunScore(notes, 2)).toBe(perfectRunScore(notes, 1) * 2);
    expect(perfectRunScore(notes, 1.5)).toBeCloseTo(perfectRunScore(notes, 1) * 1.5, -2);
    expect(perfectRunScore([], 2)).toBe(0);
    // A hold is worth two units, so the same note count with holds has a higher maximum.
    expect(totalNoteUnits(notes)).toBe(notes.length + notes.filter((n) => n.type === 'hold').length);
    if (notes.some((note) => note.type === 'hold')) {
      expect(perfectRunScore(notes, 1)).toBeGreaterThan(perfectRunScore(taps, 1));
    }
  });
});

describe('a perfect run scores its difficulty’s maximum', () => {
  it('is reachable exactly, on all three difficulties', () => {
    for (const difficulty of CHART_DIFFICULTIES) {
      const { chart, results } = playPerfect(difficulty);
      expect(results.counts.miss, `${difficulty} misses`).toBe(0);
      expect(results.accuracy).toBe(1);
      expect(results.grade).toBe('S');
      expect(results.difficulty).toBe(difficulty);
      expect(results.difficultyWeight).toBe(difficultyProfile(difficulty).scoreWeight);
      // Phase 3.1: the maximum is the score of a flawless run, so a flawless run *is* the maximum —
      // the displayed score/max percentage reaches 100 %.
      expect(results.maxScore).toBe(chart.maxScore);
      expect(results.score).toBe(results.maxScore);
      expect(results.score / results.maxScore).toBe(1);
      expect(results.totalUnits).toBe(totalNoteUnits(chart.notes));
    }
  });

  it('is the upper bound over chord orders, and a hold in a chord is where it matters', () => {
    // A hold's tail is scored at its head's multiplier, so inside one chord the total depends on
    // which note is pressed first: the maximum gives the hold head the larger combo. Two notes at
    // the same instant, one of them a hold, make that visible in four awards.
    const chordChart: Beatmap = {
      schemaVersion: BEATMAP_SCHEMA_VERSION,
      songId: 'chord-hold',
      title: 'Chord Hold',
      difficulty: 'hard',
      laneCount: 7,
      bpm: 120,
      offsetMs: 0,
      generator: { name: 'test', version: '1.0.0', seed: 1 },
      durationMs: 4000,
      notes: [
        { timeMs: 1000, lane: 0, type: 'hold', durationMs: 500 },
        { timeMs: 1000, lane: 5, type: 'tap' },
        { timeMs: 2000, lane: 3, type: 'tap' },
      ],
    };
    const held = chordChart.notes[0]!;
    const tap = chordChart.notes[1]!;
    const later = chordChart.notes[2]!;

    const play = (first: ChartNote, second: ChartNote) => {
      const engine = new GameEngine({ chart: chordChart, clock: new FakeClock() });
      engine.begin();
      for (const note of [first, second]) {
        engine.pressLane(note.lane, note.timeMs);
        engine.releaseLane(note.lane, note.timeMs + (note.type === 'hold' ? 500 : 10));
      }
      engine.pressLane(later.lane, later.timeMs);
      engine.releaseLane(later.lane, later.timeMs + 10);
      engine.update(60_000);
      return engine.getResults();
    };

    const best = play(tap, held);
    const worse = play(held, tap);
    expect(best.score).toBe(best.maxScore);
    expect(best.maxScore).toBe(perfectRunScore(chordChart.notes, 2));
    expect(best.maxScore).toBe(606 + 612 + 612 + 618);
    // The other order is a legitimate perfect run that scores a little less — never more. The
    // maximum is a property of the chart, so it is the same number for both plays.
    expect(worse.maxScore).toBe(best.maxScore);
    expect(worse.score).toBeLessThan(best.maxScore);
    expect(worse.score / worse.maxScore).toBeGreaterThan(0.99);
    expect(worse.accuracy).toBe(1);
  });

  it('computes the same maximum from the chart and from the run', () => {
    // Both sides call `perfectRunScore`: the chart layer when it writes `maxScore`, the score
    // manager when it reports results. This asserts they cannot drift.
    for (const difficulty of CHART_DIFFICULTIES) {
      const chart = set.charts[difficulty]!.chart;
      expect(chart.maxScore).toBe(perfectRunScore(chart.notes, difficultyProfile(difficulty).scoreWeight));
    }
  });

  it('never exceeds the maximum, however the run is played', () => {
    // A run that releases holds early (inside the grace window) forfeits nothing but scores the
    // tail at the head's multiplier, so it lands exactly on the maximum too; a run with a stray
    // press or a miss cannot exceed it.
    for (const difficulty of CHART_DIFFICULTIES) {
      const chart = set.charts[difficulty]!.chart;
      const clock = new FakeClock();
      const engine = new GameEngine({ chart, clock });
      engine.begin();
      for (const note of chart.notes) {
        engine.pressLane(note.lane, note.timeMs + 30);
        engine.releaseLane(note.lane, note.timeMs + (note.type === 'hold' ? (note.durationMs ?? 0) : 0) + 30);
      }
      engine.update((chart.durationMs ?? 0) + 60_000);
      const results = engine.getResults();
      expect(results.score).toBeLessThanOrEqual(results.maxScore);
      expect(results.accuracy).toBe(1);
    }
  });

  it('gives Hard a larger maximum than Normal and Normal a larger one than Easy', () => {
    const maxima = CHART_DIFFICULTIES.map((difficulty) => playPerfect(difficulty).results.maxScore);
    expect(maxima[0]).toBeLessThan(maxima[1]!);
    expect(maxima[1]).toBeLessThan(maxima[2]!);
  });

  it('a longer chart climbs closer to the capped multiplier', () => {
    // The maximum mixes two effects the docs have to state: more notes ⇒ more awards (density),
    // and a higher share of awards at the capped 2× multiplier (length). The *ratio* of a perfect
    // run to the old "every unit at 2×" bound is 0.5 + 0.0025·(n+1) for a tap-only chart, so the
    // 100 % we now report is worth remembering as "the number a flawless run scores", not "2× on
    // every note".
    const capping = (notes: number): number => 0.5 + 0.0025 * (notes + 1);
    const taps: number[] = [];
    for (let index = 0; index < 60; index += 1) taps.push(index * 500);
    const notes = taps.map((timeMs) => ({ timeMs, lane: 0, type: 'tap' as const }));
    const max = perfectRunScore(notes, 1);
    expect(max).toBeLessThan(60 * 300 * 2);
    expect(max / (60 * 300 * 2)).toBeCloseTo(capping(60), 3);
  });

  it('awards holds two units, so the maximum depends on the note mix', () => {
    const { chart, results } = playPerfect('hard');
    const holds = chart.notes.filter((note) => note.type === 'hold').length;
    expect(results.totalUnits).toBe(chart.notes.length + holds);
    expect(results.totalNotes).toBe(chart.notes.length);
  });
});

describe('the engine’s difficulty weighting', () => {
  it('uses the engine’s difficulty from the chart, and stores the weight it used', () => {
    for (const difficulty of CHART_DIFFICULTIES) {
      const chart = set.charts[difficulty]!.chart;
      const engine = new GameEngine({ chart, clock: new FakeClock() });
      expect(engine.chartDifficulty).toBe(difficulty);
      expect(engine.laneCount).toBe(difficultyProfile(difficulty).laneCount);
      expect(engine.getResults().difficultyWeight).toBe(difficultyProfile(difficulty).scoreWeight);
    }
  });

  it('keeps score deterministic across pause and resume on a weighted run', () => {
    const chart = set.charts.easy!.chart;
    const run = (withPauses: boolean): number => {
      const clock = new FakeClock();
      const engine = new GameEngine({ chart, clock });
      engine.begin();
      chart.notes.forEach((note, index) => {
        engine.pressLane(note.lane, note.timeMs);
        engine.releaseLane(note.lane, note.timeMs + 10);
        if (withPauses && index % 4 === 3) {
          engine.pause();
          engine.resume();
        }
      });
      engine.update((chart.durationMs ?? 0) + 60_000);
      return engine.getResults().score;
    };
    expect(run(true)).toBe(run(false));
  });
});

describe('high scores are separate per song and difficulty', () => {
  function submission(overrides: Partial<ScoreSubmission> = {}): ScoreSubmission {
    return {
      songId: 'song-a',
      title: 'Song A',
      difficulty: 'hard',
      difficultyWeight: 2,
      generatorVersion: '2.0.0',
      score: 10_000,
      maxScore: 40_000,
      accuracy: 0.9,
      grade: 'A',
      maxCombo: 30,
      totalNotes: 40,
      ...overrides,
    };
  }

  it('keys entries by song and difficulty', () => {
    expect(scoreKey('song-a', 'easy')).toBe('song-a::easy');
    expect(scoreKey('song-a', 'hard')).not.toBe(scoreKey('song-a', 'easy'));
    expect(scoreKey('song-a', 'hard')).not.toBe(scoreKey('song-b', 'hard'));
  });

  it('keeps one best per difficulty and never mixes them', async () => {
    const store = new MemoryScoreStore();
    const easy = await store.submit(submission({ difficulty: 'easy', difficultyWeight: 1, score: 3000 }));
    const normal = await store.submit(submission({ difficulty: 'normal', difficultyWeight: 1.5, score: 7000 }));
    const hard = await store.submit(submission({ difficulty: 'hard', difficultyWeight: 2, score: 9000 }));

    expect([easy.isBest, normal.isBest, hard.isBest]).toEqual([true, true, true]);
    expect((await store.best('song-a', 'easy'))!.score).toBe(3000);
    expect((await store.best('song-a', 'normal'))!.score).toBe(7000);
    expect((await store.best('song-a', 'hard'))!.score).toBe(9000);

    // A worse Hard run does not overwrite the best, but still counts as an attempt.
    const worse = await store.submit(submission({ difficulty: 'hard', score: 5000 }));
    expect(worse.isBest).toBe(false);
    expect(worse.entry.score).toBe(9000);
    expect(worse.attempts).toBe(2);
    expect((await store.best('song-a', 'hard'))!.score).toBe(9000);

    // A better Normal run cannot touch the Hard entry.
    const better = await store.submit(submission({ difficulty: 'normal', score: 12_000 }));
    expect(better.isBest).toBe(true);
    expect((await store.best('song-a', 'hard'))!.score).toBe(9000);
    expect((await store.best('song-a', 'normal'))!.score).toBe(12_000);

    // Two songs stay independent.
    await store.submit(submission({ songId: 'song-b', difficulty: 'hard', score: 111 }));
    expect((await store.best('song-a', 'hard'))!.score).toBe(9000);
    expect((await store.best('song-b', 'hard'))!.score).toBe(111);
    expect(await store.forSong('song-a')).toHaveLength(3);
    expect(await store.attempts('song-a', 'hard')).toBe(2);
    expect(await store.attempts('song-b', 'easy')).toBe(0);
  });

  it('breaks a score tie on accuracy', () => {
    const base = entryFromSubmission(submission());
    expect(isBetterEntry({ ...base, accuracy: 0.5 }, null)).toBe(true);
    expect(isBetterEntry({ ...base, accuracy: 0.95 }, base)).toBe(true);
    expect(isBetterEntry({ ...base, accuracy: 0.5 }, base)).toBe(false);
    expect(isBetterEntry({ ...base, score: base.score + 1 }, base)).toBe(true);
  });

  it('stores the weight a score was earned with, instead of re-deriving it', () => {
    // A score played at weight 1.0 on a chart now labelled Hard keeps its weight: a later retune of
    // the difficulty table must not silently rescale history.
    const entry = decodeScoreEntry(
      encodeScoreEntry(entryFromSubmission(submission({ difficulty: 'hard', difficultyWeight: 1 }))),
    )!;
    expect(entry.difficultyWeight).toBe(1);
    expect(SCORE_RECORD_VERSION).toBe(1);
    expect(entry.scoreVersion).toBe(SCORE_RECORD_VERSION);
    expect(entry.generatorVersion).toBe('2.0.0');
    // An entry with no weight is treated as weight 1: that is what it was played at.
    const weightless = decodeScoreEntry({
      ...entryFromSubmission(submission()),
      difficultyWeight: undefined,
    })!;
    expect(weightless.difficultyWeight).toBe(1);
  });

  it('refuses entries it cannot trust, in the same spirit as the song record', () => {
    expect(decodeScoreEntry('not json')).toBeNull();
    expect(decodeScoreEntry(null)).toBeNull();
    expect(decodeScoreEntry({})).toBeNull();
    expect(decodeScoreEntry({ ...entryFromSubmission(submission()), difficulty: 'expert' })).toBeNull();
    expect(decodeScoreEntry({ ...entryFromSubmission(submission()), songId: '' })).toBeNull();
    expect(decodeScoreEntry({ ...entryFromSubmission(submission()), score: -1 })).toBeNull();
    expect(() =>
      decodeScoreEntry({ ...entryFromSubmission(submission()), scoreVersion: SCORE_RECORD_VERSION + 1 }),
    ).toThrow(ScoreRecordError);
    expect(() =>
      decodeScoreEntry({ ...entryFromSubmission(submission()), scoreVersion: 99 }),
    ).toThrow(/newer version/);
  });

  it('round-trips through the persisted form', () => {
    const persisted = entryFromSubmission(submission({ recordedAt: '2026-10-13T10:00:00.000Z' }));
    const entry = decodeScoreEntry(encodeScoreEntry(persisted))!;
    expect(entry.recordedAt).toBe('2026-10-13T10:00:00.000Z');
    expect(decodeScoreEntry(entry)).toEqual(entry);
    expect(JSON.parse(encodeScoreEntry(persisted)).difficulty).toBe('hard');
  });
});

describe('scores live with the library and survive a reload', () => {
  it('records a run against a saved song, per difficulty', async () => {
    const facts = { name: 'My Song.mp3', sizeBytes: 4_100_000, lastModified: 1_700_000_000_000 };
    const id = makeSongId(facts, analysis.durationMs);
    const record = buildSongRecord({
      id,
      title: 'My Song',
      fileName: facts.name,
      fileSize: facts.sizeBytes,
      audio: { format: 'mp3', mimeType: 'audio/mpeg', bytes: facts.sizeBytes, stored: true, transcoded: false },
      analysis,
      charts: generateChartSet(analysis, { seed: 5, songId: id, title: 'My Song' }).charts,
      now: () => new Date('2026-10-13T10:00:00.000Z'),
    });

    const store = new MemorySongStore();
    await store.save(record, null);
    const submission = {
      songId: id,
      title: record.title,
      difficultyWeight: 2,
      generatorVersion: record.charts.hard!.generator.version,
      score: 12_345,
      maxScore: record.charts.hard!.maxScore,
      accuracy: 0.97,
      grade: 'S' as const,
      maxCombo: 100,
      totalNotes: record.charts.hard!.noteCount,
    };
    await store.scores.submit({ ...submission, difficulty: 'hard' });
    await store.scores.submit({ ...submission, difficulty: 'easy', difficultyWeight: 1, score: 4321 });

    // A reload is a fresh read of the persisted forms, chart included.
    const reloaded = decodeSongRecord(JSON.parse(JSON.stringify(record)));
    const loaded = await store.load(id);
    expect(loaded!.record.id).toBe(reloaded.id);
    // The stored chart still validates and still has the maximum the score was measured against.
    expect(chartOf(reloaded, 'hard').maxScore).toBe(record.charts.hard!.maxScore);
    const best = await store.scores.best(reloaded.id, 'hard');
    expect(best!.score).toBe(12_345);
    expect(best!.difficultyWeight).toBe(2);
    expect(best!.maxScore).toBe(record.charts.hard!.maxScore);
    expect(best!.accuracy).toBe(0.97);
    expect((await store.scores.best(reloaded.id, 'easy'))!.score).toBe(4321);
    expect(await store.scores.best(reloaded.id, 'normal')).toBeNull();
    expect((await store.scores.forSong(reloaded.id)).map((entry: ScoreEntry) => entry.difficulty)).toEqual([
      'easy',
      'hard',
    ]);
  });
});
