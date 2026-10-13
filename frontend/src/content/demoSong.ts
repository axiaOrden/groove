/**
 * "Neon Circuit" — the built-in Phase 1 demo song.
 *
 * Original content: the audio is synthesised at runtime in the browser by
 * `src/audio/DemoSynth.ts` and the chart is hand-authored here. No third-party music,
 * artwork or O2Jam asset is bundled with this project.
 *
 * One definition drives both halves so the fixed demo chart can never drift out of sync
 * with the fixed demo audio:
 *   - `drums` / `bass` / `lead` / `pad` describe what the synthesised track plays.
 *   - `chart` holds one hand-written 16-step note pattern per bar (see PatternParser.ts).
 *
 * Tempo: 150 BPM, 4/4  ->  one beat = 400 ms, one bar = 1600 ms, one 16th step = 100 ms.
 */

export type SectionId = 'intro' | 'verse' | 'chorus' | 'bridge' | 'outro';

export interface DrumPattern {
  /** 8-step grid (eighth notes) over one bar. 'K' = kick, '.' = rest. */
  kick: string;
  /** 8-step grid. 'S' = snare. */
  snare: string;
  /** 8-step grid. 'h' = closed hat, 'H' = accent hat. */
  hat: string;
}

export interface SectionSpec {
  id: SectionId;
  label: string;
  drums: DrumPattern;
  /**
   * 8-step bass figure for one bar. 'R' = chord root, '5' = fifth above the root,
   * '.' = rest. Notes are short plucks except where `pad` is set.
   */
  bass: string;
  /** When true the section holds a sustained triad pad under each bar. */
  pad: boolean;
  /** 16-step melody in scale degrees 1..8 relative to the bar's chord root; null = silence. */
  lead: string | null;
  /** Hand-authored chart: exactly one 16-step pattern string per bar of the section. */
  chart: string[];
}

export const DEMO_BPM = 150;
export const DEMO_BEATS_PER_BAR = 4;
export const DEMO_BEAT_MS = 60_000 / DEMO_BPM; // 400
export const DEMO_BAR_MS = DEMO_BEAT_MS * DEMO_BEATS_PER_BAR; // 1600
export const DEMO_CHART_STEPS = 16;
export const DEMO_DRUM_STEPS = 8;
export const DEMO_LEAD_STEPS = 16;

export const DEMO_SONG_ID = 'seven-keys-neon-circuit';
export const DEMO_TITLE = 'Neon Circuit';
export const DEMO_ARTIST = 'Seven Keys built-in synth (original, generated at runtime)';
export const DEMO_CHARTER = 'Seven Keys hand-authored demo patterns';

/** Two bars per chord: Am - F - C - G (i - VI - III - VII in A minor). */
export const DEMO_ROOT_NAMES = ['A2', 'F2', 'C3', 'G2'] as const;
export const DEMO_ROOT_HZ = [110.0, 87.307057858, 130.81278265, 97.998858995] as const;
/** Semitone offsets of a natural-minor scale, used to map melody degrees 1..8. */
export const DEMO_SCALE_SEMITONES = [0, 2, 3, 5, 7, 8, 10, 12] as const;
/** Melody is written two octaves above the bass root (A2 root -> A4 lead). */
export const DEMO_LEAD_OCTAVE = 4;

const DRUMS = {
  intro: { kick: 'K...K...', snare: '........', hat: 'h.h.h.h.' },
  verse: { kick: 'K...K...', snare: '..S...S.', hat: 'h.h.h.h.' },
  chorus: { kick: 'K...K...', snare: '..S...S.', hat: 'hhhhhhhh' },
  bridge: { kick: 'K.......', snare: '....S...', hat: '........' },
  outro: { kick: 'K...K...', snare: '..S...S.', hat: 'h.h.h.h.' },
} satisfies Record<SectionId, DrumPattern>;

export const SECTIONS: Record<SectionId, SectionSpec> = {
  intro: {
    id: 'intro',
    label: 'Intro',
    drums: DRUMS.intro,
    bass: 'R.......',
    pad: false,
    lead: '. . 5 . . 4 . 3 . . 2 . . 1 . .',
    chart: [
      '0 . . . 2 . . . 4 . . . 6 . . .',
      '1 . . . 3 . . . 5 . . . 3 . . .',
      '0 . . . 2 . . . 4 . . . 6 . . .',
      '5 . . . 3 . . . 1 . . . 0~3 . . .',
    ],
  },
  verse: {
    id: 'verse',
    label: 'Verse',
    drums: DRUMS.verse,
    bass: 'R.R.R.R.',
    pad: false,
    lead: '1 . 3 . 5 . 3 . 4 . 5 . 6 . 5 .',
    chart: [
      '0 . 2 . 4 . 2 . 5 . 4 . 2 . 0 .',
      '1 . 3 . 5 . 3 . 6 . 5 . 3 . 1 .',
      '0 . 4 . 2 . 5 . 0 . 4 . 2 . 5 .',
      '1 . 3 . 1 . 3 . 5 . 6 . 5~4 . . .',
      '0 . 2 . 4 . 2 . 5 . 4 . 2 . 0 .',
      '6 . 5 . 3 . 1 . 3 . 5 . 6~4 . . .',
      '0 1 . 2 3 . 4 5 . 6 . 3 . 0 . .',
      '6 . 5 . 4 . 3 . 2 . 1 . 0~3 . . .',
    ],
  },
  chorus: {
    id: 'chorus',
    label: 'Chorus',
    drums: DRUMS.chorus,
    bass: 'RRRRRRRR',
    pad: false,
    lead: '1 . 5 . 8 . 5 . 6 . 5 . 4 . 3 .',
    chart: [
      '0 . 2 . 4 . 5 . 6 . 5 . 4 . 2 .',
      '1 . 3 . 5 . 6 . 5 . 3 . 1 . 0 .',
      '0 1 . 2 3 . 4 5 . 6 . 5 . 3 . .',
      '0~8 . . . . . . . 4 . 5 . 4 . 5 .',
      '1 . 3 . 5 . 3 . 6 . 5 . 4 . 2 .',
      '0 2 . 4 6 . 5 3 . 1 . 3 . 5 . .',
      '0+3 . . . . . 2+5 . 3+6 . . . . . 1+4 .',
      '0 . 2 . 4 . 6 . 5 . 4 . 2~4 . . .',
    ],
  },
  bridge: {
    id: 'bridge',
    label: 'Bridge',
    drums: DRUMS.bridge,
    bass: 'R.......',
    pad: true,
    lead: '1 . . . . . . . 5 . . . . . . .',
    chart: [
      '0+3 . . . . . . . 2+5 . . . . . . .',
      '1+4 . . . . . . . 3+6 . . . . . . .',
      '0~8 . . . . . . . 4 . 5 . . . . .',
      '3~8 . . . . . . . . . 6 . . . . .',
    ],
  },
  outro: {
    id: 'outro',
    label: 'Outro',
    drums: DRUMS.outro,
    bass: 'R.R.R.R.',
    pad: false,
    lead: '8 . 7 . 6 . 5 . 4 . 3 . 2 . 1 .',
    chart: [
      '6 . 5 . 4 . 3 . 2 . 1 . 0 . . .',
      '0 . 2 . 4 . . . 6~4 . . . . . . .',
      '. . . . . . . . 0~8 . . . . . . .',
      '. . . . . . . . . . . . 3 4 5 6',
    ],
  },
};

/** 4 + 8 + 8 + 4 + 8 + 4 = 36 bars (57.6 s). */
export const DEMO_ARRANGEMENT: readonly SectionId[] = [
  'intro',
  'verse',
  'chorus',
  'bridge',
  'chorus',
  'outro',
];

export interface DemoBar {
  barIndex: number;
  sectionId: SectionId;
  sectionLabel: string;
  barInSection: number;
  /** Chart step 0 of this bar, in ms from song start. */
  startMs: number;
}

/** Flatten the arrangement into a per-bar timeline used by both the synth and the chart. */
export function demoBars(): DemoBar[] {
  const bars: DemoBar[] = [];
  let barIndex = 0;
  for (const sectionId of DEMO_ARRANGEMENT) {
    const section = SECTIONS[sectionId];
    section.chart.forEach((_pattern, barInSection) => {
      bars.push({
        barIndex,
        sectionId,
        sectionLabel: section.label,
        barInSection,
        startMs: barIndex * DEMO_BAR_MS,
      });
      barIndex += 1;
    });
  }
  return bars;
}

export function demoBarCount(): number {
  return DEMO_ARRANGEMENT.reduce((total, id) => total + SECTIONS[id].chart.length, 0);
}

/** Musical length of the demo (chart time of the final bar end), in ms. */
export function demoSongDurationMs(): number {
  return demoBarCount() * DEMO_BAR_MS;
}

/** Chord root for a bar (the progression repeats every four bars). */
export function demoRootHz(barIndex: number): number {
  return DEMO_ROOT_HZ[barIndex % DEMO_ROOT_HZ.length]!;
}

/** Scale degree 1..8 -> frequency, using the bar's chord root. */
export function demoDegreeHz(barIndex: number, degree: number): number {
  const semitones = DEMO_SCALE_SEMITONES[Math.min(7, Math.max(0, degree - 1))]!;
  return demoRootHz(barIndex) * 2 ** (semitones / 12) * DEMO_LEAD_OCTAVE;
}

/** Fifth above the bar root, one octave down from the lead register. */
export function demoFifthHz(barIndex: number, octave = 2): number {
  return demoRootHz(barIndex) * 2 ** (7 / 12) * octave;
}
