/**
 * The analysis fixture the seven-key parity test is built on.
 *
 * It is deliberately *the real analyser* run on a synthetic drum track, not a hand-built
 * `AnalysisSummary`: parity with the phase 2.1 generator has to hold for the notes a player would
 * actually get, and using the analyser means the fixture exercises the same beat grid, onsets and
 * energy profile the import workflow produces. The analyser is a pure function of the samples, so
 * the fixture is reproducible, and a drum track gives the generator plenty to work with (a kick on
 * every beat, a hat off-beat, a clap on the bar).
 *
 * `frontend/scripts/emit-baseline-fixture.mts` runs this same helper inside a checkout of the
 * `v0.2.1` tag to write `tests/fixtures/hard-v0.2.1.json`, which the parity test compares against.
 */

import { analyzeSong } from '../../src/analysis/MusicAnalyzer';
import type { AnalysisSummary } from '../../src/analysis/types';
import { drumTrack, RATE } from './synth';

/** Long enough for the lane-coverage pass (which needs ≥ 24 notes) to run. */
export const FIXTURE_DURATION_MS = 20_000;
export const FIXTURE_BPM = 120;
/** One fixed seed, so both generators are asked for the same chart. */
export const FIXTURE_SEED = 1234;
export const FIXTURE_SONG = {
  songId: 'baseline-fixture',
  title: 'Baseline Fixture',
  durationMs: FIXTURE_DURATION_MS,
} as const;

export function fixtureAnalysis(): AnalysisSummary {
  const samples = drumTrack({ durationMs: FIXTURE_DURATION_MS, bpm: FIXTURE_BPM });
  return analyzeSong({ channels: [samples], sampleRate: RATE });
}
