/**
 * Library tests: the record schema, the conversion back into a playable chart, the untrusted-input
 * validation, and a full save → list → load → delete round trip through a store.
 *
 * The round trip here runs against `MemorySongStore`, which implements the same `SongStore`
 * interface as the IndexedDB store — the browser check covers the real database. What is asserted
 * where it matters is shape-independent: a saved song reopens **without re-analysis**, its chart
 * still validates, and its summary carries everything the picker shows.
 */

import { describe, expect, it } from 'vitest';
import { analyzeMono } from '../src/analysis/MusicAnalyzer';
import { generateChart } from '../src/chart/ChartGenerator';
import { validateBeatmap } from '../src/chart/ChartValidator';
import type { Beatmap } from '../src/chart/ChartTypes';
import {
  chartOf,
  decodeSongRecord,
  encodeSongRecord,
  makeSongId,
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
  chart: Beatmap;
}

function fixture(seed = 5): Fixture {
  const analysis = analyzeMono(drumTrack({ durationMs: 14000, bpm: 120 }), RATE);
  const facts = { name: 'My Song.mp3', sizeBytes: 4_100_000, lastModified: 1_700_000_000_000 };
  const id = makeSongId(facts, analysis.durationMs);
  const generated = generateChart(analysis, { seed, songId: id, title: 'My Song', artist: 'Someone' });
  const record = {
    recordVersion: SONG_RECORD_VERSION,
    id,
    title: 'My Song',
    artist: 'Someone',
    fileName: facts.name,
    fileSize: facts.sizeBytes,
    durationMs: analysis.durationMs,
    sampleRate: analysis.sampleRate,
    channels: 2,
    bpm: analysis.bpm,
    beatMs: analysis.beatMs,
    firstBeatMs: analysis.firstBeatMs,
    beatConfidence: analysis.beatConfidence,
    analysis: {
      version: analysis.version,
      analysisMs: analysis.analysisMs,
      framesAnalyzed: analysis.framesAnalyzed,
      hopMs: analysis.hopMs,
      onsetCount: analysis.onsets.length,
      beatCount: analysis.beats.length,
      lowEnergySections: analysis.energy.lowEnergyRanges.length,
      warnings: [...analysis.warnings],
      tempoCandidates: [...analysis.tempoCandidates],
      beatAlignRatio: analysis.beatAlignRatio,
      beatAlignChance: analysis.beatAlignChance,
      gridCoverage: analysis.gridCoverage,
      gridExcess: analysis.gridExcess,
      barPhase: analysis.barPhase,
      sections: [...analysis.sections],
      lowConfidenceRanges: [...analysis.lowConfidenceRanges],
    },
    chart: {
      schemaVersion: generated.chart.schemaVersion,
      difficulty: generated.chart.difficulty,
      generator: { ...generated.chart.generator },
      noteCount: generated.chart.notes.length,
      notes: generated.chart.notes.map((note) => ({ ...note })),
      stats: { ...generated.stats },
      validation: { ok: generated.validation.ok, errors: [], warnings: [] },
    },
    audio: { format: 'mp3' as const, mimeType: 'audio/mpeg', bytes: facts.sizeBytes, stored: true, transcoded: false },
    createdAt: '2026-10-13T10:00:00.000Z',
    updatedAt: '2026-10-13T10:00:00.000Z',
  } satisfies SongRecord;
  return { record, chart: generated.chart };
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
  it('rebuilds the exact chart without any analysis', () => {
    const { record, chart } = fixture();
    const rebuilt = chartOf(record);
    expect(rebuilt.notes).toEqual(chart.notes);
    expect(rebuilt.bpm).toBe(chart.bpm);
    expect(rebuilt.songId).toBe(record.id);
    expect(rebuilt.difficulty).toBe('normal');
    expect(validateBeatmap(rebuilt).ok).toBe(true);
  });

  it('re-validates on the way out, so a corrupted note list cannot reach the engine', () => {
    const { record } = fixture();
    const corrupted: SongRecord = {
      ...record,
      chart: { ...record.chart, notes: [{ timeMs: 1000, lane: 99, type: 'tap' }] },
    };
    // `chartOf` throws (prepareBeatmap), and `validateRecord` reports instead of throwing.
    expect(() => chartOf(corrupted)).toThrow();
    const summary = summarize(corrupted);
    expect(summary.validationOk).toBe(false);
  });

  it('summarises for the library list without carrying the notes', () => {
    const { record } = fixture();
    const summary = summarize(record);
    expect(summary.title).toBe('My Song');
    expect(summary.noteCount).toBe(record.chart.notes.length);
    expect(summary.audio.format).toBe('mp3');
    expect('notes' in summary).toBe(false);
    expect(summary.validationOk).toBe(true);
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
      [{ ...record, chart: { ...record.chart, notes: [] } }, /no chart notes/],
      [{ ...record, chart: { ...record.chart, difficulty: 'insane' } }, /unknown difficulty/],
      [{ ...record, chart: { ...record.chart, schemaVersion: 99 } }, /schema v99/],
    ];
    for (const [value, pattern] of cases) {
      expect(() => decodeSongRecord(value)).toThrow(SongRecordError);
      expect(() => decodeSongRecord(value)).toThrow(pattern);
    }
  });
});

describe('MemorySongStore round trip', () => {
  it('saves, lists, loads and deletes', async () => {
    const store = new MemorySongStore();
    const { record } = fixture();
    const audio = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/mpeg' });
    await store.save(record, { id: record.id, blob: audio, mimeType: 'audio/mpeg' });

    expect(await store.count()).toBe(1);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(record.id);

    const loaded = await store.load(record.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.record.chart.notes).toEqual(record.chart.notes);
    expect(loaded!.audio).not.toBeNull();
    expect(loaded!.audio!.size).toBe(4);
    // Reopening needs no analysis: the chart and the grid numbers are all present.
    expect(loaded!.record.analysis.onsetCount).toBe(record.analysis.onsetCount);
    expect(chartOf(loaded!.record).notes).toEqual(record.chart.notes);

    await store.remove(record.id);
    expect(await store.count()).toBe(0);
    expect(await store.load(record.id)).toBeNull();
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
  });
});

describe('silent and very short material', () => {
  it('produces a record that is honestly marked unplayable', async () => {
    const analysis = analyzeMono(new Float32Array(RATE * 3), RATE);
    const generated = generateChart(analysis, { seed: 1, songId: 'silent', title: 'Silent' });
    expect(generated.validation.ok).toBe(false);
    const { record } = fixture();
    const silentRecord: SongRecord = {
      ...record,
      id: 'song-silent',
      title: 'Silent',
      bpm: analysis.bpm,
      beatMs: analysis.beatMs,
      chart: {
        ...record.chart,
        noteCount: 0,
        notes: [],
        validation: { ok: false, errors: ['notes-empty: a beatmap needs at least one note'], warnings: [] },
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
    const generated = generateChart(analysis, { seed: 1, songId: 'short', title: 'Short' });
    expect(generated.stats.noteCount).toBeGreaterThan(0);
    expect(generated.stats.notesPerSecond).toBeLessThan(8);
  });
});
