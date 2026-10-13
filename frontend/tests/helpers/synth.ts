/**
 * Shared synthetic-audio helpers for the phase 2 tests.
 *
 * Signals are built from a **known ground truth** (a click at a known time, a beat at a known
 * BPM) so tests can assert on real numbers instead of "it returned something". Deterministic
 * noise keeps them from flaking.
 */

export const RATE = 44100;

/** Deterministic noise, so a "click" is reproducible and tests cannot flake. */
export function noise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1);
  };
}

export interface ClickOptions {
  bpm?: number;
  durationMs: number;
  accentEvery?: number;
  startMs?: number;
  amplitude?: number;
  quietAfterMs?: number;
  quietGain?: number;
  sampleRate?: number;
}

/** A percussive click: fast attack, exponential decay, noise + a mid tone. */
export function clickTrack(options: ClickOptions): Float32Array {
  const sampleRate = options.sampleRate ?? RATE;
  const length = Math.round((options.durationMs / 1000) * sampleRate);
  const out = new Float32Array(length);
  const random = noise(0xc0ffee);
  const bpm = options.bpm ?? 128;
  const periodMs = 60000 / bpm;
  const startMs = options.startMs ?? 0;
  const amplitude = options.amplitude ?? 0.9;
  const accentEvery = options.accentEvery ?? 4;

  for (let beat = 0; startMs + beat * periodMs <= options.durationMs; beat += 1) {
    const atMs = startMs + beat * periodMs;
    const gain = beat % accentEvery === 0 ? 1 : 0.55;
    const start = Math.round((atMs / 1000) * sampleRate);
    const decaySamples = Math.round(0.08 * sampleRate);
    for (let i = 0; i < decaySamples; i += 1) {
      const index = start + i;
      if (index >= length) break;
      const t = i / sampleRate;
      const body = Math.sin(2 * Math.PI * 900 * t) * 0.7 + random() * 0.5;
      let value = body * Math.exp(-t * 60) * gain * amplitude;
      if (options.quietAfterMs !== undefined && atMs >= options.quietAfterMs) {
        value *= options.quietGain ?? 0.02;
      }
      out[index] = (out[index] ?? 0) + value;
    }
  }
  return out;
}

export interface DrumOptions {
  durationMs: number;
  bpm?: number;
  quietAfterMs?: number;
  quietGain?: number;
  sampleRate?: number;
}

/** Kick on every beat, hat on every off-beat, a clap on bar downbeats: a chartable groove. */
export function drumTrack(options: DrumOptions): Float32Array {
  const sampleRate = options.sampleRate ?? RATE;
  const bpm = options.bpm ?? 120;
  const length = Math.round((options.durationMs / 1000) * sampleRate);
  const out = new Float32Array(length);
  const random = noise(0xbeef);
  const beatMs = 60000 / bpm;

  const add = (atMs: number, gain: number, body: (t: number) => number, decay: number, tailMs: number): void => {
    const start = Math.round((atMs / 1000) * sampleRate);
    for (let i = 0; i < (tailMs / 1000) * sampleRate; i += 1) {
      const index = start + i;
      if (index >= length) break;
      const t = i / sampleRate;
      let value = body(t) * Math.exp(-t * decay) * gain;
      if (options.quietAfterMs !== undefined && atMs >= options.quietAfterMs) value *= options.quietGain ?? 0.02;
      out[index] = (out[index] ?? 0) + value;
    }
  };

  for (let beat = 0; beat * beatMs <= options.durationMs; beat += 1) {
    const onBar = beat % 4 === 0;
    add(beat * beatMs, onBar ? 1 : 0.7, (t) => Math.sin(2 * Math.PI * 70 * t) + random() * 0.3, 22, 120);
    add(beat * beatMs + beatMs / 2, 0.5, (t) => random() * 0.9 + Math.sin(2 * Math.PI * 5000 * t) * 0.4, 90, 40);
    if (onBar) add(beat * beatMs, 0.8, (t) => random() * 0.8 + Math.sin(2 * Math.PI * 3000 * t) * 0.5, 70, 60);
  }
  return out;
}

interface FakeAudioBuffer {
  duration: number;
  length: number;
  sampleRate: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/** A minimal `AudioBuffer` for tests: only the members the import path reads. */
export function fakeAudioBuffer(channels: readonly Float32Array[], sampleRate = RATE): AudioBuffer {
  const length = channels[0]?.length ?? 0;
  return {
    duration: length / sampleRate,
    length,
    sampleRate,
    numberOfChannels: channels.length,
    getChannelData: (channel: number) => channels[channel] ?? channels[0] ?? new Float32Array(0),
    // The remaining members of the real interface are never read by the import path.
    copyFromChannel: () => undefined,
    copyToChannel: () => undefined,
  } as unknown as AudioBuffer;
}

export interface FakeDecodeContextOptions {
  buffer?: AudioBuffer;
  /** `callback` mimics Safari/older Chrome, `promise` mimics the modern call shape. */
  shape?: 'callback' | 'promise';
  fail?: Error;
}

/** A stand-in for `BaseAudioContext` that decodes to a fixed buffer (or fails). */
export function fakeDecodeContext(options: FakeDecodeContextOptions = {}): BaseAudioContext {
  const shape = options.shape ?? 'callback';
  const decode = (
    _data: ArrayBuffer,
    done?: (buffer: AudioBuffer) => void,
    failed?: (error: DOMException | Error | null) => void,
  ): Promise<AudioBuffer> | undefined => {
    if (options.fail) {
      if (shape === 'callback') {
        failed?.(options.fail);
        return undefined;
      }
      return Promise.reject(options.fail);
    }
    const buffer = options.buffer ?? fakeAudioBuffer([new Float32Array(RATE)]);
    if (shape === 'callback') {
      done?.(buffer);
      return undefined;
    }
    return Promise.resolve(buffer);
  };
  return {
    sampleRate: options.buffer?.sampleRate ?? RATE,
    decodeAudioData: decode,
  } as unknown as BaseAudioContext;
}

/** A `File` holding arbitrary bytes, with a name and type (Node 20+ has `File` globally). */
export function fakeFile(content: Uint8Array | string, name: string, type: string): File {
  const parts: BlobPart[] = [typeof content === 'string' ? content : (content as unknown as BlobPart)];
  return new File(parts, name, { type });
}
