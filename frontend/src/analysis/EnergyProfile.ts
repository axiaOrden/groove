/**
 * Loudness, silence and intensity profiling.
 *
 * The chart generator needs three things out of this module:
 *
 *  1. **Where the music is.** Notes must not be placed in silence or in a near-silent intro, so we
 *     hand it `activeRanges` (musical) and `lowEnergyRanges` (quiet), which is what stops a chart
 *     from filling a silent outro with notes.
 *  2. **How loud each beat is**, as `intensityByBeat` (0..1). This is what makes the chart follow
 *     the music's dynamics: a chorus gets chords and extra subdivisions, a breakdown gets singles.
 *  3. **How busy the music is**, as `onsetsPerSecond`, which caps density instead of letting a
 *     drum-heavy section flood the lanes.
 *
 * Activity is decided **per beat, not per frame**, and that distinction matters: percussive music
 * is mostly silence between hits, so a frame-level threshold followed by a minimum-duration filter
 * classifies a perfectly loud drum track as "silent" (this was a real bug caught by the tests). The
 * right question for a rhythm game is "is there music at this beat?", which is what is measured
 * here: the loudest frame in a window around each beat, against a threshold relative to the
 * track's own peak.
 *
 * A digital-silence file is special-cased: its RMS floor is around -180 dBFS, so a purely relative
 * threshold would call every frame "loud". `SILENCE_PEAK_DB` marks the whole track low-energy
 * instead, which is what the "empty or silent audio" tests assert.
 */

import type { EnergyProfile, OnsetEvent, TimeRange } from './types';
import { percentile, roundMs } from './OnsetDetector';

/** A track whose loudest frame is below this is treated as silent, not as "quiet music". */
export const SILENCE_PEAK_DB = -60;

/** Default drop below the track's peak that counts as "quiet". */
export const DEFAULT_SILENCE_DROP_DB = 45;

/** Two active beats separated by at most this many beat slots stay in one section. */
const BEAT_GAP_SLOTS = 2;

export interface EnergyInput {
  rmsDb: Float32Array;
  hopMs: number;
  durationMs: number;
  beats: readonly number[];
  beatMs: number;
  onsets: readonly OnsetEvent[];
  silenceDropDb?: number;
}

export function computeEnergyProfile(input: EnergyInput): EnergyProfile {
  const { rmsDb, hopMs, durationMs, beats, beatMs, onsets } = input;
  const frames = rmsDb.length;
  const frameDb = new Array<number>(frames);
  for (let i = 0; i < frames; i += 1) frameDb[i] = roundMs(rmsDb[i]!);

  const peakDb = frames === 0 ? SILENCE_PEAK_DB : percentile(rmsDb, 0.995);
  const floorDb = roundMs(peakDb - (input.silenceDropDb ?? DEFAULT_SILENCE_DROP_DB));

  if (frames === 0 || peakDb < SILENCE_PEAK_DB) {
    return {
      frameDb,
      frameMs: hopMs,
      peakDb: roundMs(peakDb),
      meanDb: roundMs(peakDb),
      floorDb,
      activeRanges: [],
      lowEnergyRanges: durationMs > 0 ? [{ startMs: 0, endMs: roundMs(durationMs) }] : [],
      intensityByBeat: [],
      onsetsPerSecond: onsetsPerSecond(onsets, durationMs),
    };
  }

  // ------------------------------------------------------------------ sections ---
  const beforeMs = beatMs > 0 ? Math.min(beatMs * 0.3, 150) : 100;
  const afterMs = beatMs > 0 ? Math.min(beatMs * 0.6, 300) : 200;
  const beatIsActive = beats.map((timeMs) => {
    const from = Math.max(0, Math.min(frames - 1, Math.round((timeMs - beforeMs) / hopMs)));
    const to = Math.max(from, Math.min(frames - 1, Math.round((timeMs + afterMs) / hopMs)));
    let loudest = -Infinity;
    for (let frame = from; frame <= to; frame += 1) loudest = Math.max(loudest, rmsDb[frame]!);
    return loudest >= floorDb;
  });

  const activeRanges = beats.length > 0 ? sectionsFromBeats(beats, beatIsActive, beforeMs, afterMs, beatMs, durationMs) : sectionsFromFrames(rmsDb, hopMs, floorDb, durationMs);
  const lowEnergyRanges = invertRanges(activeRanges, durationMs).filter(
    (range) => range.endMs - range.startMs >= Math.min(150, Math.max(60, beatMs * 0.25)),
  );

  let activeSum = 0;
  let activeCount = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    if (rmsDb[frame]! >= floorDb) {
      activeSum += rmsDb[frame]!;
      activeCount += 1;
    }
  }

  // ----------------------------------------------------------------- intensity ---
  const intensityByBeat: number[] = [];
  const windowMs = beatMs > 0 ? beatMs * 0.6 : 250;
  for (let index = 0; index < beats.length; index += 1) {
    const timeMs = beats[index]!;
    const frame = Math.max(0, Math.min(frames - 1, Math.round(timeMs / hopMs)));
    const loud = clamp01((rmsDb[frame]! - floorDb) / Math.max(1, peakDb - floorDb));
    let nearby = 0;
    for (const onset of onsets) {
      if (onset.timeMs < timeMs - windowMs) continue;
      if (onset.timeMs > timeMs + windowMs) break;
      nearby += 1;
    }
    // ~4 onsets around a beat is as busy as a Normal chart should ever be, so it saturates there.
    const busy = clamp01(nearby / 4);
    const active = beatIsActive[index] === true ? 1 : 0;
    intensityByBeat.push(roundMs(clamp01(active * (0.65 * loud + 0.35 * busy))));
  }

  return {
    frameDb,
    frameMs: hopMs,
    peakDb: roundMs(peakDb),
    meanDb: roundMs(activeCount > 0 ? activeSum / activeCount : peakDb),
    floorDb,
    activeRanges,
    lowEnergyRanges,
    intensityByBeat,
    onsetsPerSecond: onsetsPerSecond(onsets, durationMs),
  };
}

/** Sections from the per-beat activity flags: consecutive active beats, merging across short gaps. */
function sectionsFromBeats(
  beats: readonly number[],
  active: readonly boolean[],
  beforeMs: number,
  afterMs: number,
  beatMs: number,
  durationMs: number,
): TimeRange[] {
  const ranges: TimeRange[] = [];
  let startIndex = -1;
  let lastIndex = -1;
  for (let index = 0; index < beats.length; index += 1) {
    if (active[index] === true) {
      if (startIndex === -1) startIndex = index;
      lastIndex = index;
      continue;
    }
    if (startIndex !== -1 && index - lastIndex > BEAT_GAP_SLOTS) {
      ranges.push(beatRange(beats, startIndex, lastIndex, beforeMs, afterMs, beatMs));
      startIndex = -1;
    }
  }
  if (startIndex !== -1) ranges.push(beatRange(beats, startIndex, lastIndex, beforeMs, afterMs, beatMs));
  return ranges.map((range) => ({
    startMs: roundMs(Math.max(0, range.startMs)),
    endMs: roundMs(Math.min(durationMs, range.endMs)),
  }));
}

function beatRange(
  beats: readonly number[],
  fromIndex: number,
  toIndex: number,
  beforeMs: number,
  afterMs: number,
  beatMs: number,
): TimeRange {
  return {
    startMs: beats[fromIndex]! - beforeMs,
    endMs: beats[toIndex]! + Math.max(afterMs, beatMs * 0.9),
  };
}

/** Fallback when no beat grid exists: runs of loud frames, merged across short gaps. */
function sectionsFromFrames(
  rmsDb: Float32Array,
  hopMs: number,
  floorDb: number,
  durationMs: number,
): TimeRange[] {
  const ranges: TimeRange[] = [];
  let start: number | null = null;
  for (let frame = 0; frame < rmsDb.length; frame += 1) {
    const active = rmsDb[frame]! >= floorDb;
    if (active && start === null) start = frame;
    if (!active && start !== null) {
      ranges.push({ startMs: start * hopMs, endMs: frame * hopMs });
      start = null;
    }
  }
  if (start !== null) ranges.push({ startMs: start * hopMs, endMs: durationMs });
  // Merge across gaps of up to 250 ms so a sparse percussive track reads as one section.
  const merged: TimeRange[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.startMs - previous.endMs <= 250) {
      previous.endMs = range.endMs;
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

function onsetsPerSecond(onsets: readonly OnsetEvent[], durationMs: number): number[] {
  const seconds = Math.max(1, Math.ceil(durationMs / 1000));
  const out = new Array<number>(seconds).fill(0);
  for (const onset of onsets) {
    const index = Math.max(0, Math.min(seconds - 1, Math.floor(onset.timeMs / 1000)));
    out[index] = (out[index] ?? 0) + 1;
  }
  return out;
}

function invertRanges(ranges: readonly TimeRange[], durationMs: number): TimeRange[] {
  const inverted: TimeRange[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.startMs > cursor) inverted.push({ startMs: cursor, endMs: range.startMs });
    cursor = Math.max(cursor, range.endMs);
  }
  if (cursor < durationMs) inverted.push({ startMs: cursor, endMs: roundMs(durationMs) });
  return inverted.map((range) => ({ startMs: roundMs(range.startMs), endMs: roundMs(range.endMs) }));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
