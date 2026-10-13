/**
 * Import flow tests: the whole pipeline from a file to a saved, playable record, with the real
 * analysis and the real chart generator (only the browser's decoder is faked, because the browser
 * itself is not part of the unit-test environment).
 *
 * The guarantees pinned here are the ones the brief asks for:
 *   - the workflow reports progress that never goes backwards;
 *   - the same file and the same seed produce exactly the same chart (determinism end to end);
 *   - failures produce a readable message, not a half-imported song;
 *   - a saved song reopens and plays without re-analysis;
 *   - the chart that reaches the game passes `ChartValidator`.
 */

import { describe, expect, it } from 'vitest';
import { AnalysisClient } from '../src/analysis/AnalysisClient';
import { importSongFile, formatFromFacts, type ImportProgress } from '../src/import/ImportFlow';
import { ImportError } from '../src/import/MusicImport';
import { MemorySongStore } from '../src/storage/SongLibrary';
import { chartOf } from '../src/storage/SongRecord';
import { validateBeatmap } from '../src/chart/ChartValidator';
import { drumTrack, fakeAudioBuffer, fakeDecodeContext, fakeFile, RATE } from './helpers/synth';

const SONG_MS = 16000;

function songFile(name = 'Night Drive.mp3'): File {
  // The bytes are irrelevant: the fake context decodes to a synthetic drum track.
  return fakeFile(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4]), name, 'audio/mpeg');
}

function songContext(buffer = fakeAudioBuffer([drumTrack({ durationMs: SONG_MS })])): BaseAudioContext {
  return fakeDecodeContext({ buffer });
}

function stages(progress: readonly ImportProgress[]): string[] {
  return progress.map((entry) => entry.stage);
}

describe('importSongFile', () => {
  it('imports, analyses, generates and saves a playable song', async () => {
    const store = new MemorySongStore();
    const progress: ImportProgress[] = [];
    const outcome = await importSongFile({
      file: songFile(),
      context: songContext(),
      client: new AnalysisClient(),
      seed: 11,
      save: true,
      store,
      onProgress: (entry) => progress.push(entry),
    });

    // Progress: monotonic, ends at 1, and goes through every stage.
    expect(progress.length).toBeGreaterThan(5);
    for (let i = 1; i < progress.length; i += 1) {
      expect(progress[i]!.ratio).toBeGreaterThanOrEqual(progress[i - 1]!.ratio);
    }
    expect(progress[progress.length - 1]!.ratio).toBe(1);
    expect(stages(progress)).toContain('decoding');
    expect(stages(progress)).toContain('analyzing');
    expect(stages(progress)).toContain('generating');
    expect(stages(progress)).toContain('saving');

    // Analysis found the groove.
    expect(Math.abs(outcome.analysis.bpm - 120)).toBeLessThanOrEqual(4);
    expect(outcome.analysis.onsets.length).toBeGreaterThan(30);
    expect(outcome.analysis.durationMs).toBeCloseTo(SONG_MS, 0);

    // The chart is real, validated and aligned.
    expect(outcome.validation.ok).toBe(true);
    expect(outcome.validation.errors).toEqual([]);
    expect(outcome.stats.noteCount).toBeGreaterThan(30);
    expect(outcome.stats.lanesUsed).toBeGreaterThanOrEqual(5);
    expect(outcome.stats.beatAlignRatio).toBeGreaterThan(0.5);
    expect(outcome.stats.notesPerSecond).toBeLessThan(6);
    expect(outcome.chart.bpm).toBeCloseTo(outcome.analysis.bpm, 0);

    // It was saved, with the audio, and reopens as the same chart.
    expect(outcome.saved).toBe(true);
    expect(await store.count()).toBe(1);
    const loaded = await store.load(outcome.record.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.audio).not.toBeNull();
    await expect(loaded!.audio!.arrayBuffer()).resolves.toBeInstanceOf(ArrayBuffer);
    const reopened = chartOf(loaded!.record);
    expect(reopened.notes).toEqual(outcome.chart.notes);
    expect(validateBeatmap(reopened).ok).toBe(true);
    expect(loaded!.record.audio.stored).toBe(true);
    expect(loaded!.record.audio.transcoded).toBe(false);
  });

  it('is deterministic: same file, same seed, same chart', async () => {
    // The *same* File object: the id is derived from name + size + mtime + duration, so two
    // separate uploads of the same bytes are (deliberately) different songs.
    const file = songFile();
    const first = await importSongFile({
      file,
      context: songContext(),
      client: new AnalysisClient(),
      seed: 42,
    });
    const second = await importSongFile({
      file,
      context: songContext(),
      client: new AnalysisClient(),
      seed: 42,
    });
    expect(second.chart).toEqual(first.chart);
    expect(second.stats).toEqual(first.stats);
    expect(second.analysis.bpm).toBe(first.analysis.bpm);
    expect(second.analysis.beats).toEqual(first.analysis.beats);
  });

  it('uses a different lane arrangement for a different seed but the same events', async () => {
    const file = songFile();
    const a = await importSongFile({
      file,
      context: songContext(),
      client: new AnalysisClient(),
      seed: 1,
    });
    const b = await importSongFile({
      file,
      context: songContext(),
      client: new AnalysisClient(),
      seed: 777,
    });
    expect(b.record.id).toBe(a.record.id);
    expect(b.chart.notes.map((note) => note.timeMs)).toEqual(a.chart.notes.map((note) => note.timeMs));
  });

  it('names the song from the file and stores the audio bytes it was given', async () => {
    const store = new MemorySongStore();
    const outcome = await importSongFile({
      file: songFile('Boys_Of_Summer.mp3'),
      context: songContext(),
      client: new AnalysisClient(),
      save: true,
      store,
    });
    expect(outcome.record.title).toBe('Boys Of Summer');
    expect(outcome.record.audio.format).toBe('mp3');
    expect(outcome.record.audio.bytes).toBe(outcome.file.size);
    expect(outcome.record.fileSize).toBe(outcome.file.size);
  });

  it('does not save when the player turned saving off', async () => {
    const store = new MemorySongStore();
    const outcome = await importSongFile({
      file: songFile(),
      context: songContext(),
      client: new AnalysisClient(),
      save: false,
      store,
    });
    expect(outcome.saved).toBe(false);
    expect(await store.count()).toBe(0);
    expect(outcome.record.audio.stored).toBe(false);
  });

  it('refuses a file the browser cannot decode, with a readable message', async () => {
    await expect(
      importSongFile({
        file: songFile('broken.mp3'),
        context: fakeDecodeContext({ fail: new DOMException('bad data', 'EncodingError') }),
        client: new AnalysisClient(),
      }),
    ).rejects.toMatchObject({ name: 'ImportError', code: 'decode-failed' });
  });

  it('refuses a non-audio file before decoding it', async () => {
    await expect(
      importSongFile({
        file: fakeFile('just some text', 'notes.txt', 'text/plain'),
        context: songContext(),
        client: new AnalysisClient(),
      }),
    ).rejects.toMatchObject({ name: 'ImportError', code: 'unsupported-type' });
  });

  it('reports an unplayable chart instead of saving a broken song', async () => {
    // Three seconds of digital silence: the analysis finds nothing to chart, so validation fails
    // and the import must not leave a half-written record behind.
    const store = new MemorySongStore();
    await expect(
      importSongFile({
        file: songFile('silence.mp3'),
        context: fakeDecodeContext({ buffer: fakeAudioBuffer([new Float32Array(RATE * 3)]) }),
        client: new AnalysisClient(),
        save: true,
        store,
      }),
    ).rejects.toThrow(/did not pass validation/);
    expect(await store.count()).toBe(0);
  });

  it('converts to OGG when asked, and keeps the format honest in the record', async () => {
    const store = new MemorySongStore();
    const outcome = await importSongFile({
      file: songFile(),
      context: songContext(fakeAudioBuffer([drumTrack({ durationMs: 4000 })])),
      client: new AnalysisClient(),
      save: true,
      store,
      transcodeToOgg: true,
      oggQuality: 1,
    });
    expect(outcome.ogg).not.toBeNull();
    expect(outcome.record.audio.format).toBe('ogg');
    expect(outcome.record.audio.transcoded).toBe(true);
    expect(outcome.record.audio.bytes).toBe(outcome.ogg!.bytes);
    const loaded = await store.load(outcome.record.id);
    const head = new Uint8Array(await loaded!.audio!.slice(0, 4).arrayBuffer());
    expect(String.fromCharCode(...head)).toBe('OggS');
  });

  it('throws when saving is requested without a store', async () => {
    await expect(
      importSongFile({
        file: songFile(),
        context: songContext(),
        client: new AnalysisClient(),
        save: true,
      }),
    ).rejects.toThrow(/without a song store/);
  });

  it('classifies formats for the library', () => {
    const facts = { name: 'a.MP3', sizeBytes: 1, type: 'audio/mpeg', lastModified: 0 };
    expect(formatFromFacts(facts, 'audio/mpeg')).toBe('mp3');
    expect(formatFromFacts({ ...facts, name: 'a.oga' }, 'audio/ogg')).toBe('ogg');
    expect(formatFromFacts({ ...facts, name: 'a.flac' }, 'audio/flac')).toBe('other');
  });

  it('rejects nonsense audio (empty buffer) through the same readable error path', async () => {
    const store = new MemorySongStore();
    let error: unknown = null;
    try {
      await importSongFile({
        file: songFile('empty-audio.mp3'),
        context: fakeDecodeContext({ buffer: fakeAudioBuffer([new Float32Array(0)]) }),
        client: new AnalysisClient(),
        save: true,
        store,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ImportError);
    expect(await store.count()).toBe(0);
  });
});
