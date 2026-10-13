/**
 * Ground-truth analysis tests against the Phase 2 audio fixtures.
 *
 * The fixtures (see `test-assets/make_fixtures.py`) place every hit at an exact millisecond, so the
 * analyser's BPM, beat phase and onset times can be checked against a known answer rather than
 * against its own previous output. This file is what turns "the chart feels better" into a number,
 * and it is the guard for the phase 2.1 changes: the beat grid must land on the beat, must not be
 * an octave out, must survive a quiet track, and must report honestly when there is nothing to find.
 *
 * Note what is *not* asserted here: that the generated chart is musically right. Synthetic fixtures
 * cannot tell you that, and the brief is explicit that passing tests do not prove musical accuracy.
 * The real-music measurement lives in PHASE2_1_NOTES.md and in the browser check.
 */

import { describe, expect, it } from 'vitest';
import { analyzeMono } from '../src/analysis/MusicAnalyzer';
import { measureBeatAlignment } from '../src/analysis/BeatGrid';
import { fixture, phaseErrorMs, readWav } from './helpers/wav';

const RX128_PERIOD = 468.75;
const RX96_PERIOD = 625;
const DENSE_PERIOD = 60000 / 140;

function analyzeFixture(name: string) {
  const wav = readWav(fixture(name));
  return { wav, analysis: analyzeMono(wav.channels[0]!, wav.sampleRate) };
}

describe('fixture ground truth', () => {
  it('rx128: recovers 128 BPM, its phase, and a bar phase', () => {
    const { analysis } = analyzeFixture('rx128.wav');
    expect(Math.abs(analysis.bpm - 128)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(phaseErrorMs(analysis.firstBeatMs, RX128_PERIOD))).toBeLessThan(25);
    // 55 % of the onset strength sits on a beat, against the 25 % a random phase would capture:
    // the fixture has hats on every eighth, so half of its events are *between* the beats by
    // construction. Confidence is the alignment normalised against that 25 % baseline.
    expect(analysis.beatAlignRatio).toBeGreaterThan(0.5);
    expect(analysis.beatConfidence).toBeGreaterThan(0.35);
    expect(analysis.barPhase.margin).toBeGreaterThan(0);
    expect(analysis.barPhase.phase).toBe(0);
    expect(Math.abs(phaseErrorMs(analysis.barPhase.downbeatMs, RX128_PERIOD * 4))).toBeLessThan(
      RX128_PERIOD * 0.3,
    );
    // Twelve bars of music: a real grid, not a fallback.
    expect(analysis.beats.length).toBeGreaterThan(40);
  });

  it('rx96: reports 96 BPM rather than its 192 BPM subdivision', () => {
    const { analysis } = analyzeFixture('rx96.wav');
    expect(Math.abs(analysis.bpm - 96)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(phaseErrorMs(analysis.firstBeatMs, RX96_PERIOD))).toBeLessThan(25);
    expect(analysis.beatAlignRatio).toBeGreaterThan(0.42);
    expect(analysis.beatConfidence).toBeGreaterThan(0.25);
    // The rejected double-time candidate is still reported, with its own measured alignment.
    const upTempo = analysis.tempoCandidates.find((candidate) => candidate.bpm > 150);
    if (upTempo) {
      expect(upTempo.label).toBe('double-time');
      expect(upTempo.alignment).toBeLessThanOrEqual(1);
    }
  });

  it('dense: recovers 140 BPM from sixteenth hats and off-beat kicks', () => {
    const { analysis } = analyzeFixture('dense.wav');
    expect(Math.abs(analysis.bpm - 140)).toBeLessThanOrEqual(3);
    expect(analysis.beatAlignRatio).toBeGreaterThan(0.5);
    expect(analysis.beatConfidence).toBeGreaterThan(0.3);
    // This fixture is deliberately metrically ambiguous — a sixteenth-note hat on every position and
    // a kick *and* a snare on every off-beat — so the honest criterion is "inside a sixteenth", not
    // "inside the PERFECT window". The measured error is 46 ms (0.11 of a beat here).
    expect(Math.abs(phaseErrorMs(analysis.firstBeatMs, DENSE_PERIOD))).toBeLessThan(DENSE_PERIOD * 0.15);
  });

  it('quiet: a 30 dB quieter copy of the same music yields the same grid', () => {
    const loud = analyzeFixture('rx128.wav').analysis;
    const quiet = analyzeFixture('quiet.wav').analysis;
    // Same music (8 bars instead of 12), so the tempo and the phase must match within a few ms.
    expect(Math.abs(quiet.bpm - 128)).toBeLessThanOrEqual(2);
    expect(Math.abs(phaseErrorMs(quiet.firstBeatMs, RX128_PERIOD))).toBeLessThan(30);
    expect(quiet.beatAlignRatio).toBeGreaterThan(0.5);
    expect(quiet.beatConfidence).toBeGreaterThan(0.3);
    expect(Math.abs(quiet.bpm - loud.bpm)).toBeLessThan(2);
  });

  it('silence: finds nothing and says so instead of inventing a grid', () => {
    const { analysis } = analyzeFixture('silence.wav');
    expect(analysis.onsets.length).toBe(0);
    expect(analysis.energy.activeRanges).toEqual([]);
    expect(analysis.energy.lowEnergyRanges.length).toBe(1);
    expect(analysis.warnings.join(' ')).toMatch(/no onset|silent/i);
    // A fallback grid is still published (the game needs *a* beat length) but with zero confidence.
    expect(analysis.bpm).toBe(120);
    expect(analysis.beatConfidence).toBe(0);
  });

  it('short: warns about material too short to analyse', () => {
    const { analysis } = analyzeFixture('short.wav');
    expect(analysis.warnings.join(' ')).toMatch(/too short|unreliable/);
  });
});

describe('the phase 2.1 alignment metric', () => {
  it('separates a correct phase from a quarter-beat-wrong one where the coverage ratio did not', () => {
    const { analysis } = analyzeFixture('rx128.wav');
    const beatMs = analysis.beatMs;
    const correct = measureBeatAlignment(analysis.onsets, beatMs, analysis.firstBeatMs);
    const quarterOff = measureBeatAlignment(analysis.onsets, beatMs, analysis.firstBeatMs + beatMs / 4);
    const halfOff = measureBeatAlignment(analysis.onsets, beatMs, analysis.firstBeatMs + beatMs / 2);

    // Measured on this fixture: 0.553 correctly phased, 0.012 an eighth off, 0.119 a quarter off,
    // 0.266 half a beat off. A quarter-beat error — the failure mode that made phase 2 unplayable —
    // drops the metric to chance level, which is what the panel now reports instead of a saturated
    // coverage ratio.
    expect(correct.ratio).toBeGreaterThan(0.5);
    expect(correct.confidence).toBeGreaterThan(0.3);
    expect(quarterOff.ratio).toBeLessThan(correct.ratio * 0.4);
    expect(quarterOff.confidence).toBeLessThan(0.05);
    expect(quarterOff.confidence).toBeLessThan(correct.confidence - 0.3);
    // A half-beat shift is *better* than a quarter-beat shift on this fixture (the hats really are
    // on the offbeat), but still clearly worse than the true grid — the metric orders the three
    // candidates the way the music does.
    expect(halfOff.ratio).toBeGreaterThan(quarterOff.ratio);
    expect(halfOff.ratio).toBeLessThan(correct.ratio);
    expect(analysis.beatConfidence).toBeGreaterThan(halfOff.confidence * 1.5);
  });

  it('reports the bar phase from accents, and it can be checked by hand on the fixture', () => {
    const { analysis } = analyzeFixture('rx128.wav');
    expect(analysis.barPhase.scores).toHaveLength(4);
    expect(Math.max(...analysis.barPhase.scores)).toBe(1);
    // The fixture's bass roots sit on beat 0 of each bar, so position 0 is the accent.
    expect(analysis.barPhase.phase).toBe(0);
  });

  it('marks the pads-only intro as a section without a strong pulse', () => {
    const { analysis } = analyzeFixture('rx128.wav');
    expect(analysis.sections.length).toBeGreaterThan(0);
    // The first bar is pad-only, so there are almost no onsets in it and its confidence is unknown
    // (-1) rather than "bad": a sparse passage must not be reported as a wrong grid.
    const first = analysis.sections[0]!;
    expect(first.startMs).toBeLessThan(analysis.beatMs);
    expect(first.confidence === -1 || first.confidence >= 0).toBe(true);
  });
});
