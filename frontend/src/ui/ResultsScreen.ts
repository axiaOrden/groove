/**
 * ResultsScreen — fills the results panel from a completed run.
 *
 * Everything shown here is derived from `PlayResults`, which the engine computes from the score
 * manager, so what the player reads is exactly what was scored (no re-derivation and no chance of
 * the UI disagreeing with the rules).
 *
 * Phase 3 adds the numbers that only make sense once score depends on a difficulty: the difficulty
 * and its weight, the theoretical maximum for *this chart* (note mix × weight) and the stored best
 * for the same song and difficulty. The best is loaded asynchronously (it lives in IndexedDB), so it
 * is written by `showBest` rather than by `render` — and it is only ever compared within one
 * difficulty, because scores earned at different weights are not on the same scale.
 */

import type { PlayResults } from '../game/ScoreManager';
import { difficultyProfile } from '../chart/Difficulty';
import type { ScoreEntry } from '../storage/ScoreStore';
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
  private readonly difficulty = el('result-difficulty');
  private readonly weight = el('result-weight');
  private readonly maxScore = el('result-maxscore');
  private readonly best = el('result-best');

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

    const profile = difficultyProfile(results.difficulty);
    setText(this.difficulty, `${profile.title} (${profile.keys.map((key) => key.label).join(' ')})`);
    setText(this.weight, `×${results.difficultyWeight.toFixed(1)} on every judgment`);
    setText(this.maxScore, results.maxScore.toLocaleString('en-US'));
    // Reset until the stored best arrives (a stale number from the previous run would be a lie).
    setText(this.best, 'checking…');
  }

  /**
   * Write the stored best for this song + difficulty.
   *
   * `isNewBest` is decided by the caller (it needs the previous value), because "you beat your own
   * record" is a fact about the comparison, not about the entry.
   */
  showBest(entry: ScoreEntry | null, isNewBest: boolean): void {
    if (!entry) {
      setText(this.best, 'not stored (scoring is unavailable in this session)');
      return;
    }
    const score = entry.score.toLocaleString('en-US');
    setText(
      this.best,
      isNewBest
        ? `${score} · ${formatPercent(entry.accuracy)} · ${entry.grade} — new best!`
        : `${score} · ${formatPercent(entry.accuracy)} · ${entry.grade}`,
    );
  }
}
