/**
 * Import tests: file validation, decoding (both `decodeAudioData` call shapes), the channel copy
 * that must not detach the playback buffer, and readable errors for every failure the player can
 * actually hit (unsupported type, undecodable file, empty file, too-short audio).
 *
 * The decoding tests use a fake `BaseAudioContext` on purpose: the real one is the browser's, and
 * what this module owns is the *logic around* it — validation, error mapping, the copy, the
 * metadata. The end-to-end path with real MP3 bytes is exercised in the browser check and in
 * `import-flow.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_EXTENSIONS,
  decodeAudioBlob,
  decodeAudioFile,
  describeFile,
  formatBytes,
  formatDuration,
  ImportError,
  MAX_FILE_BYTES,
  MIN_IMPORT_MS,
  validateAudioFile,
} from '../src/import/MusicImport';
import { clickTrack, fakeAudioBuffer, fakeDecodeContext, fakeFile, RATE } from './helpers/synth';

describe('file validation', () => {
  it('accepts a normal mp3', () => {
    const file = fakeFile(new Uint8Array([1, 2, 3]), 'song.mp3', 'audio/mpeg');
    expect(validateAudioFile(file)).toBeNull();
    expect(describeFile(file).name).toBe('song.mp3');
  });

  it('accepts files the browser reports without a type but with a known extension', () => {
    expect(validateAudioFile(fakeFile('x', 'track.wav', ''))).toBeNull();
    expect(validateAudioFile(fakeFile('x', 'track.FLAC', ''))).toBeNull();
  });

  it('rejects an empty file', () => {
    const error = validateAudioFile(fakeFile('', 'empty.mp3', 'audio/mpeg'));
    expect(error?.code).toBe('empty-file');
    expect(error?.message).toMatch(/empty/);
  });

  it('rejects a file over the size limit', () => {
    const file = fakeFile('x', 'huge.mp3', 'audio/mpeg');
    Object.defineProperty(file, 'size', { value: MAX_FILE_BYTES + 1 });
    const error = validateAudioFile(file);
    expect(error?.code).toBe('too-large');
    expect(error?.message).toContain('import limit');
  });

  it('rejects something that is clearly not audio', () => {
    const error = validateAudioFile(fakeFile('hello', 'notes.txt', 'text/plain'));
    expect(error?.code).toBe('unsupported-type');
    expect(error?.message).toContain('notes.txt');
  });

  it('lists the accepted extensions in the rejection message', () => {
    const error = validateAudioFile(fakeFile('hello', 'notes.txt', 'text/plain'));
    expect(error?.message).toContain(ACCEPTED_EXTENSIONS[0]);
  });
});

describe('decoding', () => {
  const pcm = clickTrack({ bpm: 120, durationMs: 5000 });

  it('decodes, reports metadata and copies the analysis channels', async () => {
    const buffer = fakeAudioBuffer([pcm, pcm.map((value) => value * 0.5)]);
    const file = fakeFile(new Uint8Array([1, 2, 3, 4]), 'song.mp3', 'audio/mpeg');
    const decoded = await decodeAudioFile(file, { context: fakeDecodeContext({ buffer }) });

    expect(decoded.sampleRate).toBe(RATE);
    expect(decoded.channelCount).toBe(2);
    expect(decoded.durationMs).toBeCloseTo(5000, 0);
    expect(decoded.analysisChannels).toHaveLength(2);

    // The copy must be a *copy*: the analysis worker transfers (detaches) these buffers, and the
    // playback buffer has to survive that.
    expect(decoded.analysisChannels[0]!.buffer).not.toBe(buffer.getChannelData(0).buffer);
    expect(Array.from(decoded.analysisChannels[0]!.slice(0, 4))).toEqual(Array.from(pcm.slice(0, 4)));
    // Detaching the copy leaves the original intact (this is the regression the copy prevents).
    const detached = decoded.analysisChannels[0]!.buffer;
    structuredClone(detached, { transfer: [detached] });
    expect(decoded.analysisChannels[0]!.length).toBe(0);
    expect(buffer.getChannelData(0).length).toBe(pcm.length);
    expect(buffer.getChannelData(0)[10]).toBe(pcm[10]);
  });

  it('works with the promise-shaped decodeAudioData as well as the callback shape', async () => {
    const buffer = fakeAudioBuffer([pcm]);
    const decoded = await decodeAudioFile(fakeFile('x', 'song.mp3', 'audio/mpeg'), {
      context: fakeDecodeContext({ buffer, shape: 'promise' }),
    });
    expect(decoded.durationMs).toBeCloseTo(5000, 0);
  });

  it('turns a decoder failure into a readable ImportError', async () => {
    const failure = new DOMException('Unable to decode audio data', 'EncodingError');
    await expect(
      decodeAudioFile(fakeFile('notreallyaudio', 'broken.mp3', 'audio/mpeg'), {
        context: fakeDecodeContext({ fail: failure }),
      }),
    ).rejects.toMatchObject({ name: 'ImportError', code: 'decode-failed' });

    try {
      await decodeAudioFile(fakeFile('notreallyaudio', 'broken.mp3', 'audio/mpeg'), {
        context: fakeDecodeContext({ fail: failure }),
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ImportError);
      expect((error as ImportError).message).toContain('broken.mp3');
      expect((error as ImportError).message).toMatch(/corrupt|format/);
    }
  });

  it('refuses audio that is too short to chart', async () => {
    const short = clickTrack({ bpm: 120, durationMs: 1200 });
    await expect(
      decodeAudioFile(fakeFile('x', 'blip.mp3', 'audio/mpeg'), {
        context: fakeDecodeContext({ buffer: fakeAudioBuffer([short]) }),
      }),
    ).rejects.toMatchObject({ code: 'too-short' });
  });

  it('reports progress while decoding', async () => {
    const ratios: number[] = [];
    await decodeAudioFile(fakeFile('x', 'song.mp3', 'audio/mpeg'), {
      context: fakeDecodeContext({ buffer: fakeAudioBuffer([pcm]) }),
      onProgress: (ratio) => ratios.push(ratio),
    });
    expect(ratios.length).toBeGreaterThan(1);
    for (let i = 1; i < ratios.length; i += 1) expect(ratios[i]!).toBeGreaterThanOrEqual(ratios[i - 1]!);
  });

  it('re-opens stored bytes as an AudioBuffer', async () => {
    const buffer = fakeAudioBuffer([pcm]);
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' });
    const decoded = await decodeAudioBlob(blob, fakeDecodeContext({ buffer }));
    expect(decoded.duration).toBeCloseTo(5000 / 1000, 2);
  });

  it('reports a damaged library entry instead of throwing a decoder error', async () => {
    await expect(
      decodeAudioBlob(new Blob([new Uint8Array([1])]), fakeDecodeContext({ fail: new Error('boom') })),
    ).rejects.toMatchObject({ name: 'ImportError', code: 'decode-failed' });
  });
});

describe('formatting', () => {
  it('formats bytes and durations for the UI', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65000)).toBe('1:05');
    expect(formatDuration(3_600_000)).toBe('60:00');
    expect(MIN_IMPORT_MS).toBeGreaterThan(0);
  });
});
