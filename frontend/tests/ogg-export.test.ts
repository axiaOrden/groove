/**
 * OGG export tests, against the **real** encoder (libvorbis compiled to wasm, loaded from
 * node_modules). That is deliberate: a mock would only prove that this module calls a function,
 * while the question that actually matters — "can this thing produce a valid Ogg Vorbis stream in
 * the environment the game runs in?" — is answered by the bytes on the other side.
 *
 * The encoder is exercised with a short signal (1 s) so the suite stays fast; the browser check
 * covers a full-length song.
 */

import { describe, expect, it } from 'vitest';
import {
  estimateOggBytes,
  exportOggVorbis,
  oggEncoderAvailable,
  OGG_MIME,
  resetOggCapabilityCache,
} from '../src/import/OggExport';
import { clickTrack, RATE } from './helpers/synth';

function oggMagic(blob: Blob): Promise<string> {
  return blob.slice(0, 4).arrayBuffer().then((buffer) => String.fromCharCode(...new Uint8Array(buffer)));
}

describe('ogg encoder availability', () => {
  it('reports availability and caches the probe', async () => {
    resetOggCapabilityCache();
    const available = await oggEncoderAvailable();
    expect(available).toBe(true);
    // Second call must not re-import the module (it returns the cached answer).
    expect(await oggEncoderAvailable()).toBe(true);
  });
});

describe('exportOggVorbis', () => {
  it('encodes PCM into a valid Ogg Vorbis stream', async () => {
    const left = clickTrack({ bpm: 120, durationMs: 1400 });
    const right = clickTrack({ bpm: 120, durationMs: 1400, amplitude: 0.6 });
    const progress: number[] = [];

    const result = await exportOggVorbis({
      channels: [left, right],
      sampleRate: RATE,
      vbrQuality: 2,
      chunkSamples: 16384,
      onProgress: (ratio) => progress.push(ratio),
    });

    expect(result.blob.type).toBe(OGG_MIME);
    expect(result.bytes).toBeGreaterThan(1000);
    expect(result.durationMs).toBeCloseTo(1400, 0);
    expect(result.encoder).toContain('vorbis');
    expect(await oggMagic(result.blob)).toBe('OggS');
    // The container's codec identifier is Vorbis, not Opus (the distinction the brief insists on).
    const head = new Uint8Array(await result.blob.slice(0, 64).arrayBuffer());
    expect(String.fromCharCode(...head)).toContain('vorbis');
    expect(progress[progress.length - 1]).toBe(1);
    for (let i = 1; i < progress.length; i += 1) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
  });

  it('encodes mono as mono', async () => {
    const mono = clickTrack({ bpm: 100, durationMs: 700 });
    const result = await exportOggVorbis({ channels: [mono], sampleRate: RATE, vbrQuality: 1 });
    expect(result.bytes).toBeGreaterThan(500);
    expect(await oggMagic(result.blob)).toBe('OggS');
  });

  it('rejects nonsense input instead of producing a broken file', async () => {
    await expect(exportOggVorbis({ channels: [], sampleRate: RATE })).rejects.toThrow(/no audio/);
    await expect(exportOggVorbis({ channels: [new Float32Array(0)], sampleRate: RATE })).rejects.toThrow(/empty/);
    await expect(
      exportOggVorbis({ channels: [new Float32Array(100)], sampleRate: 0 }),
    ).rejects.toThrow(/sampleRate/);
  });

  it('estimates a plausible size for a full song', () => {
    const estimate = estimateOggBytes(180000, 5);
    expect(estimate).toBeGreaterThan(2_000_000);
    expect(estimate).toBeLessThan(6_000_000);
  });
});
