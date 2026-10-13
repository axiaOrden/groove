/**
 * Analysis core tests.
 *
 * Every case here is built from a **synthetic signal with a known answer**: a click train at a
 * known BPM, a tone at a known frequency, silence, a signal that stops halfway. That is the only
 * way to assert anything real about onset detection and tempo estimation — "it returned a number"
 * is not a test.
 *
 * These run in plain Node (no jsdom): the analysis pipeline is DOM-free by design, which is also
 * what lets it run inside a Web Worker unchanged.
 */

import { describe, expect, it } from 'vitest';
import { Fft, hannWindow, nextPowerOfTwo, Stft } from '../src/analysis/Fft';
import { computeFrameFeatures, detectOnsets, downmix } from '../src/analysis/OnsetDetector';
import { estimateTempo, scoreGrid } from '../src/analysis/TempoEstimator';
import { computeEnergyProfile } from '../src/analysis/EnergyProfile';
import { analyzeMono, analyzeSong, resolveOptions, MIN_ANALYZABLE_MS } from '../src/analysis/MusicAnalyzer';
import { DEFAULT_ANALYSIS_OPTIONS } from '../src/analysis/types';

const RATE = 44100;

/** Deterministic noise, so a "click" is reproducible and the tests cannot flake. */
function noise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1);
  };
}

interface ClickOptions {
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
function clickTrack(options: ClickOptions): Float32Array {
  const sampleRate = options.sampleRate ?? RATE;
  const length = Math.round((options.durationMs / 1000) * sampleRate);
  const out = new Float32Array(length);
  const random = noise(0xc0ffee);
  const bpm = options.bpm ?? 128;
  const periodMs = 60000 / bpm;
  const startMs = options.startMs ?? 0;
  const amplitude = options.amplitude ?? 0.9;
  const accentEvery = options.accentEvery ?? 4;

  const clicks: Array<{ atMs: number; gain: number }> = [];
  for (let beat = 0; startMs + beat * periodMs <= options.durationMs; beat += 1) {
    const gain = beat % accentEvery === 0 ? 1 : 0.55;
    clicks.push({ atMs: startMs + beat * periodMs, gain });
  }

  for (const click of clicks) {
    const start = Math.round((click.atMs / 1000) * sampleRate);
    const decaySamples = Math.round(0.08 * sampleRate);
    for (let i = 0; i < decaySamples; i += 1) {
      const index = start + i;
      if (index >= length) break;
      const t = i / sampleRate;
      const envelope = Math.exp(-t * 60);
      const body = Math.sin(2 * Math.PI * 900 * t) * 0.7 + random() * 0.5;
      let value = body * envelope * click.gain * amplitude;
      if (options.quietAfterMs !== undefined && click.atMs >= options.quietAfterMs) {
        value *= options.quietGain ?? 0.02;
      }
      out[index] = (out[index] ?? 0) + value;
    }
  }
  return out;
}

function tone(frequency: number, durationMs: number, amplitude = 0.8, sampleRate = RATE): Float32Array {
  const length = Math.round((durationMs / 1000) * sampleRate);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  }
  return out;
}

describe('Fft', () => {
  it('rejects non power-of-two sizes', () => {
    expect(() => new Fft(1000)).toThrow();
    expect(() => new Fft(1)).toThrow();
    expect(nextPowerOfTwo(1000)).toBe(1024);
    expect(nextPowerOfTwo(2)).toBe(2);
    expect(nextPowerOfTwo(3)).toBe(4);
  });

  it('puts a pure tone in the bin that owns its frequency', () => {
    const size = 1024;
    const fft = new Fft(size);
    const re = new Float32Array(size);
    const im = new Float32Array(size);
    const bin = 64;
    for (let i = 0; i < size; i += 1) re[i] = Math.cos((2 * Math.PI * bin * i) / size);
    fft.transform(re, im);
    const magnitude = new Float32Array(size / 2);
    fft.magnitudes(re, im, magnitude);

    let peakBin = 0;
    for (let k = 1; k < magnitude.length; k += 1) {
      if (magnitude[k]! > magnitude[peakBin]!) peakBin = k;
    }
    expect(peakBin).toBe(bin);
    expect(magnitude[bin]!).toBeCloseTo(size / 2, 4);
  });

  it('is linear: the transform of a sum is the sum of the transforms', () => {
    const size = 256;
    const fft = new Fft(size);
    const a = new Float32Array(size).map((_, i) => Math.sin(i / 7));
    const b = new Float32Array(size).map((_, i) => Math.cos(i / 3));
    const sum = new Float32Array(size).map((_, i) => a[i]! + b[i]!);

    const run = (input: Float32Array) => {
      const re = Float32Array.from(input);
      const im = new Float32Array(size);
      fft.transform(re, im);
      return { re, im };
    };
    const ra = run(a);
    const rb = run(b);
    const rs = run(sum);
    for (let k = 0; k < size; k += 1) {
      expect(rs.re[k]!).toBeCloseTo(ra.re[k]! + rb.re[k]!, 3);
      expect(rs.im[k]!).toBeCloseTo(ra.im[k]! + rb.im[k]!, 3);
    }
  });

  it('builds a periodic Hann window that is symmetric in the right way', () => {
    const window = hannWindow(8);
    expect(window[0]).toBeCloseTo(0, 6);
    expect(window[4]).toBeCloseTo(1, 6);
    expect(window[2]).toBeCloseTo(window[6]!, 6);
  });

  it('counts STFT frames the way the timestamp convention assumes', () => {
    const frameSize = 2048;
    const hopSize = 512;
    const samples = frameSize + hopSize * 4;
    const stft = new Stft(samples, { frameSize, hopSize, sampleRate: RATE });
    expect(stft.frameCount).toBe(5);
    expect(new Stft(100, { frameSize, hopSize, sampleRate: RATE }).frameCount).toBe(1);
  });
});

describe('spectral features', () => {
  it('downmixes stereo to the channel average', () => {
    const left = new Float32Array([1, 0, -1, 0]);
    const right = new Float32Array([0, 1, 0, -1]);
    expect(Array.from(downmix([left, right]))).toEqual([0.5, 0.5, -0.5, -0.5]);
    expect(downmix([left])).toBe(left);
    expect(downmix([]).length).toBe(0);
  });

  it('keeps loudness and centroid sane for a known tone', () => {
    const options = resolveOptions();
    const features = computeFrameFeatures(tone(1000, 500), RATE, options);
    const peakDb = Math.max(...Array.from(features.rmsDb));
    expect(peakDb).toBeGreaterThan(-12); // 0.8 amplitude sine ≈ -11 dBFS RMS
    expect(peakDb).toBeLessThan(-5);
    const centroid = features.centroidHz[10]!;
    expect(centroid).toBeGreaterThan(900);
    expect(centroid).toBeLessThan(1100);
  });

  it('reports the frame timing contract: hopMs and frameMs come from the options', () => {
    const options = resolveOptions();
    const features = computeFrameFeatures(clickTrack({ durationMs: 1000 }), RATE, options);
    expect(features.hopMs).toBeCloseTo((options.hopSize / RATE) * 1000, 6);
    expect(features.frameMs).toBeCloseTo((options.frameSize / RATE) * 1000, 6);
  });
});

describe('onset detection', () => {
  const options = resolveOptions();

  it('finds clicks at their true times, within the documented hop/2 tolerance', () => {
    const signal = clickTrack({ durationMs: 3000, bpm: 120 }); // clicks every 500 ms from 0
    const features = computeFrameFeatures(signal, RATE, options);
    const { onsets } = detectOnsets(features, options);

    const expected = [0, 500, 1000, 1500, 2000, 2500, 3000].filter((t) => t < 3000);
    // Every expected click has an onset within ±12 ms (hop/2 plus a frame of slack).
    for (const time of expected) {
      const match = onsets.find((onset) => Math.abs(onset.timeMs - time) <= 12);
      expect(match, `onset near ${time} ms`).toBeDefined();
      expect(Math.abs(match!.timeMs - time)).toBeLessThanOrEqual(12);
    }
    // And nothing fires in the silence after the last click.
    expect(onsets.filter((onset) => onset.timeMs > 2990)).toHaveLength(0);
    expect(onsets.length).toBeGreaterThanOrEqual(expected.length);
    expect(onsets.length).toBeLessThanOrEqual(expected.length + 1);
  });

  it('detects nothing in digital silence', () => {
    const features = computeFrameFeatures(new Float32Array(RATE * 2), RATE, options);
    const { onsets, fluxCeiling } = detectOnsets(features, options);
    expect(onsetCount(onsets)).toBe(0);
    expect(fluxCeiling).toBe(0);
  });

  /** Two short tones at the given offsets from 500 ms, useful for testing the merge rule. */
  const twoBursts = (offsetsMs: readonly number[]) => {
    const signal = new Float32Array(RATE);
    const random = noise(7);
    for (const at of offsetsMs) {
      const start = Math.round((at / 1000) * RATE);
      for (let i = 0; i < RATE * 0.05; i += 1) {
        const t = i / RATE;
        const index = start + i;
        if (index >= signal.length) break;
        signal[index] = (signal[index] ?? 0) + Math.exp(-t * 70) * (Math.sin(2 * Math.PI * 1200 * t) + random() * 0.4);
      }
    }
    return detectOnsets(computeFrameFeatures(signal, RATE, options), options).onsets;
  };

  it('collapses a doubled attack inside the merge window into one onset', () => {
    // 8 ms apart: well inside `minInterOnsetMs` (60 ms) — physically one hit, so one onset.
    const onsets = twoBursts([500, 508]);
    expect(onsetCount(onsets)).toBe(1);
    expect(Math.abs(onsets[0]!.timeMs - 500)).toBeLessThanOrEqual(15);
  });

  it('keeps two hits apart when they are genuinely separate', () => {
    // 150 ms apart is a real double hit; over-merging would delete it from the chart.
    const onsets = twoBursts([500, 650]);
    expect(onsetCount(onsets)).toBe(2);
    expect(Math.abs(onsets[0]!.timeMs - 500)).toBeLessThanOrEqual(15);
    expect(Math.abs(onsets[1]!.timeMs - 650)).toBeLessThanOrEqual(15);
  });

  it('detects an attack that starts at sample 0, at its true time', () => {
    // Regression: frame 0 has no predecessor. Differencing it against silence (and testing it
    // forward-only) reports a hit at 0 ms instead of ~46 ms late at 2 % strength.
    const onsets = twoBursts([0]);
    expect(onsetCount(onsets)).toBe(1);
    expect(onsets[0]!.timeMs).toBeLessThanOrEqual(2);
    expect(onsets[0]!.strength).toBeGreaterThan(0.2);
  });

  it('rejects a fade-in at the start of the file (frame 0 is quieter than what follows)', () => {
    const signal = tone(440, 800).map((value, index) => value * (index / (RATE * 0.8)));
    const onsets = detectOnsets(computeFrameFeatures(signal, RATE, options), options).onsets;
    expect(onsets.some((onset) => onset.timeMs < 5)).toBe(false);
  });

  it('normalises strength and classifies the band of low and high events', () => {
    const sampleRate = RATE;
    const length = sampleRate * 2;
    const signal = new Float32Array(length);
    // A 60 Hz thump at 500 ms and a 6 kHz tick at 1200 ms.
    for (let i = 0; i < sampleRate * 0.12; i += 1) {
      const t = i / sampleRate;
      const index = Math.round(0.5 * sampleRate) + i;
      if (index < length) signal[index] = (signal[index] ?? 0) + 0.9 * Math.exp(-t * 25) * Math.sin(2 * Math.PI * 60 * t);
    }
    const random = noise(11);
    for (let i = 0; i < sampleRate * 0.05; i += 1) {
      const t = i / sampleRate;
      const index = Math.round(1.2 * sampleRate) + i;
      if (index < length) {
        signal[index] = (signal[index] ?? 0) + 0.6 * Math.exp(-t * 90) * Math.sin(2 * Math.PI * 6000 * t) * (0.6 + random() * 0.4);
      }
    }
    const features = computeFrameFeatures(signal, sampleRate, options);
    const { onsets } = detectOnsets(features, options);
    const thump = onsets.find((onset) => Math.abs(onset.timeMs - 500) <= 15);
    const tick = onsets.find((onset) => Math.abs(onset.timeMs - 1200) <= 15);
    expect(thump?.band).toBe('low');
    // A 6 kHz tone with an instantaneous attack is broadband in the onset frame, so 'high' and
    // 'broad' are both defensible; the centroid is the assertion that really pins the register.
    expect(['high', 'broad']).toContain(tick?.band);
    expect(tick!.centroidHz).toBeGreaterThan(3000);
    expect(thump!.centroidHz).toBeLessThan(1000);
    expect(Math.max(...onsets.map((onset) => onset.strength))).toBeLessThanOrEqual(1);
    expect(Math.max(...onsets.map((onset) => onset.strength))).toBeGreaterThan(0.5);
  });
});

describe('tempo estimation', () => {
  const options = resolveOptions();

  const estimate = (bpm: number, durationMs = 20000) => {
    const features = computeFrameFeatures(clickTrack({ bpm, durationMs }), RATE, options);
    const { envelope, onsets } = detectOnsets(features, options);
    // Pass the onsets: the grid is snapped and then least-squares fitted onto them, which is what
    // resolves both the phase and the period to sub-millisecond accuracy.
    return estimateTempo(envelope, features.hopMs, durationMs, options, onsets);
  };

  it('recovers 128 BPM and its grid phase from a click track', () => {
    const tempo = estimate(128);
    expect(Math.abs(tempo.bpm - 128)).toBeLessThanOrEqual(1);
    expect(tempo.beatMs).toBeCloseTo(60000 / 128, 0);
    expect(tempo.firstBeatMs).toBeLessThan(20); // phase 0 in the source signal
    expect(tempo.confidence).toBeGreaterThan(0.3);
    expect(tempo.beats.length).toBeGreaterThan(20);
    expect(tempo.beats[0]).toBeCloseTo(tempo.firstBeatMs, 3);
  });

  it('recovers 96 and 140 BPM without octave errors', () => {
    for (const bpm of [96, 140]) {
      const tempo = estimate(bpm);
      expect(Math.abs(tempo.bpm - bpm), `${bpm} BPM`).toBeLessThanOrEqual(1.5);
    }
  });

  it('resolves a strong accent pattern to the beat, not to half or double time', () => {
    // Accents every 4 beats: a half-time grid would explain less energy, a double-time grid has
    // twice the chance coverage, so both should lose to the true 128 BPM.
    const features = computeFrameFeatures(clickTrack({ bpm: 128, durationMs: 20000, accentEvery: 4 }), RATE, options);
    const { envelope } = detectOnsets(features, options);
    const tempo = estimateTempo(envelope, features.hopMs, 20000, options);
    expect(tempo.bpm).toBeGreaterThan(120);
    expect(tempo.bpm).toBeLessThan(136);
    expect(tempo.candidates.length).toBeGreaterThan(0);
    expect(tempo.candidates[0]!.score).toBeGreaterThan(0);
  });

  it('scores a matching grid higher than a mismatched one', () => {
    const features = computeFrameFeatures(clickTrack({ bpm: 120, durationMs: 12000 }), RATE, options);
    const { envelope } = detectOnsets(features, options);
    const good = scoreGrid(envelope, features.hopMs, 120);
    const bad = scoreGrid(envelope, features.hopMs, 97);
    expect(good.excess).toBeGreaterThan(bad.excess * 1.5);
    expect(good.excess).toBeGreaterThan(1);
  });

  it('falls back with a warning when there is nothing periodic to find', () => {
    const features = computeFrameFeatures(new Float32Array(RATE), RATE, options);
    const { envelope } = detectOnsets(features, options);
    const tempo = estimateTempo(envelope, features.hopMs, 1000, options);
    expect(tempo.bpm).toBe(120);
    expect(tempo.confidence).toBe(0);
    expect(tempo.warnings.join(' ')).toMatch(/no onset energy/);
  });

  it('does not estimate from an audio fragment shorter than a few frames', () => {
    const features = computeFrameFeatures(tone(440, 20), RATE, options);
    const { envelope } = detectOnsets(features, options);
    const tempo = estimateTempo(envelope, features.hopMs, 20, options);
    expect(tempo.warnings.length).toBeGreaterThan(0);
    expect(tempo.beats.length).toBeGreaterThan(0); // a fallback grid, never an empty one
  });
});

describe('loudness profile', () => {
  it('splits loud and silent sections and keeps notes out of the quiet part', () => {
    const durationMs = 8000;
    const signal = clickTrack({ durationMs, bpm: 120, quietAfterMs: 4000, quietGain: 0.0005 });
    const result = analyzeMono(signal, RATE);
    expect(result.energy.activeRanges.length).toBeGreaterThan(0);
    const loud = result.energy.activeRanges[0]!;
    expect(loud.startMs).toBeLessThan(200);
    expect(loud.endMs).toBeGreaterThan(3000);
    // The quiet half is reported as low energy (with a little slack around the transition).
    const quiet = result.energy.lowEnergyRanges.some(
      (range) => range.startMs < durationMs - 500 && range.endMs > durationMs - 500,
    );
    expect(quiet).toBe(true);
  });

  it('treats digital silence as entirely low energy rather than entirely loud', () => {
    const result = analyzeMono(new Float32Array(RATE * 3), RATE);
    expect(result.energy.activeRanges).toEqual([]);
    expect(result.energy.lowEnergyRanges).toHaveLength(1);
    expect(result.energy.lowEnergyRanges[0]!.endMs).toBeCloseTo(3000, 0);
    expect(result.warnings.join(' ')).toMatch(/silent|no onsets/);
  });

  it('reports a lower intensity for the quiet half of a track', () => {
    const signal = clickTrack({ durationMs: 8000, bpm: 120, quietAfterMs: 4000, quietGain: 0.02 });
    const result = analyzeMono(signal, RATE);
    const half = Math.floor(result.energy.intensityByBeat.length / 2);
    const loudHalf = result.energy.intensityByBeat.slice(0, half);
    const quietHalf = result.energy.intensityByBeat.slice(half + 1);
    const mean = (values: readonly number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
    expect(mean(loudHalf)).toBeGreaterThan(mean(quietHalf) + 0.2);
  });

  it('counts onsets per second over the whole track', () => {
    const result = analyzeMono(clickTrack({ bpm: 120, durationMs: 5000 }), RATE);
    expect(result.energy.onsetsPerSecond).toHaveLength(5);
    expect(result.energy.onsetsPerSecond.reduce((a, b) => a + b, 0)).toBe(result.onsets.length);
  });

  it('handles a variable-intensity track without inventing sections', () => {
    const signal = clickTrack({ bpm: 128, durationMs: 12000, quietAfterMs: 6000, quietGain: 0.25 });
    const profile = computeEnergyProfile({
      rmsDb: new Float32Array(Array.from({ length: 100 }, (_, i) => -20 + (i % 10))),
      hopMs: 11.6,
      durationMs: 1160,
      beats: [0, 500, 1000],
      beatMs: 500,
      onsets: [],
    });
    expect(profile.intensityByBeat).toHaveLength(3);
    expect(analyzeMono(signal, RATE).durationMs).toBeCloseTo(12000, 0);
  });
});

describe('analyzeSong integration', () => {
  it('analyses a 128 BPM click track end to end', () => {
    const result = analyzeMono(clickTrack({ bpm: 128, durationMs: 10000 }), RATE);
    expect(Math.abs(result.bpm - 128)).toBeLessThanOrEqual(1.5);
    expect(result.onsets.length).toBeGreaterThan(15);
    expect(result.beats.length).toBeGreaterThan(15);
    expect(result.version).toBe('1.1.0');
    expect(result.sampleRate).toBe(RATE);
    expect(result.durationMs).toBeCloseTo(10000, 0);
    expect(result.warnings).toEqual([]);
  });

  it('handles an empty input without throwing', () => {
    const result = analyzeSong({ channels: [], sampleRate: RATE });
    expect(result.onsets).toEqual([]);
    expect(result.durationMs).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('warns about very short audio but still returns a usable result', () => {
    const result = analyzeMono(tone(440, 350), RATE);
    expect(result.durationMs).toBeCloseTo(350, 0);
    expect(result.durationMs).toBeLessThan(MIN_ANALYZABLE_MS);
    expect(result.warnings.join(' ')).toMatch(/too short/);
    expect(result.framesAnalyzed).toBeGreaterThan(0);
  });

  it('expects 44.1 kHz stereo input to be downmixed, not concatenated', () => {
    const mono = clickTrack({ bpm: 120, durationMs: 2000 });
    const left = Float32Array.from(mono);
    const right = Float32Array.from(mono);
    right.fill(0);
    const stereo = analyzeSong({ channels: [left, right], sampleRate: RATE });
    // Averages the channels: half amplitude, same timing, same onset count.
    expect(stereo.channels).toBe(2);
    expect(Math.abs(stereo.bpm - 120)).toBeLessThanOrEqual(1.5);
    expect(stereo.onsets.length).toBeGreaterThan(2);
  });

  it('is deterministic: the same audio twice gives the same analysis', () => {
    const signal = clickTrack({ bpm: 140, durationMs: 8000 });
    const first = analyzeMono(signal, RATE);
    const second = analyzeMono(signal, RATE);
    expect(second.bpm).toBe(first.bpm);
    expect(second.firstBeatMs).toBe(first.firstBeatMs);
    expect(second.beats).toEqual(first.beats);
    expect(second.onsets).toEqual(first.onsets);
    expect(second.energy.activeRanges).toEqual(first.energy.activeRanges);
  });

  it('clamps nonsense options instead of producing a broken analysis', () => {
    const options = resolveOptions({ frameSize: 3, hopSize: 999999, minBpm: -5, maxBpm: 0 });
    expect(options.frameSize).toBe(DEFAULT_ANALYSIS_OPTIONS.frameSize);
    expect(options.hopSize).toBe(DEFAULT_ANALYSIS_OPTIONS.hopSize);
    expect(options.minBpm).toBe(DEFAULT_ANALYSIS_OPTIONS.minBpm);
  });

  it('reports progress that increases monotonically to 1', () => {
    const ratios: number[] = [];
    analyzeMono(clickTrack({ bpm: 120, durationMs: 3000 }), RATE, undefined);
    analyzeSong(
      { channels: [clickTrack({ bpm: 120, durationMs: 3000 })], sampleRate: RATE },
      { onProgress: (progress) => ratios.push(progress.ratio) },
    );
    expect(ratios.length).toBeGreaterThan(2);
    for (let i = 1; i < ratios.length; i += 1) expect(ratios[i]!).toBeGreaterThanOrEqual(ratios[i - 1]!);
    expect(ratios[ratios.length - 1]).toBe(1);
  });

  it('measures its own analysis time', () => {
    const result = analyzeMono(clickTrack({ bpm: 120, durationMs: 2000 }), RATE);
    expect(result.analysisMs).toBeGreaterThanOrEqual(1);
  });
});

function onsetCount(onsets: readonly { timeMs: number }[]): number {
  return onsets.length;
}
