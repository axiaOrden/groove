/**
 * Automatic chart generation: analysis in, a validated seven-lane beatmap out.
 *
 * The design goal is the phrase from the brief: **a playable chart is not random lanes on every
 * beat.** The pipeline below turns the analysis into notes in five documented stages, and every
 * stage is deterministic — the same analysis and the same settings always produce the same chart,
 * which is what makes it testable and what lets a saved song reopen to the identical map.
 *
 *   1. **Slots.** The beat grid is subdivided according to local musical intensity: 1 slot per beat
 *      in a sparse breakdown, 2 in a normal section, 4 in a busy chorus. A slot's *weight* starts
 *      from its metric position (downbeats are stronger than off-beats) and from the beat's
 *      loudness. This is the phrasing skeleton: notes land on musical positions, not everywhere.
 *   2. **Onset alignment.** Detected onsets are matched to the nearest slot within a tolerance and
 *      *reinforce* it (raising its weight and nudging it up to `maxNudgeMs` towards the real attack,
 *      so a slightly-off beat grid does not smear every note). Sound with no matching slot — a
 *      syncopated stab — becomes its own candidate when it is strong enough.
 *   3. **Selection.** Candidates are kept in time order while a rolling one-second density budget
 *      (derived from onsets-per-second and intensity) allows, discarding weak slots in busy music
 *      and thin slots in quiet music. Nothing is placed in a low-energy range.
 *   4. **Chords and holds.** Chords are rare and only on genuine accents (strong onset on a
 *      downbeat, loud section, chord budget not spent and no chord recently). Holds are only made
 *      where a sustain is *reliably* implied: a downbeat, a loud section, and no further event in
 *      that lane for at least two beats.
 *   5. **Lanes.** Alternating hands for consecutive notes, band-aware placement (bass left, lead
 *      right, snare/vocal centre), never the same lane twice in a row, and a per-lane minimum gap.
 *      The lane walk is the part that turns a note list into something that feels like a pattern.
 *
 * Everything the generator decides is counted in `ChartStats`, which the diagnostics panel and the
 * tests use — including *why* candidates were dropped, because "the chart is sparse" is otherwise
 * impossible to diagnose.
 *
 * ---------------------------------------------------------------------------------------------- --
 * Phase 2.1 — role-aware lanes, and notes that land on events rather than on the grid
 *
 * On a real song (Kenshi Yonezu — IRIS OUT) the phase-2 generator produced a playable chart whose
 * notes still did not consistently correspond to the music. Two causes, both fixed here:
 *
 *  1. **Grid slots competed with real events on equal terms.** A slot could be charted because the
 *     tempo grid said "there is a beat here" even when nothing was happening in the music. Grid-only
 *     slots are now weighted by the measured confidence of the grid itself (`beatConfidence`, see
 *     `analysis/BeatGrid.ts`), and are not created at all inside the sections the analyser marked as
 *     having a weak pulse. Where the grid is trustworthy the chart keeps a steady pulse; where it is
 *     not, the onsets decide.
 *  2. **Lanes were chosen by register alone.** Band-aware placement put bass left and lead right,
 *     which is right as far as it goes, but it left SPACE — the key a player reads as "the beat" —
 *     with whatever happened to walk into the middle lane. Every candidate now carries a **role**
 *     derived from measurable features (its position relative to the grid, its spectral band and its
 *     strength), and each role has a lane pool:
 *
 *         role            lane(s)          what it is on the track
 *         --------------- ---------------- -------------------------------------------
 *         downbeat        SPACE (3)        the accented beat of the bar
 *         kick            SPACE (3)        a loud low/broad attack on a beat
 *         low             A (0)            low percussion off the accents
 *         high            L (6)            high percussion off the accents
 *         supporting      S (1) / K (5)    on-beat events without a strong low end
 *         melodic         D (2) / J (4)    mid/high events away from the beat
 *         syncopation     D (2) / J (4)    an onset that falls between the beats
 *         beat            S/K/D/J/A/L      a grid beat with no onset on it
 *
 *     SPACE therefore means something: it is reserved for downbeats and kick-like accents, capped at
 *     `maxSpaceRatio` of the chart, and never used twice in a row.
 *
 * **The roles are heuristics, not instrument recognition.** No source separation or classifier runs
 * here; "kick" means "a strong low-frequency attack on a beat", which is usually a kick drum and
 * occasionally a bass note or a low tom, and "melodic" means "a mid/high event away from the beat",
 * which is a lead stab, a vocal chop or a snare ghost note depending on the track. What the mapping
 * does guarantee is that the *shape* of the music is preserved: accents go to the centre key,
 * register spreads left to right, and syncopation goes to the inner keys.
 */

import type { Beatmap, ChartNote, NoteType } from './ChartTypes';
import { BEATMAP_SCHEMA_VERSION, LANE_COUNT, sortNotes } from './ChartTypes';
import { validateBeatmap, type ValidationResult } from './ChartValidator';
import type { AnalysisSummary, EnergyProfile, OnsetBand, OnsetEvent, TimeRange } from '../analysis/types';
import { intensityAtBeat } from '../analysis/types';
import { BEATS_PER_BAR, beatToleranceMs, signedOffsetMs } from '../analysis/BeatGrid';

export const GENERATOR_NAME = 'seven-keys-analysis-v1';
export const GENERATOR_VERSION = '1.0.0';

export interface GenerateOptions {
  /** Seed for every random decision. Same seed + same analysis ⇒ same chart. */
  seed: number;
  songId: string;
  title: string;
  artist?: string;
  charter?: string;
  durationMs?: number;
  /** Target density at full intensity, notes per second. Normal is ~3.2. */
  targetNotesPerSecond?: number;
  /** Hard ceiling on notes in any one-second window. */
  maxNotesPerSecond?: number;
  /** Minimum distance between any two notes, in ms. Below this is not comfortably playable. */
  minNoteGapMs?: number;
  /** Minimum distance between two notes *in the same lane*, in ms. */
  minLaneGapMs?: number;
  /** Maximum fraction of notes that may be chords (two simultaneous notes). */
  maxChordRatio?: number;
  /** Maximum fraction of notes that may be holds. */
  maxHoldRatio?: number;
  /**
   * Maximum fraction of notes that may sit on SPACE. SPACE marks the primary beat, so if it carried
   * every beat the key would stop meaning "this one matters".
   */
  maxSpaceRatio?: number;
  /** Notes closer than this to a detected onset are considered aligned with it (metrics only). */
  alignToleranceMs?: number;
}

export interface ChartStats {
  noteCount: number;
  tapCount: number;
  holdCount: number;
  chordCount: number;
  holdRatio: number;
  chordRatio: number;
  notesPerSecond: number;
  peakNotesPerSecond: number;
  chartDurationMs: number;
  firstNoteMs: number;
  lastNoteEndMs: number;
  laneUsage: number[];
  lanesUsed: number;
  /** How many notes sit within `alignToleranceMs` of a detected onset or a beat. */
  onOnset: number;
  onBeat: number;
  onsetAlignRatio: number;
  beatAlignRatio: number;
  candidatesConsidered: number;
  droppedByDensity: number;
  droppedBySilence: number;
  droppedBySpacing: number;
  droppedByLaneGap: number;
  droppedByLaneExhausted: number;
  longGapCount: number;
  maxGapMs: number;
  meanGapMs: number;
  sectionsSkipped: number;
  /** Notes on the SPACE lane, and their share of the chart (phase 2.1 role mapping). */
  spaceCount: number;
  spaceRatio: number;
  /** How many notes each role produced, so the mapping can be checked rather than trusted. */
  roleCounts: Record<CandidateRole, number>;
  /** Notes that came from a beat-grid slot with no onset reinforcing it (the grid's own claims). */
  gridOnlyNotes: number;
  /** Notes inside a section the analyser flagged as having a weak pulse. */
  lowConfidenceNotes: number;
}

/** Why candidates did not become notes. Kept separate from `ChartStats` so the pipeline stages
 * can increment a counter object without pretending to be a complete report. */
export interface DropCounters {
  droppedByDensity: number;
  droppedBySilence: number;
  droppedBySpacing: number;
  droppedByLaneGap: number;
  droppedByLaneExhausted: number;
}

export interface GenerationResult {
  chart: Beatmap;
  stats: ChartStats;
  validation: ValidationResult;
  warnings: string[];
}

const DEFAULTS: Required<Omit<GenerateOptions, 'songId' | 'title' | 'artist' | 'charter' | 'durationMs'>> = {
  seed: 1,
  targetNotesPerSecond: 3.2,
  maxNotesPerSecond: 9,
  minNoteGapMs: 90,
  minLaneGapMs: 150,
  maxChordRatio: 0.12,
  maxHoldRatio: 0.15,
  maxSpaceRatio: 0.34,
  alignToleranceMs: 60,
};

/**
 * Lanes a band's energy is allowed to land in, used as the fallback when a role's own pool is
 * blocked: bass left, snare/vocal centre, lead right. A broadband hit is allowed anywhere, which is
 * also how a bass-only track still reaches the right-hand lanes over a longer chart.
 */
const BAND_LANES: Record<OnsetBand, readonly number[]> = {
  low: [0, 1, 2],
  mid: [2, 3, 4],
  high: [4, 5, 6],
  broad: [0, 1, 2, 3, 4, 5, 6],
};

const LEFT_HAND = [0, 1, 2];
const RIGHT_HAND = [4, 5, 6];
const CENTER = 3;

/**
 * What a detected event *is*, as far as measurable features can say. See the file header: these are
 * heuristics, not instrument recognition.
 */
export type CandidateRole =
  | 'downbeat'
  | 'kick'
  | 'low'
  | 'high'
  | 'supporting'
  | 'melodic'
  | 'syncopation'
  | 'beat';

/**
 * The lane each role belongs to, in preference order.
 *
 * The first entry is the *meaning* of the role (SPACE for the accented beat, A for low percussion,
 * …); the rest is a fallback ladder used when the first lane is still inside its minimum gap. The
 * ladders deliberately start on the opposite hand for percussion (a low hit that cannot use A falls
 * to the middle rather than to the far right), so a chart does not jump across the keyboard.
 */
const ROLE_LANES: Record<CandidateRole, readonly number[]> = {
  downbeat: [3, 2, 4, 1, 5, 0, 6],
  kick: [3, 2, 4, 0, 6, 1, 5],
  low: [0, 1, 2, 3, 4, 5, 6],
  high: [6, 5, 4, 3, 2, 1, 0],
  supporting: [1, 5, 2, 4, 0, 6, 3],
  melodic: [2, 4, 1, 5, 0, 6, 3],
  syncopation: [4, 2, 5, 1, 6, 0, 3],
  // A grid beat with nothing happening on it is a weak claim: it prefers the supporting keys and
  // never claims SPACE, which is reserved for accents.
  beat: [1, 5, 2, 4, 0, 6],
};

const EMPTY_ROLE_COUNTS: Record<CandidateRole, number> = {
  downbeat: 0,
  kick: 0,
  low: 0,
  high: 0,
  supporting: 0,
  melodic: 0,
  syncopation: 0,
  beat: 0,
};

/** Deterministic PRNG (mulberry32). Small, fast and reproducible across engines. */
export function seededRandom(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Candidate {
  timeMs: number;
  /** Selection priority: metric accent × loudness × onset reinforcement × grid trust. */
  weight: number;
  /** True when a strong onset reinforced this slot. */
  fromOnset: boolean;
  strength: number;
  band: OnsetBand | null;
  /** Beat index in the grid, for hold/chord decisions; -1 for pure onset candidates. */
  beatIndex: number;
  barAccent: boolean;
  /** Role used for lane assignment (phase 2.1). */
  role: CandidateRole;
  /** Position in the bar (0 = downbeat) when the candidate sits on the grid, else -1. */
  beatPos: number;
  /** True when the candidate was created by the grid with no onset supporting it. */
  gridOnly: boolean;
  /** True inside a section the analyser flagged as having a weak pulse. */
  inWeakSection: boolean;
}

export function generateChart(analysis: AnalysisSummary, options: GenerateOptions): GenerationResult {
  if (!Number.isFinite(analysis.bpm) || analysis.bpm <= 0) {
    throw new Error('analysis has no usable tempo; cannot generate a chart');
  }
  if (!Number.isFinite(analysis.beatMs) || analysis.beatMs <= 0) {
    throw new Error('analysis has no usable beat grid; cannot generate a chart');
  }
  const settings = { ...DEFAULTS, ...options };
  const random = seededRandom(settings.seed);
  const warnings: string[] = [];
  const drop: DropCounters = {
    droppedByDensity: 0,
    droppedBySilence: 0,
    droppedBySpacing: 0,
    droppedByLaneGap: 0,
    droppedByLaneExhausted: 0,
  };

  const candidates = buildCandidates(analysis, settings, drop);
  const selected = selectCandidates(candidates, analysis, settings, drop, warnings);
  const { notes, stats: laneStats } = assignLanes(selected, analysis, settings, random, drop, warnings);

  const chart = buildBeatmap(notes, analysis, settings);
  const validation = validateBeatmap(chart, { maxNotesPerSecond: settings.maxNotesPerSecond });
  if (!validation.ok) {
    warnings.push(`generated chart failed validation: ${validation.errors.map((e) => e.code).join(', ')}`);
  }

  const stats = summarize(chart, analysis, settings, laneStats, drop);
  return { chart, stats, validation, warnings };
}

// ------------------------------------------------------------------------------- stage 1 + 2 ---

// --------------------------------------------------------------- grid context (phase 2.1) ---

/**
 * Everything the candidate builder and the lane chooser need to ask about the beat grid, computed
 * once. Keeping it in one object is what stops the same three questions (which beat is this, is it
 * on the beat, is the pulse trustworthy here) from being answered slightly differently in three
 * places — which is how the phase-2 chart ended up with notes on grid positions that nothing in the
 * music supported.
 */
interface GridContext {
  beatMs: number;
  firstBeatMs: number;
  beatsPerBar: number;
  /** Which position in the bar is the downbeat (from the accent analysis, see BeatGrid.ts). */
  barPhase: number;
  /** How far from a beat an onset may sit and still count as being on it. */
  toleranceMs: number;
  /** 0..1 trust in the grid: drives how many grid-only slots are allowed to exist at all. */
  trust: number;
  /** Sections the analyser flagged as having a weak pulse. */
  weakRanges: readonly TimeRange[];
}

/** Below this trust the grid stops making candidates of its own; the onsets chart the song alone. */
export const MIN_GRID_TRUST = 0.25;

function gridContextOf(analysis: AnalysisSummary): GridContext {
  const barPhase = (((analysis.barPhase?.phase ?? 0) % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR;
  return {
    beatMs: analysis.beatMs,
    firstBeatMs: analysis.firstBeatMs,
    beatsPerBar: BEATS_PER_BAR,
    barPhase,
    toleranceMs: beatToleranceMs(analysis.beatMs),
    trust: clamp01(analysis.beatConfidence),
    weakRanges: analysis.lowConfidenceRanges ?? [],
  };
}

function beatIndexOf(context: GridContext, timeMs: number): number {
  if (!(context.beatMs > 0)) return -1;
  return Math.round((timeMs - context.firstBeatMs) / context.beatMs);
}

/** Position within the bar (0 = downbeat) after applying the estimated bar phase. */
function beatPosOf(context: GridContext, beatIndex: number): number {
  const raw = ((beatIndex % context.beatsPerBar) + context.beatsPerBar) % context.beatsPerBar;
  return (raw - context.barPhase + context.beatsPerBar) % context.beatsPerBar;
}

function isWeakPulse(context: GridContext, timeMs: number): boolean {
  return context.weakRanges.some((range) => timeMs >= range.startMs && timeMs < range.endMs);
}

/**
 * Name what an onset is, from three measurable things: where it sits relative to the beat, which
 * spectral band gained the energy, and how strong it is.
 *
 * This is deliberately *not* instrument recognition (the brief is explicit that none is available);
 * it is a register-plus-metric-position classifier. "kick" means "a loud low/broad attack on a
 * beat", which is a kick drum in most of this repertoire and a bass note or a low tom in some of it.
 * The point is not the label but the consequence: labelled events go to a lane that reflects the
 * shape of the music, so accents land on SPACE and syncopation lands on the inner keys.
 */
function classifyOnset(
  onset: OnsetEvent,
  context: GridContext,
): { role: CandidateRole; beatIndex: number; beatPos: number; onBeat: boolean } {
  const beatIndex = beatIndexOf(context, onset.timeMs);
  const offset = signedOffsetMs(onset.timeMs - context.firstBeatMs, context.beatMs);
  const onBeat = Math.abs(offset) <= context.toleranceMs;
  if (onBeat) {
    const beatPos = beatPosOf(context, beatIndex);
    if (beatPos === 0 && onset.strength >= 0.3) return { role: 'downbeat', beatIndex, beatPos, onBeat };
    if ((onset.band === 'low' || onset.band === 'broad') && onset.strength >= 0.45) {
      return { role: 'kick', beatIndex, beatPos, onBeat };
    }
    if (onset.band === 'low') return { role: 'low', beatIndex, beatPos, onBeat };
    if (onset.band === 'high' && onset.strength >= 0.4) return { role: 'high', beatIndex, beatPos, onBeat };
    return { role: 'supporting', beatIndex, beatPos, onBeat };
  }
  // Off the beat: an onset on the eighth-note grid is part of the pulse (the "and"), anything else
  // is genuine syncopation.
  const halfOffset = signedOffsetMs(onset.timeMs - context.firstBeatMs - context.beatMs / 2, context.beatMs);
  if (Math.abs(halfOffset) <= context.toleranceMs) {
    if (onset.band === 'low') return { role: 'low', beatIndex, beatPos: -1, onBeat: false };
    if (onset.band === 'high') return { role: 'high', beatIndex, beatPos: -1, onBeat: false };
    return { role: 'supporting', beatIndex, beatPos: -1, onBeat: false };
  }
  const role: CandidateRole = onset.band === 'mid' || onset.band === 'high' ? 'melodic' : 'syncopation';
  return { role, beatIndex, beatPos: -1, onBeat: false };
}

/** Build the slot skeleton from the beat grid and reinforce it with detected onsets. */
function buildCandidates(
  analysis: AnalysisSummary,
  settings: Required<Omit<GenerateOptions, 'songId' | 'title' | 'artist' | 'charter' | 'durationMs'>>,
  drop: DropCounters,
): Candidate[] {
  const beats = analysis.beats;
  const context = gridContextOf(analysis);
  const candidates: Candidate[] = [];
  if (beats.length === 0) return candidates;
  // A track with no loud sections is silence with a tempo estimate attached; chart nothing rather
  // than emit notes that the player would hear nothing for.
  if (analysis.energy.activeRanges.length === 0 && analysis.energy.lowEnergyRanges.length > 0) return candidates;
  // Nothing in the last 250 ms: a note there cannot be played before the song ends.
  const lastNoteMs = Math.max(0, analysis.durationMs - 250);
  const useGrid = context.trust >= MIN_GRID_TRUST;

  // --- grid slots: the beat only ---
  //
  // Phase 2.1 restricts the grid to **one claim per beat** (the beat itself). Subdivisions are no
  // longer invented: everything between two beats has to be an actual detected event. On the real
  // song this is what stopped a chart from being 60 % empty grid positions (measured on a synthetic
  // control: four subdivisions per beat produced 47 grid-only notes against 32 real events).
  //
  // Three further limits, each answering one way the grid can lie:
  //  - the claim is scaled by how well the grid matched the music (`trust`), so an untrustworthy
  //    grid contributes almost nothing;
  //  - a section whose pulse is weak gets no grid claims at all — that is the "do not force the
  //    song onto an unreliable fixed grid" requirement, and it is measured rather than guessed
  //    (see `BeatGrid.measureSections`);
  //  - when the music already carries more onsets than the chart can hold (`localDensity` at or
  //    above the target), the grid stays silent and the onsets decide. A grid pulse is for sparse
  //    passages, not a second layer on top of a busy one.
  const gridDensityCeiling = settings.targetNotesPerSecond * 0.75;
  for (let index = 0; index < beats.length; index += 1) {
    const timeMs = beats[index]!;
    if (timeMs > lastNoteMs) break;
    const intensity = intensityAtBeat(analysis.energy, index);
    if (isQuiet(analysis.energy, timeMs)) {
      drop.droppedBySilence += 1;
      continue;
    }
    if (!useGrid || isWeakPulse(context, timeMs)) continue;
    if (beatDensity(analysis.energy, index) >= gridDensityCeiling) continue;
    const onBar = beatPosOf(context, index) === 0;
    candidates.push({
      timeMs,
      weight: (onBar ? 1 : 0.82) * (0.3 + 0.5 * intensity) * (0.3 + 0.7 * context.trust),
      fromOnset: false,
      strength: 0,
      band: null,
      beatIndex: index,
      barAccent: onBar,
      // A slot nothing reinforces is never allowed to claim SPACE: that key is reserved for
      // accents, which by definition come from the music rather than from the tempo grid.
      role: 'beat',
      beatPos: beatPosOf(context, index),
      gridOnly: true,
      inWeakSection: false,
    });
  }

  // --- onsets: reinforce a slot or become a candidate of their own ---
  const maxNudgeMs = Math.min(25, analysis.beatMs / 8);
  for (const onset of analysis.onsets) {
    if (onset.strength < 0.12) continue;
    if (onset.timeMs > lastNoteMs) continue;
    if (isQuiet(analysis.energy, onset.timeMs)) continue;
    const classified = classifyOnset(onset, context);
    const match = nearestCandidate(candidates, onset.timeMs, context.toleranceMs);
    if (match) {
      // Reinforce: the slot is real music. Move it slightly towards the attack so a grid that is a
      // few ms late does not cost accuracy, then raise its weight by the onset's strength and adopt
      // the onset's role — this is the step that decides which key an accent lands on.
      const nudge = clamp(onset.timeMs - match.timeMs, -maxNudgeMs, maxNudgeMs);
      match.timeMs = round(match.timeMs + nudge);
      match.weight += 0.4 + 0.6 * onset.strength;
      match.fromOnset = true;
      match.strength = Math.max(match.strength, onset.strength);
      match.band = match.band ?? onset.band;
      if (match.gridOnly) {
        match.role = classified.role;
        match.beatIndex = classified.beatIndex;
        match.beatPos = classified.beatPos;
        match.barAccent = classified.beatPos === 0;
        match.gridOnly = false;
        match.inWeakSection = isWeakPulse(context, onset.timeMs);
      } else if (onset.strength > match.strength * 0.9 && classified.onBeat) {
        // A second, stronger onset in the same slot can reframe an onset candidate that was created
        // slightly off the grid (a flam, or two hits inside one tolerance window).
        match.role = classified.role;
      }
      continue;
    }
    // A strong event with no slot near it is syncopation worth charting.
    if (onset.strength < 0.45) continue;
    candidates.push({
      timeMs: onset.timeMs,
      weight: 0.45 + 0.6 * onset.strength,
      fromOnset: true,
      strength: onset.strength,
      band: onset.band,
      beatIndex: classified.beatIndex,
      barAccent: classified.beatPos === 0,
      role: classified.role,
      beatPos: classified.beatPos,
      gridOnly: false,
      inWeakSection: isWeakPulse(context, onset.timeMs),
    });
  }

  return candidates.sort((a, b) => a.timeMs - b.timeMs || b.weight - a.weight);
}

/** Onsets per second around a beat, so busy drum sections are subdivided but quiet ones are not. */
function beatDensity(energy: EnergyProfile, beatIndex: number): number {
  const perSecond = energy.onsetsPerSecond;
  if (perSecond.length === 0) return 0;
  const secondsPerBeat = Math.max(1, Math.round((energy.frameMs * 100) / 1000) || 1);
  const index = Math.min(perSecond.length - 1, Math.floor(beatIndex * secondsPerBeat * 0.55));
  const a = perSecond[Math.max(0, index - 1)] ?? 0;
  const b = perSecond[index] ?? 0;
  const c = perSecond[Math.min(perSecond.length - 1, index + 1)] ?? 0;
  return (a + b + c) / 3;
}

// --------------------------------------------------------------------------------- stage 3 ---

/** Keep candidates while the density budget allows, keeping the strongest events in each window. */
function selectCandidates(
  candidates: Candidate[],
  analysis: AnalysisSummary,
  settings: Required<Omit<GenerateOptions, 'songId' | 'title' | 'artist' | 'charter' | 'durationMs'>>,
  drop: DropCounters,
  warnings: string[],
): Candidate[] {
  const selected: Candidate[] = [];
  for (const candidate of candidates) {
    if (isQuiet(analysis.energy, candidate.timeMs)) {
      drop.droppedBySilence += 1;
      continue;
    }
    const previous = selected[selected.length - 1];
    if (previous && candidate.timeMs - previous.timeMs < settings.minNoteGapMs) {
      // Two events too close together: keep the stronger one (a flam should not become two notes).
      const before = selected[selected.length - 2];
      if (candidate.weight > previous.weight && (!before || candidate.timeMs - before.timeMs >= settings.minNoteGapMs)) {
        selected[selected.length - 1] = candidate;
      }
      drop.droppedBySpacing += 1;
      continue;
    }

    const budget = densityBudget(analysis, settings, candidate);
    let inWindow = 0;
    let weakestIndex = -1;
    let weakestWeight = Infinity;
    for (let index = selected.length - 1; index >= 0 && candidate.timeMs - selected[index]!.timeMs < 1000; index -= 1) {
      inWindow += 1;
      if (selected[index]!.weight < weakestWeight) {
        weakestWeight = selected[index]!.weight;
        weakestIndex = index;
      }
    }

    if (inWindow < budget) {
      selected.push(candidate);
      continue;
    }

    // The window is full. A purely chronological rule would thin the chart into a metronome; the
    // right answer musically is to keep the strongest events, so the weakest note already accepted
    // in this window is evicted when the new candidate is clearly stronger. Removing a note can only
    // *increase* the spacing around it, and the candidate is the latest event, so this cannot create
    // a spacing violation — the candidate already cleared the gap to its predecessor above.
    if (weakestIndex >= 0 && candidate.weight > weakestWeight * 1.05) {
      selected.splice(weakestIndex, 1);
      selected.push(candidate);
      drop.droppedByDensity += 1;
      continue;
    }
    drop.droppedByDensity += 1;
  }
  if (selected.length === 0) {
    warnings.push('no notes were generated; the track may be too quiet or too short');
  }
  return selected;
}

/** Notes allowed in the second around a candidate: intensity-driven, capped at the hard ceiling. */
function densityBudget(
  analysis: AnalysisSummary,
  settings: Required<Omit<GenerateOptions, 'songId' | 'title' | 'artist' | 'charter' | 'durationMs'>>,
  candidate: Candidate,
): number {
  const intensity = candidate.beatIndex >= 0 ? intensityAtBeat(analysis.energy, candidate.beatIndex) : 0.6;
  const target = settings.targetNotesPerSecond * (0.55 + 0.75 * intensity);
  return Math.max(1, Math.min(settings.maxNotesPerSecond, Math.round(target)));
}

// --------------------------------------------------------------------------- stages 4 + 5 ---

interface LaneState {
  lastLane: number;
  /** +1 walking right, -1 walking left; reversed at the edge of the band. */
  direction: number;
  /** How often each lane has been used, so the walk spreads over the keyboard instead of hovering. */
  usage: number[];
  freeSince: number[];
  chordCount: number;
  lastChordMs: number;
  holdCount: number;
  /** Notes placed so far, used as the denominator of the SPACE budget. */
  noteCount: number;
  spaceCount: number;
  lastSpaceMs: number;
  roleCounts: Record<CandidateRole, number>;
}

interface LaneStats {
  chordCount: number;
  holdCount: number;
  spaceCount: number;
  roleCounts: Record<CandidateRole, number>;
  gridOnlyNotes: number;
  lowConfidenceNotes: number;
}

function assignLanes(
  candidates: Candidate[],
  analysis: AnalysisSummary,
  settings: Required<Omit<GenerateOptions, 'songId' | 'title' | 'artist' | 'charter' | 'durationMs'>>,
  random: () => number,
  drop: DropCounters,
  warnings: string[],
): { notes: ChartNote[]; stats: LaneStats } {
  const notes: ChartNote[] = [];
  const context = gridContextOf(analysis);
  const state: LaneState = {
    lastLane: CENTER,
    direction: 1,
    usage: new Array<number>(LANE_COUNT).fill(0),
    freeSince: new Array<number>(LANE_COUNT).fill(-Infinity),
    chordCount: 0,
    lastChordMs: -Infinity,
    holdCount: 0,
    noteCount: 0,
    spaceCount: 0,
    lastSpaceMs: -Infinity,
    roleCounts: { ...EMPTY_ROLE_COUNTS },
  };
  // Chords are counted in *notes*, not pairs: one chord adds two notes to the chart, so the budget
  // has to be halved or the realised ratio comes out twice the configured one.
  const maxChords = Math.max(1, Math.floor((candidates.length * settings.maxChordRatio) / 2));
  const maxHolds = Math.max(1, Math.floor(candidates.length * settings.maxHoldRatio));

  let gridOnlyNotes = 0;
  let lowConfidenceNotes = 0;
  /** Role of each placed note, aligned with `notes` (a chord pushes two entries for one role). */
  const noteRoles: CandidateRole[] = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const lane = chooseLane(candidate, state, settings, context, random);
    if (lane === null) {
      drop.droppedByLaneGap += 1;
      continue;
    }

    const note: ChartNote = { timeMs: round(candidate.timeMs), lane, type: 'tap' };
    state.noteCount += 1;
    state.roleCounts[candidate.role] = (state.roleCounts[candidate.role] ?? 0) + 1;
    if (candidate.gridOnly) gridOnlyNotes += 1;
    if (candidate.inWeakSection) lowConfidenceNotes += 1;
    if (lane === CENTER) {
      state.spaceCount += 1;
      state.lastSpaceMs = candidate.timeMs;
    }
    let notesAtTime = 1;

    // Chord: a genuine accent, room in the budget, and a clear two-hand shape.
    const chordEligible =
      candidate.fromOnset &&
      candidate.strength >= 0.6 &&
      candidate.barAccent &&
      state.chordCount < maxChords &&
      candidate.timeMs - state.lastChordMs >= analysis.beatMs * 4 &&
      index + 1 < candidates.length;
    if (chordEligible) {
      const partner = chooseChordPartner(lane, candidate, state, settings, random);
      if (partner !== null) {
        state.freeSince[partner] = candidate.timeMs;
        state.usage[partner] = (state.usage[partner] ?? 0) + 1;
        notes.push({ timeMs: round(candidate.timeMs), lane: partner, type: 'tap' });
        // The partner is part of the same musical event, so it counts towards the same role (and
        // towards `noteCount`, which keeps `roleCounts` summing to the chart's note count).
        state.noteCount += 1;
        state.roleCounts[candidate.role] = (state.roleCounts[candidate.role] ?? 0) + 1;
        noteRoles.push(candidate.role);
        state.chordCount += 1;
        state.lastChordMs = candidate.timeMs;
        notesAtTime = 2;
      }
    }

    // Hold: only where a sustain is reliably implied (see the file header).
    const hold = holdFor(candidate, index, candidates, analysis, settings, maxHolds, state, lane);
    if (hold !== null) {
      note.type = 'hold';
      note.durationMs = hold.durationMs;
      state.holdCount += 1;
    }

    state.freeSince[lane] = note.type === 'hold' ? note.timeMs + (note.durationMs ?? 0) : candidate.timeMs;
    if (lane !== state.lastLane) state.direction = lane > state.lastLane ? 1 : -1;
    state.lastLane = lane;
    state.usage[lane] = (state.usage[lane] ?? 0) + 1;
    void notesAtTime;
    noteRoles.push(candidate.role);
    notes.push(note);
  }

  // Roles travel with the notes into the coverage pass, so it can keep the mapping intact where
  // the chart allows it (see `ensureLaneCoverage`). `noteRoles[i]` is the role of `notes[i]`.
  ensureLaneCoverage(notes, noteRoles, settings, state);
  if (state.chordCount === 0) warnings.push('no accents were strong enough to place chords');
  return {
    notes: sortNotes(notes),
    stats: {
      chordCount: state.chordCount,
      holdCount: state.holdCount,
      spaceCount: state.spaceCount,
      roleCounts: { ...state.roleCounts },
      gridOnlyNotes,
      lowConfidenceNotes,
    },
  };
}

/**
 * Pick a lane for a candidate.
 *
 * Three rules, in priority order, and they are what make a chart feel written rather than rolled:
 *
 *  1. **Band** — an onset's register confines it (bass low, lead high, snare/vocal centre). A kick
 *     should not appear on the far right.
 *  2. **Walk** — continue the direction of travel, one lane at a time, reversing at the edge of the
 *     band. A run of notes becomes a scale-like stream instead of a two-lane oscillation (an
 *     earlier "nearest to the last lane" rule produced literal 2-4-2-4 alternation for 90 % of a
 *     drum track — a real failure this rule fixes).
 *  3. **Spread** — a mild penalty on lanes already used a lot, so a track with one dominant band
 *     still reaches all seven keys over a chorus.
 *
 * Repeated use of the *same* lane is avoided outright, and a per-lane minimum gap is enforced.
 */
function chooseLane(
  candidate: Candidate,
  state: LaneState,
  settings: Required<Omit<GenerateOptions, 'songId' | 'title' | 'artist' | 'charter' | 'durationMs'>>,
  context: GridContext,
  random: () => number,
): number | null {
  const free = (lanes: readonly number[]): number[] =>
    lanes.filter((lane) => candidate.timeMs - state.freeSince[lane]! >= settings.minLaneGapMs);

  // The role's own lanes come first; if the minimum gap blocks all of them, fall back to the
  // onset's register and only then to the whole keyboard. Without the ladder a busy passage would
  // simply drop notes (the phase-2 behaviour, counted as `droppedByLaneGap`).
  let pool = free(ROLE_LANES[candidate.role]);
  if (pool.length === 0 && candidate.band) pool = free(BAND_LANES[candidate.band]);
  if (pool.length === 0) pool = free(ALL_LANES);
  if (pool.length === 0) return null;

  // SPACE is rationed: it is the "main beat" key, so it is only offered to genuine accents, only
  // while the budget lasts, and never twice inside one beat.
  const spaceLanes = free([CENTER]);
  const spaceOffered =
    spaceLanes.length > 0 && spaceAllowed(candidate, state, settings, context) && pool.includes(CENTER);
  if (pool.includes(CENTER) && !spaceOffered) {
    const withoutSpace = pool.filter((lane) => lane !== CENTER);
    pool = withoutSpace.length > 0 ? withoutSpace : free(ALL_LANES).filter((lane) => lane !== CENTER);
  }
  if (pool.length === 0) return null;

  const withoutRepeat = pool.filter((lane) => lane !== state.lastLane);
  if (withoutRepeat.length > 0) pool = withoutRepeat;

  const direction = state.direction >= 0 ? 1 : -1;
  const target = state.lastLane + direction;
  const preferred = ROLE_LANES[candidate.role];
  let best = pool[0]!;
  let bestScore = -Infinity;
  for (const lane of pool) {
    const roleRank = preferred.indexOf(lane);
    // The first two lanes of a role are its *meaning* (SPACE for an accent, A and L for percussion,
    // S and K for support, D and J for melody); the rest of the ladder is only a fallback for when
    // spacing blocks both, so it scores far lower. Without that gap the walk would happily drift a
    // low percussion hit into the right hand, which is the failure this whole mapping replaces.
    const roleFit = roleRank === 0 ? 2 : roleRank === 1 ? 1.4 : 0.15;
    const score =
      (lane === CENTER && spaceOffered ? 0.8 : 0) +
      roleFit +
      -0.25 * Math.abs(lane - target) +
      -0.25 * (state.usage[lane] ?? 0) +
      random() * 0.2;
    if (score > bestScore) {
      bestScore = score;
      best = lane;
    }
  }
  return best;
}

/**
 * Is this candidate allowed to take SPACE?
 *
 * Three conditions, all of them about meaning rather than spacing: the event must be an accent
 * (a downbeat or a kick-like hit — never a grid slot, never a mid-band offbeat), the chart's SPACE
 * budget must not be spent, and the previous SPACE note must be at least a beat away. Without the
 * budget every downbeat in a four-on-the-floor track would land on SPACE and the key would stop
 * signalling anything; with it, SPACE marks roughly a third of the accents.
 */
function spaceAllowed(
  candidate: Candidate,
  state: LaneState,
  settings: Required<Omit<GenerateOptions, 'songId' | 'title' | 'artist' | 'charter' | 'durationMs'>>,
  context: GridContext,
): boolean {
  if (candidate.role !== 'downbeat' && candidate.role !== 'kick') return false;
  const budget = Math.max(4, Math.floor(settings.maxSpaceRatio * (state.noteCount + 1)));
  if (state.spaceCount >= budget) return false;
  return candidate.timeMs - state.lastSpaceMs >= Math.max(context.beatMs * 0.9, settings.minLaneGapMs);
}

/**
 * Coverage pass: make sure a chart long enough to be a chart actually uses all seven lanes.
 *
 * Band preference and the band-aware walk can leave a lane untouched for a whole track when the
 * music only occupies one register (a kick-and-hat loop confines onsets to the low/broad bands, and
 * the walk reverses before it ever reaches the far right). The fix is honest and local: move a
 * single note into an unused lane, chosen from the most over-used lane, only where the move keeps
 * the per-lane spacing legal and does not create a repeated lane between neighbours. Holds are left
 * alone — moving a hold's head would move its tail too.
 */
function ensureLaneCoverage(
  notes: ChartNote[],
  noteRoles: readonly CandidateRole[],
  settings: { minLaneGapMs: number },
  state: LaneState,
): void {
  if (notes.length < 24) return;
  const usage = state.usage.slice();
  for (let lane = 0; lane < LANE_COUNT; lane += 1) {
    if ((usage[lane] ?? 0) > 0) continue;
    // The coverage pass exists to spread the chart over the keyboard, not to promote notes into
    // SPACE: that lane is rationed (see `spaceAllowed`), so it is filled by accents only.
    if (lane === CENTER && state.spaceCount > 0) continue;
    const eligible: Array<{ index: number; timeMs: number; from: number; consistent: boolean }> = [];
    for (let index = 0; index < notes.length; index += 1) {
      const note = notes[index]!;
      if (note.type === 'hold') continue;
      const previous = notes[index - 1];
      const next = notes[index + 1];
      if ((previous && previous.lane === lane) || (next && next.lane === lane)) continue;
      const clear = notes.every(
        (other) => other.lane !== lane || Math.abs(other.timeMs - note.timeMs) >= settings.minLaneGapMs,
      );
      if (!clear) continue;
      // Prefer a note whose role ladder already contains this lane: a coverage move should keep the
      // chart's role mapping intact where it can, instead of relabelling an arbitrary note.
      const role = noteRoles[index];
      const consistent = role !== undefined && ROLE_LANES[role].includes(lane);
      eligible.push({ index, timeMs: note.timeMs, from: note.lane, consistent });
    }
    if (eligible.length === 0) continue;
    const preferred = eligible.filter((entry) => entry.consistent);
    const pool = preferred.length > 0 ? preferred : eligible;
    pool.sort((a, b) => (usage[b.from]! - usage[a.from]!) || a.timeMs - b.timeMs);
    const pick = pool[0]!;
    usage[pick.from] = (usage[pick.from] ?? 0) - 1;
    usage[lane] = (usage[lane] ?? 0) + 1;
    notes[pick.index]!.lane = lane;
  }
}

/** Second note of a chord: the other hand, one step away from the primary lane. */
function chooseChordPartner(
  lane: number,
  candidate: Candidate,
  state: LaneState,
  settings: Required<Omit<GenerateOptions, 'songId' | 'title' | 'artist' | 'charter' | 'durationMs'>>,
  random: () => number,
): number | null {
  const opposite = lane <= CENTER ? RIGHT_HAND : LEFT_HAND;
  const free = opposite.filter((other) => candidate.timeMs - state.freeSince[other]! >= settings.minLaneGapMs);
  if (free.length === 0) return null;
  const mirrored = free.filter((other) => Math.abs(LANE_COUNT - 1 - lane - other) <= 1);
  const pool = mirrored.length > 0 ? mirrored : free;
  return pool[Math.floor(random() * pool.length)]!;
}

/** A hold when the music (and the note list) reliably implies a sustain. */
function holdFor(
  candidate: Candidate,
  index: number,
  candidates: readonly Candidate[],
  analysis: AnalysisSummary,
  settings: Required<Omit<GenerateOptions, 'songId' | 'title' | 'artist' | 'charter' | 'durationMs'>>,
  maxHolds: number,
  state: LaneState,
  lane: number,
): { durationMs: number } | null {
  if (state.holdCount >= maxHolds) return null;
  if (!candidate.barAccent || candidate.beatIndex < 0) return null;
  const intensity = intensityAtBeat(analysis.energy, candidate.beatIndex);
  if (intensity < 0.55) return null;
  // The next event anywhere in the map must be at least two beats away: a hold that immediately
  // needs another key is the classic "impossible pattern" the brief warns about.
  const next = candidates[index + 1];
  const gapMs = next ? next.timeMs - candidate.timeMs : Infinity;
  const twoBeats = analysis.beatMs * 2;
  const durationMs = Math.min(twoBeats, gapMs - settings.minNoteGapMs);
  if (durationMs < analysis.beatMs * 1.25) return null;
  // Never hold into a quiet section.
  if (isQuiet(analysis.energy, candidate.timeMs + durationMs)) return null;
  void lane;
  return { durationMs: round(durationMs) };
}

// ----------------------------------------------------------------------------------- helpers ---

const ALL_LANES = Array.from({ length: LANE_COUNT }, (_, index) => index);

function isQuiet(energy: EnergyProfile, timeMs: number): boolean {
  if (energy.lowEnergyRanges.length === 0) return false;
  return energy.lowEnergyRanges.some((range) => timeMs >= range.startMs && timeMs < range.endMs);
}

function nearestCandidate(candidates: readonly Candidate[], timeMs: number, toleranceMs: number): Candidate | null {
  let best: Candidate | null = null;
  let bestDistance = toleranceMs;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate.timeMs - timeMs);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    } else if (candidate.timeMs - timeMs > toleranceMs) {
      break;
    }
  }
  return best;
}

function buildBeatmap(
  notes: ChartNote[],
  analysis: AnalysisSummary,
  settings: Required<Omit<GenerateOptions, 'songId' | 'title' | 'artist' | 'charter' | 'durationMs'>> & {
    songId: string;
    title: string;
    artist?: string;
    charter?: string;
    durationMs?: number;
  },
): Beatmap {
  const chart: Beatmap = {
    schemaVersion: BEATMAP_SCHEMA_VERSION,
    songId: settings.songId,
    title: settings.title,
    difficulty: 'normal',
    bpm: round(analysis.bpm),
    offsetMs: 0,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION, seed: settings.seed },
    durationMs: settings.durationMs ?? analysis.durationMs,
    notes,
  };
  if (settings.artist) chart.artist = settings.artist;
  if (settings.charter) chart.charter = settings.charter;
  return chart;
}

function summarize(
  chart: Beatmap,
  analysis: AnalysisSummary,
  settings: Required<Omit<GenerateOptions, 'songId' | 'title' | 'artist' | 'charter' | 'durationMs'>>,
  lanes: LaneStats,
  drop: DropCounters,
): ChartStats {
  const notes = chart.notes;
  const laneUsage = new Array<number>(LANE_COUNT).fill(0);
  for (const note of notes) laneUsage[note.lane] = (laneUsage[note.lane] ?? 0) + 1;

  const onsetTimes = analysis.onsets.map((onset) => onset.timeMs);
  const onOnset = notes.filter((note) => isNear(onsetTimes, note.timeMs, settings.alignToleranceMs)).length;
  const onBeat = notes.filter((note) =>
    isNear(analysis.beats, note.timeMs, Math.min(settings.alignToleranceMs, analysis.beatMs / 6)),
  ).length;

  let peak = 0;
  let head = 0;
  const times = notes.map((note) => note.timeMs);
  for (let tail = 0; tail < times.length; tail += 1) {
    while (times[tail]! - times[head]! >= 1000) head += 1;
    peak = Math.max(peak, tail - head + 1);
  }

  const gaps: number[] = [];
  for (let index = 1; index < notes.length; index += 1) gaps.push(times[index]! - times[index - 1]!);
  const meanGap = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  const durationMs = chart.durationMs ?? analysis.durationMs;
  const lastEnd = notes.reduce((max, note) => Math.max(max, note.type === 'hold' ? note.timeMs + (note.durationMs ?? 0) : note.timeMs), 0);
  const tapCount = notes.filter((note) => note.type === 'tap').length;

  return {
    noteCount: notes.length,
    tapCount,
    holdCount: notes.length - tapCount,
    chordCount: lanes.chordCount,
    holdRatio: notes.length > 0 ? (notes.length - tapCount) / notes.length : 0,
    chordRatio: notes.length > 0 ? (lanes.chordCount * 2) / notes.length : 0,
    notesPerSecond: durationMs > 0 ? (notes.length / durationMs) * 1000 : 0,
    peakNotesPerSecond: peak,
    chartDurationMs: round(durationMs),
    firstNoteMs: notes[0]?.timeMs ?? 0,
    lastNoteEndMs: round(lastEnd),
    laneUsage,
    lanesUsed: laneUsage.filter((count) => count > 0).length,
    onOnset,
    onBeat,
    onsetAlignRatio: notes.length > 0 ? onOnset / notes.length : 0,
    beatAlignRatio: notes.length > 0 ? onBeat / notes.length : 0,
    candidatesConsidered: notes.length + drop.droppedByDensity + drop.droppedBySilence + drop.droppedBySpacing,
    droppedByDensity: drop.droppedByDensity,
    droppedBySilence: drop.droppedBySilence,
    droppedBySpacing: drop.droppedBySpacing,
    droppedByLaneGap: drop.droppedByLaneGap,
    droppedByLaneExhausted: drop.droppedByLaneExhausted,
    longGapCount: gaps.filter((gap) => gap > 2000).length,
    maxGapMs: round(gaps.length > 0 ? Math.max(...gaps) : 0),
    meanGapMs: round(meanGap),
    sectionsSkipped: analysis.energy.lowEnergyRanges.length,
    spaceCount: laneUsage[CENTER] ?? 0,
    spaceRatio: notes.length > 0 ? round((laneUsage[CENTER] ?? 0) / notes.length) : 0,
    roleCounts: { ...lanes.roleCounts },
    gridOnlyNotes: lanes.gridOnlyNotes,
    lowConfidenceNotes: lanes.lowConfidenceNotes,
  };
}

function isNear(sorted: readonly number[], value: number, tolerance: number): boolean {
  // Binary search keeps this cheap for charts with thousands of notes.
  let low = 0;
  let high = sorted.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const current = sorted[mid]!;
    if (Math.abs(current - value) <= tolerance) return true;
    if (current < value) low = mid + 1;
    else high = mid - 1;
  }
  return false;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Exposed for tests: the lane sets the generator uses, so tests can assert coverage. */
export const GENERATOR_LANES = { BAND_LANES, LEFT_HAND, RIGHT_HAND, CENTER } as const;

/** Re-exported for callers that build an `AnalysisSummary` from a full result. */
export { intensityAtBeat };
export type { OnsetEvent };
