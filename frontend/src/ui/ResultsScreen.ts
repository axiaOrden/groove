/**
 * ResultsScreen — fills the results panel from a completed run.
 *
 * Everything shown here is derived from `PlayResults`, which the engine computes from the
 * score manager, so what the player reads is exactly what was scored (no re-derivation and no
 * chance of the UI disagreeing with the rules).
 */

import type { PlayResults } from '../game/ScoreManager';
import { el, formatPercent, setText } from './dom';

export class ResultsScreen {
  private readonly grade = el('result-grade');
  private readonly score = el('result-score');
  private readonly accuracy = el('result-accuracy');
  private readonly maxCombo = el('result-maxcombo');
  private readonly perfect = el('result-perfect');
  private readonly good = el('result-good');
  private readonly bad = el('result-bad');
  private readonly miss = el('result-miss');
  private readonly holdsCompleted = el('result-holds-completed');
  private readonly holdsBroken = el('result-holds-broken');
  private readonly stray = el('result-stray');
  private readonly notes = el('result-notes');

  render(results: PlayResults): void {
    setText(this.grade, results.grade);
    setText(this.score, results.score.toLocaleString('en-US'));
    setText(this.accuracy, `${formatPercent(results.accuracy)} accuracy`);
    setText(this.maxCombo, String(results.maxCombo));
    setText(this.perfect, String(results.counts.perfect));
    setText(this.good, String(results.counts.good));
    setText(this.bad, String(results.counts.bad));
    setText(this.miss, String(results.counts.miss));
    setText(this.holdsCompleted, String(results.holdCompleted));
    setText(this.holdsBroken, String(results.holdBroken));
    setText(this.stray, String(results.strayPresses));
    setText(this.notes, String(results.totalNotes));
  }
}
