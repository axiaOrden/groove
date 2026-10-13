import { describe, expect, it } from 'vitest';
import { PlaybackTimeline } from '../src/audio/PlaybackTimeline';
import {
  BASE_LEAD_MS,
  LANE_COUNT,
  ROAD_LENGTH,
  clampNoteSpeed,
  holdLengthForDuration,
  laneToX,
  leadMsForSpeed,
  timeToHitForZ,
  zForTimeToHit,
} from '../src/renderer/Layout';

describe('PlaybackTimeline', () => {
  it('starts idle at 0', () => {
    const timeline = new PlaybackTimeline();
    expect(timeline.getSongTimeMs(123.456)).toBe(0);
    expect(timeline.isRunning(123.456)).toBe(false);
  });

  it('runs from an anchor and allows negative (count-in) time', () => {
    const timeline = new PlaybackTimeline();
    timeline.start(0, 10);
    expect(timeline.getSongTimeMs(8.8)).toBeCloseTo(-1200, 6); // 3-2-1 lead-in
    expect(timeline.getSongTimeMs(10)).toBe(0);
    expect(timeline.getSongTimeMs(12.5)).toBeCloseTo(2500, 6);
    expect(timeline.isRunning(9.9)).toBe(true);
  });

  it('freezes on pause until some context time, then advances', () => {
    const timeline = new PlaybackTimeline();
    timeline.start(0, 0);
    const pausedAt = timeline.getSongTimeMs(30); // 30 s in
    timeline.freeze(pausedAt, 30);

    expect(timeline.getSongTimeMs(30.5)).toBeCloseTo(pausedAt, 6);
    expect(timeline.getSongTimeMs(45)).toBeCloseTo(pausedAt, 6); // long pause: no drift
    expect(timeline.snapshot().mode).toBe('frozen');
    expect(timeline.isRunning(45)).toBe(false);
  });

  it('resumes with a lead-in without jumping or losing time', () => {
    const timeline = new PlaybackTimeline();
    timeline.start(0, 0);
    const pausedAt = timeline.getSongTimeMs(30); // 30000
    timeline.freeze(pausedAt, 30);

    // Audio is scheduled to restart exactly `pausedAt` at context time 31.2.
    timeline.resumeAt(pausedAt, 31.2);
    expect(timeline.getSongTimeMs(30.5)).toBeCloseTo(pausedAt, 6); // still frozen
    expect(timeline.getSongTimeMs(31.0)).toBeCloseTo(pausedAt, 6);
    expect(timeline.isRunning(31.0)).toBe(false);
    expect(timeline.getSongTimeMs(31.2)).toBeCloseTo(pausedAt, 6); // exact handover
    expect(timeline.isRunning(31.2)).toBe(true);
    expect(timeline.getSongTimeMs(31.7)).toBeCloseTo(pausedAt + 500, 6);
    // Total elapsed song time equals the sum of the two playing segments.
    expect(timeline.getSongTimeMs(32)).toBeCloseTo(30_800, 6);
  });

  it('supports pausing again during a pending resume', () => {
    const timeline = new PlaybackTimeline();
    timeline.start(5_000, 0);
    timeline.resumeAt(5_000, 10);
    expect(timeline.getSongTimeMs(9)).toBeCloseTo(5_000, 6);
    timeline.freeze(timeline.getSongTimeMs(9), 9);
    expect(timeline.getSongTimeMs(20)).toBeCloseTo(5_000, 6);
    expect(timeline.isRunning(20)).toBe(false);
  });

  it('resets back to idle', () => {
    const timeline = new PlaybackTimeline();
    timeline.start(1_000, 4);
    timeline.reset();
    expect(timeline.getSongTimeMs(4)).toBe(0);
    expect(timeline.snapshot().mode).toBe('idle');
  });

  it('is a pure function of the context clock (frame-rate independence)', () => {
    const coarse = new PlaybackTimeline();
    const fine = new PlaybackTimeline();
    coarse.start(0, 1);
    fine.start(0, 1);
    // Same instant read at wildly different sampling rates must give the same answer.
    for (const t of [1, 1.016, 1.033, 1.2, 5.5, 30]) {
      expect(coarse.getSongTimeMs(t)).toBeCloseTo(fine.getSongTimeMs(t), 9);
    }
  });
});

describe('highway layout', () => {
  it('places lane centres symmetrically around lane 3', () => {
    expect(laneToX(3)).toBe(0);
    expect(laneToX(0)).toBeCloseTo(-laneToX(6), 9);
    for (let lane = 1; lane < LANE_COUNT; lane += 1) {
      expect(laneToX(lane)).toBeGreaterThan(laneToX(lane - 1));
    }
  });

  it('maps time to z linearly with the hit line at z = 0', () => {
    const leadMs = leadMsForSpeed(1);
    expect(zForTimeToHit(0, leadMs)).toBeCloseTo(0, 9);
    expect(zForTimeToHit(leadMs, leadMs)).toBeCloseTo(-ROAD_LENGTH, 9);
    expect(zForTimeToHit(leadMs / 2, leadMs)).toBeCloseTo(-ROAD_LENGTH / 2, 9);
    expect(zForTimeToHit(-leadMs, leadMs)).toBeCloseTo(ROAD_LENGTH, 9);
  });

  it('inverts cleanly (used by the editor preview in phase 4)', () => {
    const leadMs = 1500;
    for (const z of [-20, -12.5, -1, 0, 5]) {
      expect(timeToHitForZ(zForTimeToHit(z, leadMs), leadMs)).toBeCloseTo(z, 9);
    }
  });

  it('shortens the visual lead as speed rises and clamps out-of-range speeds', () => {
    expect(leadMsForSpeed(1)).toBe(BASE_LEAD_MS);
    expect(leadMsForSpeed(2)).toBe(BASE_LEAD_MS / 2);
    expect(leadMsForSpeed(0.5)).toBe(BASE_LEAD_MS * 2);
    expect(leadMsForSpeed(100)).toBe(BASE_LEAD_MS / 2.5);
    expect(clampNoteSpeed(Number.NaN)).toBe(1);
    expect(leadMsForSpeed(0)).toBe(BASE_LEAD_MS / 0.5);
  });

  it('converts hold durations into world lengths', () => {
    const leadMs = leadMsForSpeed(1);
    expect(holdLengthForDuration(leadMs, leadMs)).toBeCloseTo(ROAD_LENGTH, 9);
    expect(holdLengthForDuration(0, leadMs)).toBe(0);
    expect(holdLengthForDuration(900, leadMs)).toBeCloseTo((900 / leadMs) * ROAD_LENGTH, 9);
  });
});
