/**
 * Builds the fixed Phase 1 demo beatmap from the hand-authored bar patterns in
 * src/content/demoSong.ts.
 *
 * This is deliberately *not* automatic chart generation: every note comes from a pattern a
 * human wrote in a checked-in source file (see the "First milestone" section of README.md —
 * audio analysis starts in phase 3). The expansion step only converts the compact step grid
 * into the ms/lane/type schema.
 */

import type { Beatmap, ChartNote } from './ChartTypes';
import { BEATMAP_SCHEMA_VERSION, LANE_COUNT, sortNotes } from './ChartTypes';
import { DIFFICULTY_PROFILES, keyLabelsFor } from './Difficulty';
import { maxTheoreticalScoreOf } from './ScoreModel';
import { ChartPatternError, assertUniformStepCount, parseBarPattern } from './PatternParser';
import {
  DEMO_BAR_MS,
  DEMO_BPM,
  DEMO_CHART_STEPS,
  DEMO_CHARTER,
  DEMO_TITLE,
  DEMO_ARTIST,
  DEMO_SONG_ID,
  SECTIONS,
  demoBarCount,
  demoBars,
  demoSongDurationMs,
} from '../content/demoSong';

export const DEMO_GENERATOR = {
  name: 'seven-keys-hand-authored-demo',
  version: '1.0.0',
  seed: 0,
} as const;

/**
 * Expand the authored patterns into explicit notes. Throws `ChartPatternError` when a bar
 * declares the wrong number of steps, so an authoring typo fails loudly in tests and at boot
 * instead of silently shifting the groove.
 */
export function buildDemoNotes(): ChartNote[] {
  const notes: ChartNote[] = [];

  for (const bar of demoBars()) {
    const section = SECTIONS[bar.sectionId];
    const pattern = section.chart[bar.barInSection];
    if (pattern === undefined) {
      throw new ChartPatternError(`section ${bar.sectionId} has no pattern for bar ${bar.barInSection}`, bar.barIndex);
    }
    assertUniformStepCount([pattern], DEMO_CHART_STEPS, bar.barIndex);
    notes.push(
      ...parseBarPattern({
        pattern,
        barStartMs: bar.startMs,
        barDurationMs: DEMO_BAR_MS,
      }),
    );
  }

  return sortNotes(notes);
}

/**
 * The fixed Phase 1 beatmap. `offsetMs` is 0: the synthesised track starts exactly at 0.
 *
 * `difficulty` is `hard` since phase 3: the demo is the seven-key layout (A S D SPACE J K L), which
 * is what Hard means, so its scores carry Hard's ×2.0 weight. Nothing else about it changed, and the
 * other two difficulties are absent rather than faked — the demo has no analysis to generate them
 * from (see `ui/GameApp.ts`).
 */
export function buildDemoChart(): Beatmap {
  const notes = buildDemoNotes();
  return {
    schemaVersion: BEATMAP_SCHEMA_VERSION,
    songId: DEMO_SONG_ID,
    title: DEMO_TITLE,
    artist: DEMO_ARTIST,
    charter: DEMO_CHARTER,
    difficulty: 'hard',
    laneCount: LANE_COUNT,
    keyLabels: keyLabelsFor(LANE_COUNT),
    bpm: DEMO_BPM,
    offsetMs: 0,
    generator: { ...DEMO_GENERATOR },
    durationMs: demoSongDurationMs(),
    maxScore: maxTheoreticalScoreOf(notes, DIFFICULTY_PROFILES.hard.scoreWeight),
    notes,
  };
}

/** Chart time of the end of the last note, in ms. */
export function demoChartEndMs(chart: Beatmap = buildDemoChart()): number {
  return chart.notes.reduce((max, note) => {
    const end = note.type === 'hold' ? note.timeMs + (note.durationMs ?? 0) : note.timeMs;
    return Math.max(max, end);
  }, 0);
}

export const DEMO_BAR_COUNT = demoBarCount();
