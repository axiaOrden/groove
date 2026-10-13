/**
 * Lane profiles: the traffic rules of the highway, per lane count.
 *
 * The phase 2.1 generator gives every detected event a **role** from measurable features (where it
 * sits relative to the beat, which spectral band gained the energy, how strong it is — see
 * `classifyOnset` in ChartGenerator) and then maps roles onto keys:
 *
 *     role            lane(s)          what it is on the track
 *     --------------- ---------------- -------------------------------------------
 *     downbeat        centre           the accented beat of the bar
 *     kick            centre           a loud low/broad attack on a beat
 *     low             left             low percussion off the accents
 *     high            right            high percussion off the accents
 *     supporting      inner            on-beat events without a strong low end
 *     melodic         inner/outer      mid/high events away from the beat
 *     syncopation     inner            an onset that falls between the beats
 *     beat            supporting only  a grid beat with no onset on it
 *
 * Phase 3 renders four, five or seven lanes, so "SPACE" cannot simply be lane 3 any more. This
 * module is the single place that answers, for a given lane count:
 *
 *   - which lane is the **centre** (the one that means "the beat"), if any,
 *   - which lanes belong to each hand (used for chord shapes),
 *   - the preference ladder each role walks when its first lane is blocked,
 *   - which lanes an onset's spectral band is allowed to use.
 *
 * The tables are **heuristics, not instrument recognition**: nothing here separates sources or
 * classifies instruments. "kick" means "a strong low-frequency attack on a beat". What the mapping
 * guarantees is the *shape* of the music: accents go to the centre key, register spreads left to
 * right, syncopation goes to the inner keys — and it guarantees it at every lane count.
 *
 * Note what an even lane count does: with four lanes there is no middle key at all, so the centre
 * role is deliberately `null` and the accented pair (S/K) takes the accents instead. That is why
 * Easy is a genuinely different chart rather than a lane-hidden Hard one.
 */

import type { OnsetBand } from '../analysis/types';
import { LANE_COUNT } from './ChartTypes';

/** What a detected event *is*, as far as measurable features can say. */
export type CandidateRole =
  | 'downbeat'
  | 'kick'
  | 'low'
  | 'high'
  | 'supporting'
  | 'melodic'
  | 'syncopation'
  | 'beat';

export const CANDIDATE_ROLES: readonly CandidateRole[] = [
  'downbeat',
  'kick',
  'low',
  'high',
  'supporting',
  'melodic',
  'syncopation',
  'beat',
];

export interface LaneProfile {
  laneCount: number;
  /**
   * The lane that means "the primary beat", or `null` when the layout has no middle key
   * (an even lane count). Roles that would claim it fall back to their next entry.
   */
  centerLane: number | null;
  leftHand: readonly number[];
  rightHand: readonly number[];
  allLanes: readonly number[];
  /** Preferred lanes per role, in order. The first entry is the role's *meaning*. */
  roleLanes: Readonly<Record<CandidateRole, readonly number[]>>;
  /** Lanes an onset's spectral band may use, used as a fallback when spacing blocks the role. */
  bandLanes: Readonly<Record<OnsetBand, readonly number[]>>;
}

/** Seven lanes — the phase 2 behaviour, preserved exactly (A S D SPACE J K L). */
const PROFILE_7: Omit<LaneProfile, 'laneCount' | 'allLanes'> = {
  centerLane: 3,
  leftHand: [0, 1, 2],
  rightHand: [4, 5, 6],
  roleLanes: {
    downbeat: [3, 2, 4, 1, 5, 0, 6],
    kick: [3, 2, 4, 0, 6, 1, 5],
    low: [0, 1, 2, 3, 4, 5, 6],
    high: [6, 5, 4, 3, 2, 1, 0],
    supporting: [1, 5, 2, 4, 0, 6, 3],
    melodic: [2, 4, 1, 5, 0, 6, 3],
    syncopation: [4, 2, 5, 1, 6, 0, 3],
    // A grid beat with nothing happening on it is a weak claim: it prefers the supporting keys and
    // never claims the centre, which is reserved for accents.
    beat: [1, 5, 2, 4, 0, 6],
  },
  bandLanes: {
    low: [0, 1, 2],
    mid: [2, 3, 4],
    high: [4, 5, 6],
    broad: [0, 1, 2, 3, 4, 5, 6],
  },
};

/** Five lanes — A S SPACE K L. SPACE is the centre; the outer keys carry register. */
const PROFILE_5: Omit<LaneProfile, 'laneCount' | 'allLanes'> = {
  centerLane: 2,
  leftHand: [0, 1],
  rightHand: [3, 4],
  roleLanes: {
    downbeat: [2, 1, 3, 0, 4],
    kick: [2, 1, 3, 0, 4],
    low: [0, 1, 2, 3, 4],
    high: [4, 3, 2, 1, 0],
    supporting: [1, 3, 0, 4, 2],
    // Melody accents stay off the supporting pair where the layout allows: A and L are the outer
    // keys, so a lead stab does not look like the percussion it accompanies.
    melodic: [0, 4, 1, 3, 2],
    syncopation: [3, 1, 4, 0, 2],
    beat: [1, 3, 0, 4],
  },
  bandLanes: {
    low: [0, 1, 2],
    mid: [1, 2, 3],
    high: [2, 3, 4],
    broad: [0, 1, 2, 3, 4],
  },
};

/** Four lanes — A S K L. No middle key: the accented pair S/K takes the beat. */
const PROFILE_4: Omit<LaneProfile, 'laneCount' | 'allLanes'> = {
  centerLane: null,
  leftHand: [0, 1],
  rightHand: [2, 3],
  roleLanes: {
    downbeat: [1, 2, 0, 3],
    kick: [1, 2, 0, 3],
    low: [0, 1, 2, 3],
    high: [3, 2, 1, 0],
    supporting: [1, 2, 0, 3],
    melodic: [0, 3, 1, 2],
    syncopation: [2, 1, 3, 0],
    beat: [1, 2, 0, 3],
  },
  bandLanes: {
    low: [0, 1],
    mid: [1, 2],
    high: [2, 3],
    broad: [0, 1, 2, 3],
  },
};

const TABLES: Readonly<Record<number, Omit<LaneProfile, 'laneCount' | 'allLanes'>>> = {
  4: PROFILE_4,
  5: PROFILE_5,
  7: PROFILE_7,
};

/**
 * The profile for a lane count.
 *
 * Four, five and seven lanes use the hand-tuned tables above. Any other count is derived
 * symmetrically, which keeps the generator total (a hand-edited chart with an odd lane count still
 * charts) without pretending the result is tuned.
 */
export function laneProfileFor(laneCount: number): LaneProfile {
  const count = Number.isInteger(laneCount) && laneCount >= 1 ? Math.min(LANE_COUNT, laneCount) : LANE_COUNT;
  const allLanes = Array.from({ length: count }, (_, index) => index);
  const table = TABLES[count] ?? deriveProfile(count, allLanes);
  return { laneCount: count, allLanes, ...table };
}

/** Symmetric fallback for a lane count without a tuned table. */
function deriveProfile(count: number, allLanes: readonly number[]): Omit<LaneProfile, 'laneCount' | 'allLanes'> {
  const odd = count % 2 === 1;
  const centerLane = odd ? (count - 1) / 2 : null;
  const split = odd ? centerLane! : count / 2;
  const leftHand = allLanes.filter((lane) => lane < split);
  const rightHand = allLanes.filter((lane) => lane > (odd ? split : split - 1));
  /** Order lanes by a distance key from the centre, stable on ties. */
  const byCenterDistance = (bias: 'in' | 'out' | 'left' | 'right'): number[] =>
    [...allLanes].sort((a, b) => {
      if (bias === 'out') return Math.abs(b - split) - Math.abs(a - split) || a - b;
      if (bias === 'left') return a - b;
      if (bias === 'right') return b - a;
      return Math.abs(a - split) - Math.abs(b - split) || a - b;
    });
  const inner = byCenterDistance('in');
  const outer = byCenterDistance('out');
  const centreFirst = centerLane === null ? inner : [centerLane, ...inner.filter((lane) => lane !== centerLane)];
  const noCenter = centreFirst.filter((lane) => lane !== centerLane);
  return {
    centerLane,
    leftHand,
    rightHand,
    roleLanes: {
      downbeat: centreFirst,
      kick: centreFirst,
      low: [...leftHand, ...rightHand],
      high: [...rightHand, ...leftHand],
      supporting: inner,
      melodic: outer,
      syncopation: inner,
      beat: centerLane === null ? inner : noCenter,
    },
    bandLanes: {
      low: [...leftHand, ...(centerLane === null ? [] : [centerLane])],
      mid: inner.slice(0, Math.max(1, Math.ceil(count / 2))),
      high: [...(centerLane === null ? [] : [centerLane]), ...rightHand],
      broad: [...allLanes],
    },
  };
}

/** Lanes in a role's ladder that belong to the opposite hand of `lane`. */
export function oppositeHandOf(profile: LaneProfile, lane: number): readonly number[] {
  return lane < profile.laneCount / 2 ? profile.rightHand : profile.leftHand;
}
