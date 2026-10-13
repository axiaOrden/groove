// @vitest-environment jsdom
/**
 * The HUD's score readout (phase 3.1).
 *
 * The corrective brief asks that the *displayed* percentage can reach 100 % on a perfect run, which
 * is only true if the number next to the score is the reachable maximum (see `perfectRunScore`).
 * This drives the real `Hud` and reads the text it writes.
 */

import { describe, expect, it } from 'vitest';
import { Hud, type HudFrame } from '../src/ui/Hud';
import type { ScoreSnapshot } from '../src/game/ScoreManager';
import { perfectRunScore } from '../src/chart/ScoreModel';
import type { ChartNote } from '../src/chart/ChartTypes';
import { LANE_COUNT } from '../src/renderer/Layout';

/**
 * Every id `Hud` reads.
 *
 * Built once, at module load, because `ui/dom.ts` caches elements by id: a second `innerHTML` swap
 * would leave the HUD writing into detached nodes. One document, one HUD, and each test asserts on
 * the text its own `update` just wrote.
 */
document.body.innerHTML = `
  <div id="hud">
    <div id="hud-stats"><span id="stat-accuracy"></span><span id="stat-maxscore"></span></div>
    <div id="hud-score"></div><div id="hud-time"></div><div id="hud-fps"></div>
    <div id="hud-progress"></div>
    <div id="stat-maxcombo"></div><div id="stat-perfect"></div><div id="stat-good"></div>
    <div id="stat-bad"></div><div id="stat-miss"></div><div id="stat-holds"></div>
    <div id="stat-difficulty"></div>
    <div id="hud-combo"><div id="hud-combo-value"></div></div>
    <div id="hud-countdown"></div>
    <div id="judgement-layer"></div>
    <div id="key-hints"></div>
  </div>`;

const hud = new Hud();
const maxScoreText = (): string => document.getElementById('stat-maxscore')!.textContent!;

const SNAPSHOT: ScoreSnapshot = {
  score: 0,
  combo: 0,
  maxCombo: 0,
  accuracy: 1,
  counts: { perfect: 0, good: 0, bad: 0, miss: 0 },
  holdCompleted: 0,
  holdBroken: 0,
  interruptedHolds: 0,
  strayPresses: 0,
  judgedNotes: 0,
};

function frame(score: number, maxScore: number): HudFrame {
  return {
    snapshot: { ...SNAPSHOT, score },
    songTimeMs: 10_000,
    durationMs: 20_000,
    fps: 60,
    countInRemainingMs: 0,
    beatMs: 500,
    countInMs: 0,
    difficulty: 'hard',
    laneCount: LANE_COUNT,
    maxScore,
  };
}

const NOTES: ChartNote[] = [
  { timeMs: 0, lane: 0, type: 'tap' },
  { timeMs: 500, lane: 1, type: 'hold', durationMs: 400 },
  { timeMs: 1500, lane: 2, type: 'tap' },
  { timeMs: 2000, lane: 3, type: 'tap' },
];

describe('the HUD score readout', () => {
  it('shows the reachable maximum and the share of it that has been scored', () => {
    const maxScore = perfectRunScore(NOTES, 2);
    hud.update(frame(0, maxScore));
    expect(maxScoreText()).toBe(`${maxScore.toLocaleString('en-US')} · 0.00%`);
  });

  it('reaches exactly 100.00% on a perfect run', () => {
    const maxScore = perfectRunScore(NOTES, 2);
    hud.update(frame(maxScore, maxScore));
    expect(maxScoreText()).toBe(`${maxScore.toLocaleString('en-US')} · 100.00%`);
    // The score line itself is the raw score, unchanged by the percentage.
    expect(document.getElementById('hud-score')!.textContent).toBe(maxScore.toLocaleString('en-US'));
  });

  it('never reads more than 100% (a run cannot exceed a flawless one)', () => {
    hud.update(frame(999_999, 1000));
    expect(maxScoreText()).toContain('100.00%');
  });

  it('survives a zero maximum (an empty chart)', () => {
    hud.update(frame(0, 0));
    expect(maxScoreText()).toBe('0 · 0.00%');
  });
});
