/**
 * FFT / STFT primitives for offline music analysis.
 *
 * Deliberately dependency free, allocation-conscious and pure: the same code runs in a Web
 * Worker in the browser and in Node under vitest, and every function is a pure function of its
 * inputs so analysis is reproducible.
 *
 * Why not Essentia.js (the brief's suggested starting point)? Researched and rejected for this
 * proof of concept; the numbers are in PHASE2_1_NOTES.md. Short version: the async browser build
 * is ~2.25 MB of wasm+glue, the package is AGPL-3.0 (a licensing problem for a game we may
 * distribute), it needs 44.1 kHz input and manual wasm-vector lifetime management, and its
 * algorithms cannot be unit tested against known ground truth as cheaply as our own can. The
 * analysis pipeline is behind `AnalysisBackend`-shaped seams (see MusicAnalyzer) so a wasm
 * backend can be added later without touching the chart generator.
 */

/** A radix-2 iterative FFT with precomputed twiddles and bit-reversal order. */
export class Fft {
  readonly size: number;
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;
  private readonly bitReverse: Uint32Array;

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`Fft size must be a power of two >= 2, got ${size}`);
    }
    this.size = size;
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i += 1) {
      const angle = (-2 * Math.PI * i) / size;
      this.cos[i] = Math.cos(angle);
      this.sin[i] = Math.sin(angle);
    }
    this.bitReverse = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i += 1) {
      let reversed = 0;
      for (let b = 0; b < bits; b += 1) reversed |= ((i >>> b) & 1) << (bits - 1 - b);
      this.bitReverse[i] = reversed;
    }
  }

  /** In-place forward transform. `im` is zeroed for a real input; both arrays are size `size`. */
  transform(re: Float32Array, im: Float32Array): void {
    const { size, cos, sin, bitReverse } = this;
    if (re.length < size || im.length < size) {
      throw new Error(`transform expects buffers of length >= ${size}`);
    }
    for (let i = 0; i < size; i += 1) {
      const j = bitReverse[i]!;
      if (j > i) {
        const tr = re[i]!;
        re[i] = re[j]!;
        re[j] = tr;
        const ti = im[i]!;
        im[i] = im[j]!;
        im[j] = ti;
      }
    }
    for (let length = 2; length <= size; length *= 2) {
      const half = length / 2;
      const step = size / length;
      for (let start = 0; start < size; start += length) {
        for (let k = 0; k < half; k += 1) {
          const twiddle = k * step;
          const wr = cos[twiddle]!;
          const wi = sin[twiddle]!;
          const i = start + k;
          const j = i + half;
          const xr = re[j]!;
          const xi = im[j]!;
          const tr = xr * wr - xi * wi;
          const ti = xr * wi + xi * wr;
          re[j] = re[i]! - tr;
          im[j] = im[i]! - ti;
          re[i] = re[i]! + tr;
          im[i] = im[i]! + ti;
        }
      }
    }
  }

  /** Magnitude spectrum of the lower half (the only half a real signal has). */
  magnitudes(re: Float32Array, im: Float32Array, out: Float32Array): void {
    const bins = this.size / 2;
    for (let k = 0; k < bins; k += 1) {
      const r = re[k]!;
      const i = im[k]!;
      out[k] = Math.hypot(r, i);
    }
  }
}

/** Periodic Hann window (the correct choice for overlap-add STFT analysis). */
export function hannWindow(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size));
  }
  return window;
}

/** Largest power of two >= n (at least 2). */
export function nextPowerOfTwo(n: number): number {
  let size = 2;
  while (size < n) size *= 2;
  return size;
}

export interface StftOptions {
  frameSize: number;
  hopSize: number;
  /** Informational only: `process()` takes the rate it needs, this field just documents the source. */
  sampleRate?: number;
}

/**
 * Streaming short-time Fourier transform: one frame at a time into a reusable magnitude buffer.
 *
 * Streaming (rather than returning a matrix) is what keeps analysis of a 4-minute song inside a
 * modest memory budget: a 3:35 track at 44.1 kHz has ~18.5k frames of 1024 bins, which as a
 * retained matrix would be ~76 MB of Float32 before any processing.
 */
export class Stft {
  readonly frameSize: number;
  readonly hopSize: number;
  readonly bins: number;
  readonly frameCount: number;
  private readonly fft: Fft;
  private readonly window: Float32Array;
  private readonly re: Float32Array;
  private readonly im: Float32Array;
  readonly magnitude: Float32Array;

  constructor(samples: number, options: StftOptions) {
    this.frameSize = options.frameSize;
    this.hopSize = options.hopSize;
    this.fft = new Fft(options.frameSize);
    this.bins = options.frameSize / 2;
    this.window = hannWindow(options.frameSize);
    this.re = new Float32Array(options.frameSize);
    this.im = new Float32Array(options.frameSize);
    this.magnitude = new Float32Array(this.bins);
    this.frameCount = samples <= options.frameSize ? 1 : 1 + Math.floor((samples - options.frameSize) / options.hopSize);
  }

  /**
   * Walk the signal. `visit(frameIndex, magnitude, frameStartMs, frameEnergy)` is called once per
   * frame; the magnitude buffer is reused, so a visitor must not retain it.
   */
  process(
    signal: Float32Array,
    sampleRate: number,
    visit: (frameIndex: number, magnitude: Float32Array, frameStartMs: number, rms: number) => void,
  ): void {
    const { frameSize, hopSize, window, re, im, magnitude, bins } = this;
    for (let frame = 0; frame < this.frameCount; frame += 1) {
      const start = frame * hopSize;
      let energy = 0;
      for (let i = 0; i < frameSize; i += 1) {
        const index = start + i;
        const sample = index < signal.length ? signal[index]! : 0;
        const windowed = sample * window[i]!;
        re[i] = windowed;
        im[i] = 0;
        energy += windowed * windowed;
      }
      this.fft.transform(re, im);
      this.fft.magnitudes(re, im, magnitude);
      void bins;
      visit(frame, magnitude, (start / sampleRate) * 1000, Math.sqrt(energy / frameSize));
    }
  }
}
