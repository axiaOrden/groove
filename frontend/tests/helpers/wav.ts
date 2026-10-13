/**
 * Minimal 16-bit PCM WAV reader for tests.
 *
 * The fixtures in `test-assets/` are written by `make_fixtures.py` and have a known answer, so the
 * analysis suite can compare against ground truth instead of against itself. Reading the WAV rather
 * than the MP3 keeps the test determinism-friendly (no decoder differences between Node versions)
 * while the browser test covers the MP3 path.
 */

import { readFileSync } from 'node:fs';

export interface WavFile {
  sampleRate: number;
  channels: Float32Array[];
  durationMs: number;
}

export function readWav(path: string): WavFile {
  const buffer = readFileSync(path);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 12;
  let sampleRate = 44100;
  let channels = 1;
  let bits = 16;
  let dataOffset = 0;
  let dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const id = String.fromCharCode(buffer[offset]!, buffer[offset + 1]!, buffer[offset + 2]!, buffer[offset + 3]!);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bits = view.getUint16(offset + 22, true);
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataLength = size;
    }
    offset += 8 + size + (size % 2);
  }
  if (bits !== 16) throw new Error(`expected 16-bit PCM, got ${bits}-bit`);
  const frames = Math.floor(dataLength / (2 * channels));
  const out: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      out[channel]![frame] = view.getInt16(dataOffset + (frame * channels + channel) * 2, true) / 32768;
    }
  }
  return { sampleRate, channels: out, durationMs: (frames / sampleRate) * 1000 };
}

/** Path of a fixture from a test file in `tests/`. */
export function fixture(name: string): string {
  return new URL(`../../../test-assets/${name}`, import.meta.url).pathname;
}

/**
 * Signed phase error of a detected grid against a true grid that starts at 0 ms, in ms.
 * Comparing phases modulo the *true* period is the only meaningful comparison when the detected
 * period is a hair different from the real one.
 */
export function phaseErrorMs(detectedFirstMs: number, truePeriodMs: number): number {
  let delta = detectedFirstMs % truePeriodMs;
  if (delta > truePeriodMs / 2) delta -= truePeriodMs;
  if (delta < -truePeriodMs / 2) delta += truePeriodMs;
  return delta;
}
