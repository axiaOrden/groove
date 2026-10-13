/**
 * Library tests: the record schema, the conversion back into a playable chart, the untrusted-input
 * validation, and a full save → list → load → delete round trip through a store.
 *
 * Phase 3 changed the stored shape: one record now carries a **map of charts** (easy / normal /
 * hard) generated from a single analysis, and the version-1 shape (a single seven-key `chart`) is
 * migrated to `charts.hard` on the way in. Both are covered here, because "previously imported music
 * still plays" is a requirement, not a nicety.
 *
 * The round trip here runs against `MemorySongStore`, which implements the same `SongStore`
 * interface as the IndexedDB store — the browser check covers the real database. What is asserted
 * where it matters is shape-independent: a saved song reopens **without re-analysis**, its charts
 * still validate, and its summary carries everything the picker shows.
 */

import { describe, expect, it } from 'vitest';
import { analyzeMono } from '../src/analysis/MusicAnalyzer';
import { generateChartSet } from '../src/chart/DifficultySet';
import { CHART_DIFFICULTIES } from '../src/chart/Difficulty';
import { validateBeatmap } from '../src/chart/ChartValidator';
import type { Beatmap } from '../src/chart/ChartTypes';
import {
  buildSongRecord,
  chartOf,
  chartSetOf,
  decodeSongRecord,
  encodeSongRecord,
  makeSongId,
  primaryDifficulty,
  recordDifficulties,
  SONG_RECORD_VERSION,
  SongRecordError,
  summarize,
  titleFromFileName,
  type SongRecord,
} from '../src/storage/SongRecord';
import { MemorySongStore, openSongLibrary } from '../src/storage/SongLibrary';
import { clickTrack, drumTrack, RATE } from './helpers/synth';

interface Fixture {
  record: SongRecord;
  charts: Record<string, Beatmap>;
}

const FACTS = { name: 'My Song.mp3', sizeBytes: 4_100_000, lastModified: 1_700_000_000_000 };

/** A full phase-3 record: one analysis, three generated charts, saved as a version-2 record. */
function fixture(seed = 5): Fixture {
  const analysis = analyzeMono(drumTrack({ durationMs: 14000, bpm: 120 }), RATE);
  const id = makeSongId(FACTS, analysis.durationMs);
  const set = generateChartSet(analysis, { seed, songId: id, title: 'My Song', artist: 'Someone' });
  const record = buildSongRecord({
    id,
    title: 'My Song',
    artist: 'Someone',
    fileName: FACTS.name,
    fileSize: FACTS.sizeBytes,
    audio: {
      format: 'mp3',
      mimeType: 'audio/mpeg',
      bytes: FACTS.sizeBytes,
      stored: true,
      transcoded: false,
    },
    analysis,
    charts: set.charts,
    now: () => new Date('2026-10-13T10:00:00.000Z'),
  });
  const charts: Record<string, Beatmap> = {};
  for (const difficulty of CHART_DIFFICULTIES) {
    const entry = set.charts[difficulty];
    if (entry) charts[difficulty] = entry.chart;
  }
  return { record, charts };
}

/** A stored song from before phase 3: one seven-key chart under the old `chart` key. */
function legacyRecord(fixtureSource = fixture()): Record<string, unknown> {
  const { record, charts } = fixtureSource;
  const hard = charts.hard!;
  return {
    ...record,
    recordVersion: 1,
    charts: undefined,
    chart: {
      schemaVersion: hard.schemaVersion,
      difficulty: 'normal',
      generator: { ...hard.generator },
      noteCount: hard.notes.length,
      notes: hard.notes.map((note) => ({ ...note })),
      stats: { ...record.charts.hard!.stats },
      validation: { ok: true, errors: [], warnings: [] },
    },
  };
}

describe('song ids and titles', () => {
  it('derives a stable id from the file, so re-importing replaces the entry', () => {
    const facts = { name: 'song.mp3', sizeBytes: 1000, lastModified: 5 };
    expect(makeSongId(facts, 30000)).toBe(makeSongId(facts, 30000));
    expect(makeSongId(facts, 30000)).not.toBe(makeSongId(facts, 30001));
    expect(makeSongId(facts, 30000)).not.toBe(makeSongId({ ...facts, name: 'other.mp3' }, 30000));
  });

  it('turns a file name into a title', () => {
    expect(titleFromFileName('Rick Astley - Never Gonna Give You Up.mp3')).toBe(
      'Rick Astley - Never Gonna Give You Up',
    );
    expect(titleFromFileName('my_song___v2.flac')).toBe('my song v2');
    expect(titleFromFileName('.mp3')).toBe('Untitled');
  });
});

describe('record → chart', () => {
  it('stores all three difficulties from one analysis', () => {
    const { record, charts } = fixture();
    expect(recordDifficulties(record)).toEqual(['easy', 'normal', 'hard']);
    expect(record.charts.easy!.laneCount).toBe(4);
    expect(record.charts.normal!.laneCount).toBe(5);
    expect(record.charts.hard!.laneCount).toBe(7);
    // Each chart's notes belong to its own lane count — nothing was copied from Hard and cut down.
    expect(charts.easy!.notes.length).toBeLessThan(charts.hard!.notes.length);
    expect(Math.max(...charts.easy!.notes.map((note) => note.lane))).toBeLessThan(4);
    expect(Math.max(...charts.normal!.notes.map((note) => note.lane))).toBeLessThan(5);
  });

  it('rebuilds the exact chart without any analysis', () => {
    const { record, charts } = fixture();
    for (const difficulty of CHART_DIFFICULTIES) {
      const rebuilt = chartOf(record, difficulty);
      expect(rebuilt.notes).toEqual(charts[difficulty]!.notes);
      // Tempo comes from the stored record, so the rebuilt chart keeps the analysed BPM exactly.
      expect(rebuilt.bpm).toBe(record.bpm);
      expect(rebuilt.bpm).toBeGreaterThan(110);
      expect(rebuilt.songId).toBe(record.id);
      expect(rebuilt.difficulty).toBe(difficulty);
      expect(validateBeatmap(rebuilt).ok).toBe(true);
    }
  });

  it('opens a saved song on Hard, and that is what a legacy record has too', () => {
    const { record } = fixture();
    expect(primaryDifficulty(record)).toBe('hard');
    expect(chartOf(record).difficulty).toBe('hard');
    // Legacy records only ever had the seven-key chart, which is Hard (see the tests below).
    const migrated = decodeSongRecord(legacyRecord());
    expect(primaryDifficulty(migrated)).toBe('hard');
  });

  it('re-validates on the way out, so a corrupted note list cannot reach the engine', () => {
    const { record } = fixture();
    const corrupted: SongRecord = {
      ...record,
      charts: {
        ...record.charts,
        hard: { ...record.charts.hard!, notes: [{ timeMs: 1000, lane: 99, type: 'tap' }] },
      },
    };
    // `chartOf` throws (prepareBeatmap), and `summarize` reports instead of throwing.
    expect(() => chartOf(corrupted, 'hard')).toThrow();
    const summary = summarize(corrupted);
    expect(summary.validationOk).toBe(false);
    expect(summary.charts.find((entry) => entry.difficulty === 'hard')!.validationOk).toBe(false);
  });

  it('rejects a note that belongs to another difficulty’s lane count', () => {
    const { record } = fixture();
    // A five-lane chart may not carry a lane-6 note: the player has no key for it.
    const wrongLanes: SongRecord = {
      ...record,
      charts: {
        ...record.charts,
        normal: { ...record.charts.normal!, notes: [{ timeMs: 500, lane: 6, type: 'tap' }] },
      },
    };
    expect(() => chartOf(wrongLanes, 'normal')).toThrow();
    expect(validateBeatmap(chartOf(record, 'easy')).ok).toBe(true);
  });

  it('summarises for the library list without carrying the notes', () => {
    const { record } = fixture();
    const summary = summarize(record);
    expect(summary.title).toBe('My Song');
    expect(summary.noteCount).toBe(record.charts.hard!.notes.length);
    expect(summary.difficulty).toBe('hard');
    expect(summary.difficulties).toEqual(['easy', 'normal', 'hard']);
    expect(summary.charts.map((entry) => entry.laneCount)).toEqual([4, 5, 7]);
    expect(summary.charts.map((entry) => entry.scoreWeight)).toEqual([1, 1.5, 2]);
    expect(summary.charts.every((entry) => entry.maxScore > 0)).toBe(true);
    expect(summary.audio.format).toBe('mp3');
    expect('notes' in summary).toBe(false);
    expect(summary.validationOk).toBe(true);
  });

  it('exposes the same charts as a chart set, for the difficulty switcher', () => {
    const { record } = fixture();
    const set = chartSetOf(record);
    expect(Object.keys(set.charts).sort()).toEqual(['easy', 'hard', 'normal']);
    expect(set.charts.normal!.chart.laneCount).toBe(5);
    expect(set.charts.easy!.validation.ok).toBe(true);
  });
});

describe('record serialisation', () => {
  it('round-trips through JSON', () => {
    const { record } = fixture();
    const decoded = decodeSongRecord(encodeSongRecord(record));
    expect(decoded).toEqual(record);
  });

  it('accepts an object as well as a JSON string', () => {
    const { record } = fixture();
    expect(decodeSongRecord(record).id).toBe(record.id);
  });

  it('refuses records it cannot trust, with a message worth showing', () => {
    const { record } = fixture();
    const cases: Array<[unknown, RegExp]> = [
      [null, /not a JSON object/],
      ['{"recordVersion":1', /not valid JSON/],
      [{ ...record, recordVersion: undefined }, /no record version/],
      [{ ...record, recordVersion: SONG_RECORD_VERSION + 1 }, /newer version/],
      [{ ...record, id: '' }, /no id/],
      [{ ...record, title: '' }, /no title/],
      [{ ...record, bpm: 0 }, /no usable tempo/],
      [{ ...record, beatMs: 0 }, /no usable beat length/],
      [{ ...record, charts: { hard: { ...record.charts.hard!, notes: [] } } }, /no chart notes/],
      [{ ...record, charts: { insane: record.charts.hard } }, /unknown difficulty/],
      [{ ...record, charts: { hard: { ...record.charts.hard!, schemaVersion: 99 } } }, /schema v99/],
    ];
    for (const [value, pattern] of cases) {
      expect(() => decodeSongRecord(value)).toThrow(SongRecordError);
      expect(() => decodeSongRecord(value)).toThrow(pattern);
    }
  });
});

describe('legacy (version 1) records', () => {
  it('migrates the single seven-key chart to hard and leaves the others absent', () => {
    const { charts } = fixture();
    const migrated = decodeSongRecord(legacyRecord());
    expect(migrated.recordVersion).toBe(1);
    expect(recordDifficulties(migrated)).toEqual(['hard']);
    expect(migrated.charts.hard!.laneCount).toBe(7);
    // The notes survive the migration byte for byte, so an old song plays exactly as it did.
    expect(chartOf(migrated, 'hard').notes).toEqual(charts.hard!.notes);
    expect(validateBeatmap(chartOf(migrated, 'hard')).ok).toBe(true);
  });

  it('does not invent the missing difficulties from a chart that has no analysis', () => {
    const migrated = decodeSongRecord(legacyRecord());
    expect(migrated.charts.easy).toBeUndefined();
    expect(migrated.charts.normal).toBeUndefined();
    // Asking for one is a readable error rather than an empty chart.
    expect(() => chartOf(migrated, 'easy')).toThrow(/no easy chart/);
    // ...and the set simply does not contain it, which is how the picker reports "unavailable".
    expect(Object.keys(chartSetOf(migrated).charts)).toEqual(['hard']);
  });

  it('keeps a migrated record valid for the summary and the diagnostics panel', () => {
    const migrated = decodeSongRecord(legacyRecord());
    const summary = summarize(migrated);
    expect(summary.difficulties).toEqual(['hard']);
    expect(summary.charts[0]!.noteCount).toBeGreaterThan(0);
    expect(summary.validationOk).toBe(true);
    // Pre-phase-3 analysis metadata is zeroed rather than invented.
    const noAnalysis = decodeSongRecord({ ...legacyRecord(), analysis: undefined });
    expect(noAnalysis.analysis.beatAlignRatio).toBe(0);
    expect(noAnalysis.analysis.sections).toEqual([]);
  });
});

describe('MemorySongStore round trip', () => {
  it('saves, lists, loads and deletes', async () => {
    const store = new MemorySongStore();
    const { record, charts } = fixture();
    const audio = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/mpeg' });
    await store.save(record, { id: record.id, blob: audio, mimeType: 'audio/mpeg' });

    expect(await store.count()).toBe(1);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(record.id);
    expect(list[0]!.difficulties).toEqual(['easy', 'normal', 'hard']);

    const loaded = await store.load(record.id);
    expect(loaded).not.toBeNull();
    for (const difficulty of CHART_DIFFICULTIES) {
      expect(loaded!.record.charts[difficulty]!.notes).toEqual(charts[difficulty]!.notes);
      expect(chartOf(loaded!.record, difficulty).notes).toEqual(charts[difficulty]!.notes);
    }
    expect(loaded!.audio).not.toBeNull();
    expect(loaded!.audio!.size).toBe(4);
    // Reopening needs no analysis: the charts and the grid numbers are all present.
    expect(loaded!.record.analysis.onsetCount).toBe(record.analysis.onsetCount);
    expect(loaded!.record.analysis.sections.length).toBe(record.analysis.sections.length);

    await store.remove(record.id);
    expect(await store.count()).toBe(0);
    expect(await store.load(record.id)).toBeNull();
  });

  it('drops the song’s scores with the song', async () => {
    const store = new MemorySongStore();
    const { record } = fixture();
    await store.save(record, null);
    await store.scores.submit({
      songId: record.id,
      title: record.title,
      difficulty: 'hard',
      difficultyWeight: 2,
      generatorVersion: '2.0.0',
      score: 1234,
      maxScore: 40000,
      accuracy: 0.9,
      grade: 'A',
      maxCombo: 20,
      totalNotes: 40,
    });
    expect(await store.scores.best(record.id, 'hard')).not.toBeNull();
    await store.remove(record.id);
    expect(await store.scores.best(record.id, 'hard')).toBeNull();
    expect(await store.scores.attempts(record.id, 'hard')).toBe(0);
  });

  it('omits the audio when the player chose not to store it', async () => {
    const store = new MemorySongStore();
    const { record } = fixture();
    await store.save({ ...record, audio: { ...record.audio, stored: false } }, null);
    const loaded = await store.load(record.id);
    expect(loaded!.audio).toBeNull();
    expect(loaded!.record.audio.stored).toBe(false);
  });

  it('keeps songs independent and sorts the list by recency', async () => {
    const store = new MemorySongStore();
    const first = fixture(1).record;
    const second = { ...fixture(2).record, id: 'song-second', updatedAt: '2026-10-14T10:00:00.000Z' };
    await store.save(first, null);
    await store.save(second, null);
    const list = await store.list();
    expect(list.map((summary) => summary.id)).toEqual(['song-second', first.id]);
    await store.remove('song-second');
    expect((await store.list()).map((summary) => summary.id)).toEqual([first.id]);
  });

  it('falls back to memory storage and says so when IndexedDB is unavailable', async () => {
    const library = await openSongLibrary(undefined as unknown as IDBFactory);
    expect(library.store.kind).toBe('memory');
    expect(library.store.persistent).toBe(false);
    expect(library.degradedReason).toMatch(/IndexedDB/);
    // Scores have to work in the fallback too, or a session without IndexedDB could not play.
    expect(library.store.scores).toBeDefined();
  });
});

describe('silent and very short material', () => {
  it('produces a record that is honestly marked unplayable', () => {
    const analysis = analyzeMono(new Float32Array(RATE * 3), RATE);
    const set = generateChartSet(analysis, { seed: 1, songId: 'silent', title: 'Silent' });
    const hard = set.charts.hard!;
    expect(hard.validation.ok).toBe(false);
    const { record } = fixture();
    const silentRecord: SongRecord = {
      ...record,
      id: 'song-silent',
      title: 'Silent',
      bpm: analysis.bpm,
      beatMs: analysis.beatMs,
      charts: {
        hard: {
          ...record.charts.hard!,
          noteCount: 0,
          notes: [],
          validation: { ok: false, errors: ['notes-empty: a beatmap needs at least one note'], warnings: [] },
        },
      },
    };
    const summary = summarize(silentRecord);
    expect(summary.noteCount).toBe(0);
    expect(summary.validationOk).toBe(false);
    // A chart with no notes cannot be played, so the record itself is refused rather than loaded
    // into the game as an empty map. The import flow never saves one (validation fails first),
    // so this only triggers for a hand-edited or truncated entry.
    expect(() => decodeSongRecord(silentRecord)).toThrow(/no chart notes/);
  });

  it('handles a very short track without pretending it is chartable', () => {
    const analysis = analyzeMono(clickTrack({ bpm: 120, durationMs: 2000 }), RATE);
    const set = generateChartSet(analysis, { seed: 1, songId: 'short', title: 'Short' });
    const hard = set.charts.hard!;
    expect(hard.stats.noteCount).toBeGreaterThan(0);
    expect(hard.stats.notesPerSecond).toBeLessThan(8);
  });
});
