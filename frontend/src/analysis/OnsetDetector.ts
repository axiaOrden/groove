/**
 * Onset detection: one STFT pass, then adaptive peak picking.
 *
 * Pipeline, per frame:
 *
 *     PCM → Hann window → FFT → log-compressed magnitude → positive spectral flux
 *
 * Spectral flux is the standard onset-detection function; the log compression
 * (`log10(1 + c·|X|)`) is what makes it work across a wide dynamic range — a quiet hi-hat in a
 * loud mix still produces a visible spike, where on a linear spectrum it would be buried. The
 * flux is also accumulated **per band** (low / mid / high), because the chart generator wants to
 * know *what kind of event* an onset is: a kick should land in a different lane from a lead note,
 * and that is what turns "random lanes on every beat" into something that tracks the music.
 *
 * Peak picking is adaptive (a peak must beat the local median by `onsetDelta`) and the reported
 * timestamp is the **start of the attack**, not the top of the flux peak: that systematic
 * correction is worth roughly one hop (~12 ms) of timing accuracy for free.
 */

import { Stft } from './Fft';
import type { AnalysisOptions, OnsetBand, OnsetEvent } from './types';

export interface FrameFeatures {
  frameCount: number;
  /** Frame period in ms (one analysis hop). */
  hopMs: number;
  /** Frame window length in ms. */
  frameMs: number;
  /** Positive log-spectral flux, normalised by bin count. */
  flux: Float32Array;
  /** Band-limited flux: 20–200 Hz, 200–2000 Hz, 2–16 kHz. */
  lowFlux: Float32Array;
  midFlux: Float32Array;
  highFlux: Float32Array;
  /** Spectral centroid per frame in Hz. */
  centroidHz: Float32Array;
  /** Frame loudness in dBFS. */
  rmsDb: Float32Array;
  /**
   * Fine-grained time envelope: RMS of consecutive `FINE_HOP` sample blocks, in dBFS.
   *
   * This exists to beat the one real weakness of flux-based onsets. Frame *i* covers
   * `[i*hop, i*hop + frameSize)`, so energy from an event anywhere in that window shows up at the
   * frame's *start*: an event landing near the right edge is reported up to `frameSize - hop`
   * (~35 ms at 2048/512) early. That is more than half a PERFECT window, so peak picking alone is
   * not accurate enough for a rhythm game. The fine envelope (1.45 ms resolution) locates the
   * actual attack inside the frame. See `refineOnsetTime`.
   */
  fineDb: Float32Array;
  fineHopMs: number;
}

/** Fine envelope block size, in samples (64 ≈ 1.45 ms at 44.1 kHz). */
export const FINE_HOP = 64;

/** Log-compression factor for the magnitude spectrum. */
const COMPRESSION = 1000;

const LOW_HZ = 200;
const MID_HZ = 2000;
const HIGH_HZ = 16000;

/** Average the channels into one mono signal (analysis only, never playback). */
export function downmix(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0]!;
  const length = channels[0]!.length;
  const out = new Float32Array(length);
  for (const channel of channels) {
    const count = Math.min(length, channel.length);
    for (let i = 0; i < count; i += 1) out[i] = out[i]! + channel[i]!;
  }
  const scale = 1 / channels.length;
  for (let i = 0; i < length; i += 1) out[i] = out[i]! * scale;
  return out;
}

export function computeFrameFeatures(
  signal: Float32Array,
  sampleRate: number,
  options: AnalysisOptions,
  onProgress?: (ratio: number) => void,
): FrameFeatures {
  const stft = new Stft(signal.length, { frameSize: options.frameSize, hopSize: options.hopSize });
  const frameCount = stft.frameCount;
  const flux = new Float32Array(frameCount);
  const lowFlux = new Float32Array(frameCount);
  const midFlux = new Float32Array(frameCount);
  const highFlux = new Float32Array(frameCount);
  const centroidHz = new Float32Array(frameCount);
  const rmsDb = new Float32Array(frameCount);

  const bins = stft.bins;
  const binHz = sampleRate / options.frameSize;
  const previous = new Float32Array(bins);
  const lowMax = Math.max(1, Math.min(bins, Math.round(LOW_HZ / binHz)));
  const midMax = Math.max(lowMax + 1, Math.min(bins, Math.round(MID_HZ / binHz)));
  const highMax = Math.max(midMax + 1, Math.min(bins, Math.round(HIGH_HZ / binHz)));

  // Each band's flux is divided by the number of bins it spans. Without that, a broadband tick
  // (energy spread over hundreds of bins) would outscore a kick (energy in three bins) by two
  // orders of magnitude, and bass-heavy music would look like it had almost no onsets at all.
  const lowScale = 1 / Math.max(1, lowMax);
  const midScale = 1 / Math.max(1, midMax - lowMax);
  const highScale = 1 / Math.max(1, highMax - midMax);

  let first = true;
  stft.process(signal, sampleRate, (frame, magnitude, _frameStartMs, rms) => {
    let total = 0;
    let weighted = 0;
    let low = 0;
    let mid = 0;
    let high = 0;
    for (let k = 0; k < bins; k += 1) {
      const magnitudeK = magnitude[k]!;
      const value = Math.log10(1 + COMPRESSION * magnitudeK);
      total += magnitudeK;
      weighted += magnitudeK * k * binHz;
      // Frame 0 is differenced against digital silence (delta = value), everything else against
      // the previous frame's log magnitude.
      const delta = value - (first ? 0 : previous[k]!);
      if (delta > 0) {
        if (k < lowMax) low += delta;
        else if (k < midMax) mid += delta;
        else if (k < highMax) high += delta;
      }
      previous[k] = value;
    }
    // Frame 0 has no predecessor frame, but a file can legitimately open with a hit. Differencing
    // it against digital silence is the correct model for the first sample of a file: a track that
    // starts with an attack gets an onset at t≈0 instead of one whole window later (46 ms at
    // 2048/512, which is outside the PERFECT window). A fade-in is rejected by peak picking, whose
    // forward-median test sees the first frame is *quieter* than what follows. The tempo envelope
    // deliberately ignores this frame (see `detectOnsets`) so it cannot bias the grid phase.
    lowFlux[frame] = low * lowScale;
    midFlux[frame] = mid * midScale;
    highFlux[frame] = high * highScale;
    flux[frame] = lowFlux[frame]! + midFlux[frame]! + highFlux[frame]!;
    centroidHz[frame] = total > 1e-9 ? weighted / total : 0;
    rmsDb[frame] = 20 * Math.log10(rms + 1e-9);
    first = false;
    if (onProgress && (frame & 1023) === 0) onProgress(frame / Math.max(1, frameCount));
  });

  return {
    frameCount,
    hopMs: (options.hopSize / sampleRate) * 1000,
    frameMs: (options.frameSize / sampleRate) * 1000,
    flux,
    lowFlux,
    midFlux,
    highFlux,
    centroidHz,
    rmsDb,
    fineDb: computeFineEnvelope(signal),
    fineHopMs: (FINE_HOP / sampleRate) * 1000,
  };
}

/** RMS of consecutive FINE_HOP-sample blocks, in dBFS. O(n), no FFT. */
export function computeFineEnvelope(signal: Float32Array): Float32Array {
  const blocks = Math.max(1, Math.ceil(signal.length / FINE_HOP));
  const out = new Float32Array(blocks);
  for (let block = 0; block < blocks; block += 1) {
    const start = block * FINE_HOP;
    const end = Math.min(signal.length, start + FINE_HOP);
    let sum = 0;
    for (let i = start; i < end; i += 1) sum += signal[i]! * signal[i]!;
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    out[block] = 20 * Math.log10(rms + 1e-9);
  }
  return out;
}

/**
 * Find the true attack inside the frames a flux peak points at.
 *
 * The search window is `[frame*hop, frame*hop + frameSize]`, i.e. every sample the flux peak could
 * have been caused by. Inside it we take the first fine block that rises above a threshold relative
 * to both the local peak and the immediately preceding noise floor — "first crossing of a rising
 * edge" — which is the attack, not the middle of the window.
 *
 * The reported time is the **centre** of that block (the same convention the frame grid uses with
 * hop/2). Reporting the block's start instead biased every onset up to one fine block (1.45 ms)
 * early, and a systematic lead is exactly what a beat grid fitted to the onsets does not tolerate:
 * it pushes the fitted phase just below zero and the grid's first beat off the start of the track.
 */
export function refineOnsetTime(
  features: FrameFeatures,
  frame: number,
  hopSize: number,
  frameSize: number,
  sampleRate: number,
): number {
  const { fineDb, fineHopMs } = features;
  const samplesPerFine = (FINE_HOP / sampleRate) * sampleRate;
  const firstBlock = Math.max(0, Math.floor((frame * hopSize - hopSize) / samplesPerFine));
  const lastBlock = Math.min(fineDb.length - 1, Math.ceil((frame * hopSize + frameSize) / samplesPerFine));
  if (lastBlock <= firstBlock) return frame * ((hopSize / sampleRate) * 1000);

  let peak = -Infinity;
  for (let block = firstBlock; block <= lastBlock; block += 1) peak = Math.max(peak, fineDb[block]!);
  const floorFrom = Math.max(0, firstBlock - Math.round(30 / fineHopMs));
  let floorSum = 0;
  let floorCount = 0;
  for (let block = floorFrom; block < firstBlock; block += 1) {
    floorSum += fineDb[block]!;
    floorCount += 1;
  }
  const noiseFloor = floorCount > 0 ? floorSum / floorCount : -120;
  const threshold = Math.max(peak - 12, noiseFloor + 8);

  for (let block = firstBlock; block <= lastBlock; block += 1) {
    if (fineDb[block]! >= threshold) return (block + 0.5) * fineHopMs;
  }
  return frame * ((hopSize / sampleRate) * 1000) + (frameSize / sampleRate) * 500;
}

/** Value at a quantile, computed on a copy so the input is never reordered. */
export function percentile(values: Float32Array, ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(ratio * (sorted.length - 1))));
  return sorted[index]!;
}

export interface OnsetDetection {
  onsets: OnsetEvent[];
  /** Onset-strength envelope used for tempo estimation (flux normalised to 0..1). */
  envelope: Float32Array;
  /** 95th-percentile flux: the reference level for onset strength and the absolute floor. */
  fluxCeiling: number;
  /** Mean lead of the flux peak over the refined attack time, in ms (diagnostics). */
  meanFluxLeadMs: number;
}

/**
 * Adaptive peak picking.
 *
 *  - A frame is a candidate when its flux beats the local **median** (a mean is dragged upwards by
 *    dense passages and then misses quiet onsets) scaled by `1 + onsetDelta`, and beats 5 % of the
 *    track's 95th-percentile flux (so noise in a silent section cannot fire).
 *  - From the peak we walk **back** to the first frame of the rise, which removes the systematic
 *    lag of reporting the top of the flux peak.
 *  - Candidates closer than `minInterOnsetMs` collapse to the strongest, so one drum hit smeared
 *    over several frames yields one onset (see the duplicate-onset tests).
 *  - Frame 0 is tested against the frames *after* it rather than around it (there is nothing
 *    before it). Since frame 0 was differenced against silence, this catches a track that opens
 *    with a hit at ~0 ms and rejects a fade-in, whose first frame is quieter than its neighbours.
 */
export function detectOnsets(
  features: FrameFeatures,
  options: AnalysisOptions,
  onProgress?: (ratio: number) => void,
  sampleRate = 44100,
): OnsetDetection {
  const { flux, frameCount, hopMs } = features;
  const ceiling = percentile(flux, 0.95);
  const floor = ceiling * 0.05;
  const window = Math.max(1, Math.round(options.onsetWindow));
  const envelope = new Float32Array(frameCount);
  if (ceiling > 0) {
    // Frame 0 is skipped: it is differenced against silence (see `computeFrameFeatures`), so its
    // value describes "the file does not start silent" rather than a pulse, and including it would
    // pull the grid phase towards t=0.
    for (let i = 1; i < frameCount; i += 1) envelope[i] = Math.min(1, flux[i]! / ceiling);
  }

  const peaks: Array<{ frame: number; flux: number }> = [];

  if (frameCount > 2 && flux[0]! > floor) {
    const forward: number[] = [];
    for (let k = 1; k <= window && k < frameCount; k += 1) forward.push(flux[k]!);
    forward.sort((a, b) => a - b);
    const forwardMedian = forward[Math.floor(forward.length / 2)] ?? 0;
    if (flux[0]! >= forwardMedian * (1 + options.onsetDelta)) {
      peaks.push({ frame: 0, flux: flux[0]! });
    }
  }

  for (let i = 1; i < frameCount - 1; i += 1) {
    const value = flux[i]!;
    if (value <= floor) continue;
    if (value < flux[i - 1]! || value < flux[i + 1]!) continue;

    const local: number[] = [];
    for (let k = -window; k <= window; k += 1) {
      const index = i + k;
      if (index < 0 || index >= frameCount) continue;
      local.push(flux[index]!);
    }
    local.sort((a, b) => a - b);
    const median = local[Math.floor(local.length / 2)]!;
    if (value < median * (1 + options.onsetDelta)) continue;

    // Walk back to the start of the attack so the timestamp is not the top of the peak.
    let start = i;
    while (start > 1 && flux[start - 1]! <= flux[start]! && flux[start - 1]! > median) start -= 1;
    peaks.push({ frame: start, flux: value });
    if (onProgress && peaks.length % 256 === 0) onProgress(i / Math.max(1, frameCount));
  }

  // Merge onsets that are too close together: one physical event, one note.
  const merged: Array<{ frame: number; flux: number }> = [];
  for (const peak of peaks) {
    const previous = merged[merged.length - 1];
    if (previous) {
      const gapMs = (peak.frame - previous.frame) * hopMs;
      if (gapMs < options.minInterOnsetMs) {
        if (peak.flux > previous.flux) merged[merged.length - 1] = peak;
        continue;
      }
    }
    merged.push(peak);
  }

  // Echo suppression. As the window slides past a loud attack the flux can rise again a frame or
  // two later (the window's leading edge picks up more of the same event). Those re-rises are weak
  // — 1–3 % of the attack in the synthetic click track — but they would become extra notes. Any
  // peak within one analysis window of a peak at least 3× stronger is a shadow of that peak.
  const windowFrames = Math.ceil(options.frameSize / options.hopSize) + 2;
  const surviving: Array<{ frame: number; flux: number }> = [];
  for (let i = 0; i < merged.length; i += 1) {
    const peak = merged[i]!;
    let shadow = false;
    for (let j = i - 1; j >= 0 && peak.frame - merged[j]!.frame <= windowFrames; j -= 1) {
      if (merged[j]!.flux >= peak.flux * 3) {
        shadow = true;
        break;
      }
    }
    for (let j = i + 1; !shadow && j < merged.length && merged[j]!.frame - peak.frame <= windowFrames; j += 1) {
      if (merged[j]!.flux >= peak.flux * 3) {
        shadow = true;
        break;
      }
    }
    if (!shadow) surviving.push(peak);
  }

  // Relative strength gate: the 95th percentile is the track's "strong onset" level, and anything
  // 20 dB or more below it is windowing residue rather than an event a player could react to.
  // Being relative keeps quiet tracks (and quiet sections of loud tracks) usable.
  const strong = percentile(Float32Array.from(surviving.map((peak) => peak.flux)), 0.95) || 1;
  const kept = surviving.filter((peak) => peak.flux >= strong * options.minOnsetStrength);
  let leadSum = 0;
  let leadCount = 0;
  const onsets: OnsetEvent[] = kept.map((peak) => {
    const frameMs = peak.frame * hopMs;
    const refinedMs = refineOnsetTime(features, peak.frame, options.hopSize, options.frameSize, sampleRate);
    // Diagnostics only: how far the flux peak (at the frame's start) leads the real attack.
    leadSum += frameMs + hopMs / 2 - refinedMs;
    leadCount += 1;
    const low = features.lowFlux[peak.frame]!;
    const mid = features.midFlux[peak.frame]!;
    const high = features.highFlux[peak.frame]!;
    // Band flux values are already normalised per band (see computeFrameFeatures), so they are
    // directly comparable: whichever register gained the most energy names the onset.
    const ranked = [low, mid, high].sort((a, b) => b - a);
    const band: OnsetBand =
      ranked[0]! <= 0 || ranked[1]! / ranked[0]! > 0.75
        ? 'broad'
        : ranked[0] === low
          ? 'low'
          : ranked[0] === mid
            ? 'mid'
            : 'high';
    return {
      timeMs: roundMs(Math.max(0, refinedMs)),
      strength: roundMs(Math.min(1, peak.flux / strong)),
      band,
      centroidHz: Math.round(features.centroidHz[peak.frame]!),
      flux: peak.flux,
    };
  });

  return {
    onsets,
    envelope,
    fluxCeiling: ceiling,
    meanFluxLeadMs: roundMs(leadCount > 0 ? leadSum / leadCount : 0),
  };
}

/** Round to 1/1000 ms like the chart schema does, so timestamps compare cleanly in tests. */
export function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}
