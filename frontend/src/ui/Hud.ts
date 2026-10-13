/**
 * Hud — the in-game heads-up display.
 *
 * All writes go through change-detecting helpers (`setText`/`setAttr`), so a steady frame
 * touches only the score, the clock, the progress bar and the FPS readout instead of rewriting
 * several dozen text nodes every frame.
 *
 * Judgment popups are pooled DOM nodes reused in a ring buffer; the CSS animation is restarted
 * on reuse instead of creating garbage, which keeps a dense chart from thrashing the DOM.
 */

import type { JudgmentType } from '../game/GameConfig';
import { JUDGMENT_LABELS } from '../game/JudgmentEngine';
import type { ScoreSnapshot } from '../game/ScoreManager';
import { LANE_COUNT, laneColorsFor, setActiveLanePalette } from '../renderer/Layout';
import { el, formatClock, formatPercent, formatOffset, restartAnimation, setAttr, setText } from './dom';
import { keyLabelsFor, type ChartDifficulty } from '../chart/Difficulty';

export interface HudFrame {
  snapshot: ScoreSnapshot;
  songTimeMs: number;
  durationMs: number;
  fps: number;
  /** Milliseconds until the song clock reaches 0; > 0 means the count-in is still running. */
  countInRemainingMs: number;
  beatMs: number;
  countInMs: number;
  /** Difficulty of the chart being played, shown next to the counters (phase 3). */
  difficulty: ChartDifficulty;
  laneCount: number;
  /** Theoretical maximum for this chart at its difficulty weight. */
  maxScore: number;
}

const JUDGEMENT_POOL_SIZE = 14;

export class Hud {
  private readonly root = el('hud');
  private readonly stats = el('hud-stats');
  private readonly score = el('hud-score');
  private readonly time = el('hud-time');
  private readonly fpsNode = el('hud-fps');
  private readonly progress = el('hud-progress');
  private readonly accuracy = el('stat-accuracy');
  private readonly maxCombo = el('stat-maxcombo');
  private readonly perfect = el('stat-perfect');
  private readonly good = el('stat-good');
  private readonly bad = el('stat-bad');
  private readonly miss = el('stat-miss');
  private readonly holds = el('stat-holds');
  private readonly combo = el('hud-combo');
  private readonly comboValue = el('hud-combo-value');
  private readonly countdown = el('hud-countdown');
  private readonly judgementLayer = el('judgement-layer');
  private readonly keyHints = el('key-hints');
  private readonly difficulty = el('stat-difficulty');
  private readonly maxScore = el('stat-maxscore');
  private lanesValue = LANE_COUNT;

  private readonly judgementPool: HTMLElement[] = [];
  private judgementCursor = 0;
  private lastCombo = 0;
  private lastCountdownText = '';

  constructor() {
    this.buildKeyHints(LANE_COUNT);
    this.buildJudgementPool();
  }

  get laneCount(): number {
    return this.lanesValue;
  }

  /** Rebuild the key strip for a lane count (the difficulty's keys, in lane order). */
  setLaneCount(laneCount: number): void {
    const lanes = Math.max(1, Math.min(LANE_COUNT, Math.round(laneCount) || LANE_COUNT));
    if (lanes === this.lanesValue && this.keyHints.children.length === lanes) return;
    this.lanesValue = lanes;
    this.buildKeyHints(lanes);
  }

  /** Repaint the key strip in another lane palette (the lanes' colours come from one definition). */
  setPalette(paletteId: string): void {
    setActiveLanePalette(paletteId);
    this.buildKeyHints(this.lanesValue);
  }

  update(frame: HudFrame): void {
    const { snapshot, songTimeMs, durationMs, fps } = frame;

    setText(this.score, snapshot.score.toLocaleString('en-US'));
    setText(this.time, `${formatClock(Math.max(0, songTimeMs))} / ${formatClock(durationMs)}`);
    setText(this.fpsNode, `${fps.toFixed(0)} fps`);
    setText(this.accuracy, formatPercent(snapshot.accuracy));
    setText(this.maxCombo, String(snapshot.maxCombo));
    setText(this.perfect, String(snapshot.counts.perfect));
    setText(this.good, String(snapshot.counts.good));
    setText(this.bad, String(snapshot.counts.bad));
    setText(this.miss, String(snapshot.counts.miss));
    setText(this.holds, String(snapshot.holdCompleted));
    setText(this.difficulty, `${frame.difficulty} · ${frame.laneCount} keys`);
    // The maximum is the score of a flawless run (see `chart/ScoreModel`), so the percentage beside
    // it is honest: it reads 100.00 % on a perfect run and never exceeds it.
    const maxRatio = frame.maxScore > 0 ? Math.min(1, snapshot.score / frame.maxScore) : 0;
    setText(this.maxScore, `${frame.maxScore.toLocaleString('en-US')} · ${formatPercent(maxRatio)}`);

    const ratio = durationMs > 0 ? Math.min(1, Math.max(0, songTimeMs / durationMs)) : 0;
    this.progress.style.width = `${(ratio * 100).toFixed(2)}%`;

    setText(this.comboValue, String(snapshot.combo));
    setAttr(this.combo, 'data-visible', snapshot.combo >= 2 ? 'true' : 'false');
    if (snapshot.combo > this.lastCombo && snapshot.combo >= 2) {
      restartAnimation(this.comboValue);
    }
    this.lastCombo = snapshot.combo;

    this.updateCountdown(frame);
  }

  /** Show or hide the 3-2-1 lead-in derived from the audio clock. */
  private updateCountdown(frame: HudFrame): void {
    const { countInRemainingMs, beatMs, countInMs } = frame;
    let text = '';
    if (countInMs > 0 && countInRemainingMs > 0 && countInRemainingMs <= countInMs) {
      text = String(Math.max(1, Math.ceil(countInRemainingMs / beatMs)));
    }
    if (text !== this.lastCountdownText) {
      setText(this.countdown, text);
      this.lastCountdownText = text;
    }
    setAttr(this.countdown, 'data-visible', text === '' ? 'false' : 'true');
  }

  /** Push a judgment popup. `errorMs` is signed (negative = early) or null for an auto-miss. */
  popJudgment(judgment: JudgmentType | 'hold', errorMs: number | null, label?: string): void {
    const node = this.judgementPool[this.judgementCursor]!;
    this.judgementCursor = (this.judgementCursor + 1) % this.judgementPool.length;

    const text = label ?? JUDGMENT_LABELS[judgment as JudgmentType] ?? 'HOLD';
    if (errorMs === null || errorMs === undefined) {
      node.textContent = text;
    } else {
      node.innerHTML = `${text}<small>${formatOffset(errorMs)}</small>`;
    }
    // Small horizontal jitter so a chord does not stack four popups on one pixel column.
    node.style.marginLeft = `${(this.judgementCursor % 5) * 18 - 36}px`;
    setAttr(node, 'data-judgment', judgment);
    restartAnimation(node);
  }

  setLaneActive(lane: number, active: boolean): void {
    const pill = this.keyHints.children[lane];
    if (pill instanceof HTMLElement) setAttr(pill, 'data-active', active ? 'true' : 'false');
  }

  /**
   * Bottom edge of the informational HUD block, in CSS px from the top of the viewport. The
   * touch lane columns start below it so that reaching for the score or the counters cannot
   * trigger a note. Returns `fallback` when the HUD is hidden or not laid out yet (menus,
   * first frame, or a headless DOM).
   */
  contentBottomPx(fallback: number): number {
    if (this.root.hidden) return fallback;
    const rect = this.stats.getBoundingClientRect();
    if (rect.height <= 0) return fallback;
    return rect.bottom;
  }

  clearLaneStates(): void {
    for (let lane = 0; lane < this.lanesValue; lane += 1) this.setLaneActive(lane, false);
  }

  show(visible: boolean): void {
    if (this.root.hidden === !visible) return;
    this.root.hidden = !visible;
  }

  reset(): void {
    this.lastCombo = 0;
    this.lastCountdownText = '';
    setText(this.countdown, '');
    setAttr(this.countdown, 'data-visible', 'false');
    setAttr(this.combo, 'data-visible', 'false');
    setText(this.comboValue, '0');
    this.judgementPool.forEach((node) => {
      node.textContent = '';
      node.style.animation = 'none';
    });
    this.clearLaneStates();
  }

  private buildKeyHints(laneCount: number): void {
    this.keyHints.replaceChildren();
    const labels = keyLabelsFor(laneCount);
    const colors = laneColorsFor(laneCount);
    labels.forEach((label, index) => {
      const pill = document.createElement('div');
      pill.className = 'key';
      pill.dataset.active = 'false';
      pill.style.setProperty(
        '--lane-color',
        `#${(colors[index] ?? colors[0] ?? 0xffffff).toString(16).padStart(6, '0')}`,
      );
      pill.innerHTML = `<span>${label}</span>`;
      this.keyHints.appendChild(pill);
    });
  }

  private buildJudgementPool(): void {
    this.judgementLayer.replaceChildren();
    for (let i = 0; i < JUDGEMENT_POOL_SIZE; i += 1) {
      const node = document.createElement('div');
      node.className = 'judgement';
      node.dataset.judgment = 'perfect';
      node.style.animation = 'none';
      this.judgementLayer.appendChild(node);
      this.judgementPool.push(node);
    }
  }
}
