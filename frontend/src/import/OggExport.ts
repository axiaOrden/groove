/**
 * Optional OGG Vorbis export.
 *
 * The brief asks for MP3 → Ogg Vorbis, with three warnings attached: do not confuse transcoding
 * with chart generation, `MediaRecorder` is not a Vorbis encoder, and repeated lossy transcoding
 * loses quality. All three shape what this module does.
 *
 * **Chart generation does not depend on the audio format.** The analysis consumes decoded PCM
 * (`AudioBuffer` → `Float32Array`), which is identical no matter which lossy container the PCM
 * arrived in. Transcoding is therefore a *storage* decision taken after the chart already exists,
 * and the library records which bytes it holds (`audio.format`, `audio.transcoded`).
 *
 * **Browsers cannot encode Vorbis natively.** `MediaRecorder` with `audio/ogg` produces
 * Opus-in-Ogg in Chromium/Firefox and nothing at all in Safari; there is no browser API that emits
 * true Vorbis. So the encoder is WebAssembly: `wasm-media-encoders` 0.7.0 (MIT), the reference
 * libvorbis compiled to wasm — ~440 KiB of wasm, listed at ~158 KiB gzipped with the glue. It is
 * loaded with a **dynamic import**, so a player who never exports an OGG downloads none of it.
 *
 * **Transcoding is off by default and lossy.** MP3 → Vorbis decodes to PCM and re-encodes, which
 * adds a second generation of loss on top of the first. Nothing is gained in size (a 192 kbps MP3
 * and a q5 Vorbis file are within a few percent of each other). The honest recommendation, and the
 * default, is to keep the original upload; the export exists because the brief asks for it and
 * because phase 3+ may want a royalty-free container.
 */

/** What a stored OGG blob is. `codecs=vorbis` is accurate: this encoder is real Vorbis. */
export const OGG_MIME = 'audio/ogg; codecs=vorbis';

export interface OggExportOptions {
  /** Decoded PCM, one array per channel (1 or 2; extra channels are ignored). */
  channels: readonly Float32Array[];
  sampleRate: number;
  /** Vorbis VBR quality, -1..10 (5 is roughly 160 kbps stereo). */
  vbrQuality?: number;
  /** Samples encoded per chunk. Larger is faster, smaller keeps the UI more responsive. */
  chunkSamples?: number;
  onProgress?: (ratio: number, detail: string) => void;
}

export interface OggExportResult {
  blob: Blob;
  bytes: number;
  durationMs: number;
  vbrQuality: number;
  encoder: string;
}

type OggEncoder = {
  configure(params: { channels: 1 | 2; sampleRate: number; vbrQuality?: number }): void;
  encode(samples: readonly Float32Array[]): Uint8Array;
  finalize(): Uint8Array;
};

/** Injectable so tests can exercise the pipeline without the wasm module. */
export type OggEncoderFactory = () => Promise<OggEncoder>;

const defaultFactory: OggEncoderFactory = async () => {
  const module = await import('wasm-media-encoders');
  return module.createOggEncoder() as Promise<OggEncoder>;
};

let cachedCapability: boolean | null = null;

/**
 * Probe for WebAssembly + a loadable encoder. Cached: the probe is only a feature test, and a
 * player who exports twice should not pay for the check twice.
 */
export async function oggEncoderAvailable(factory: OggEncoderFactory = defaultFactory): Promise<boolean> {
  if (cachedCapability !== null && factory === defaultFactory) return cachedCapability;
  if (typeof WebAssembly === 'undefined') {
    if (factory === defaultFactory) cachedCapability = false;
    return false;
  }
  try {
    const encoder = await factory();
    const available = typeof encoder.encode === 'function';
    if (factory === defaultFactory) cachedCapability = available;
    return available;
  } catch {
    if (factory === defaultFactory) cachedCapability = false;
    return false;
  }
}

/** Test hook: forget the cached probe result. */
export function resetOggCapabilityCache(): void {
  cachedCapability = null;
}

/**
 * Encode decoded PCM to Ogg Vorbis.
 *
 * The encoder's `encode()` returns a view into wasm memory that is reused on the next call, so every
 * chunk must be copied out immediately — the copies are collected in an array of `Uint8Array`s and
 * only concatenated by `Blob`, which does it without another full-size allocation.
 */
export async function exportOggVorbis(
  options: OggExportOptions,
  factory: OggEncoderFactory = defaultFactory,
): Promise<OggExportResult> {
  const channels = options.channels.slice(0, 2);
  if (channels.length === 0) throw new Error('no audio to encode');
  if (!(options.sampleRate > 0)) throw new Error('sampleRate must be positive');

  const length = channels[0]!.length;
  if (length === 0) throw new Error('the audio buffer is empty');
  const channelCount = (channels.length > 1 ? 2 : 1) as 1 | 2;
  const vbrQuality = options.vbrQuality ?? 5;
  const chunkSamples = Math.max(4096, options.chunkSamples ?? 65536);

  options.onProgress?.(0.02, 'loading the Vorbis encoder');
  const encoder = await factory();
  encoder.configure({ channels: channelCount, sampleRate: options.sampleRate, vbrQuality });

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const total = Math.max(1, Math.ceil(length / chunkSamples));
  for (let index = 0; index < total; index += 1) {
    const start = index * chunkSamples;
    const end = Math.min(length, start + chunkSamples);
    const block: Float32Array[] = [];
    for (let channel = 0; channel < channelCount; channel += 1) {
      const source = channels[Math.min(channel, channels.length - 1)]!;
      block.push(source.subarray(start, end));
    }
    const encoded = encoder.encode(block);
    if (encoded.length > 0) {
      // Copy: `encoded` is a view into wasm memory that the next call overwrites.
      const copy = new Uint8Array(encoded.length);
      copy.set(encoded);
      chunks.push(copy);
      bytes += copy.length;
    }
    options.onProgress?.(0.02 + 0.9 * ((index + 1) / total), `encoding ${Math.round(((index + 1) / total) * 100)}%`);
    // Yield to the event loop so the progress bar can paint and the tab stays responsive.
    if (index % 4 === 3) await yieldToEventLoop();
  }

  const tail = encoder.finalize();
  if (tail.length > 0) {
    const copy = new Uint8Array(tail.length);
    copy.set(tail);
    chunks.push(copy);
    bytes += copy.length;
  }

  options.onProgress?.(0.95, 'packaging');
  const blob = new Blob(chunks as BlobPart[], { type: OGG_MIME });
  options.onProgress?.(1, 'done');
  return {
    blob,
    bytes: blob.size || bytes,
    durationMs: (length / options.sampleRate) * 1000,
    vbrQuality,
    encoder: 'wasm-media-encoders/libvorbis',
  };
}

/** Estimate the size of an OGG transcode before doing it (used for the UI hint). */
export function estimateOggBytes(durationMs: number, vbrQuality = 5): number {
  // Rough VBR curve: q5 stereo ≈ 160 kbps. Only ever shown as an estimate.
  const kbps = 48 + vbrQuality * 22;
  return Math.round((durationMs / 1000) * (kbps / 8) * 1024);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof setTimeout === 'function') setTimeout(resolve, 0);
    else resolve();
  });
}
