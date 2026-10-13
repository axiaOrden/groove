import { describe, expect, it } from 'vitest';
import { DEFAULT_SCORE_RULES, gradeForAccuracy, isComboIncreasing } from '../src/game/GameConfig';
import { perfectRunScore } from '../src/chart/ScoreModel';
import { ScoreManager } from '../src/game/ScoreManager';

describe('combo rules', () => {
  it('PERFECT and GOOD increase combo, BAD and MISS reset it', () => {
    const score = new ScoreManager();
    score.awardHead('perfect');
    expect(score.combo).toBe(1);
    score.awardHead('good');
    expect(score.combo).toBe(2);
    score.awardHead('bad');
    expect(score.combo).toBe(0);
    score.awardHead('perfect');
    score.awardHead('perfect');
    expect(score.combo).toBe(2);
    score.awardHead('miss');
    expect(score.combo).toBe(0);
    expect(isComboIncreasing('perfect')).toBe(true);
    expect(isComboIncreasing('good')).toBe(true);
    expect(isComboIncreasing('bad')).toBe(false);
    expect(isComboIncreasing('miss')).toBe(false);
  });

  it('tracks max combo across resets', () => {
    const score = new ScoreManager();
    for (let i = 0; i < 7; i += 1) score.awardHead('perfect');
    expect(score.maxCombo).toBe(7);
    score.awardHead('miss');
    for (let i = 0; i < 3; i += 1) score.awardHead('good');
    expect(score.combo).toBe(3);
    expect(score.maxCombo).toBe(7);
  });
});

describe('score values', () => {
  it('awards base points with the combo multiplier of the streak just achieved', () => {
    const score = new ScoreManager();
    expect(score.awardHead('perfect').points).toBe(303); // 300 * (1 + 0.01 * combo 1)
    expect(score.awardHead('good').points).toBe(204); // 200 * 1.02
    expect(score.awardHead('bad').points).toBe(100); // BAD resets combo, so multiplier is 1
    expect(score.awardHead('miss').points).toBe(0);
    expect(score.score).toBe(607);
  });

  it('grows the multiplier by 1% per combo step, capped at 2x', () => {
    const score = new ScoreManager();
    expect(score.multiplierFor(0)).toBeCloseTo(1, 10);
    expect(score.multiplierFor(25)).toBeCloseTo(1.25, 10);
    expect(score.multiplierFor(100)).toBeCloseTo(2, 10);
    expect(score.multiplierFor(500)).toBeCloseTo(2, 10);

    for (let i = 0; i < 100; i += 1) score.awardHead('perfect');
    // 99 hits at increasing multipliers, then the 100th hit at exactly 2x.
    const last = score.awardHead('perfect');
    expect(last.points).toBe(600);
  });

  it('pays a hold in two halves (head + tail) and forfeits the tail on a break', () => {
    const completed = new ScoreManager();
    completed.awardHead('perfect');
    const tail = completed.awardHoldTail('perfect');
    expect(tail).toBe(303);
    expect(completed.score).toBe(606);
    expect(completed.holdCompleted).toBe(1);

    const broken = new ScoreManager();
    broken.awardHead('perfect');
    const before = broken.score;
    broken.registerHoldBreak();
    expect(broken.score).toBe(before); // tail forfeited, head score kept
    expect(broken.holdBroken).toBe(1);
    expect(broken.combo).toBe(0);
  });

  it('does not punish a hold interrupted by pausing', () => {
    const score = new ScoreManager();
    score.awardHead('good');
    score.awardHead('good');
    score.registerInterruptedHold();
    expect(score.combo).toBe(2);
    expect(score.interruptedHolds).toBe(1);
    expect(score.holdBroken).toBe(0);
  });

  it('counts stray presses without scoring them', () => {
    const score = new ScoreManager();
    score.registerStrayPress();
    score.registerStrayPress();
    expect(score.strayPresses).toBe(2);
    expect(score.score).toBe(0);
    expect(score.judgedNotes).toBe(0);
  });
});

describe('accuracy', () => {
  it('is 100% before anything is judged', () => {
    expect(new ScoreManager().accuracy).toBe(1);
  });

  it('weights judgments 300/200/100/0 and ignores combo order', () => {
    const score = new ScoreManager();
    score.awardHead('perfect');
    score.awardHead('good');
    score.awardHead('bad');
    score.awardHead('miss');
    // (300 + 200 + 100 + 0) / (300 * 4)
    expect(score.accuracy).toBeCloseTo(600 / 1200, 10);
    expect(score.judgedNotes).toBe(4);
  });

  it('counts one judgment per note head, whatever the hold outcome', () => {
    const score = new ScoreManager();
    score.awardHead('perfect');
    score.awardHoldTail('perfect');
    score.awardHoldTail('perfect'); // a second tail must not change the denominator
    expect(score.judgedNotes).toBe(1);
  });
});

describe('grades', () => {
  it('maps accuracy to letters at the documented boundaries', () => {
    expect(gradeForAccuracy(1)).toBe('S');
    expect(gradeForAccuracy(0.95)).toBe('S');
    expect(gradeForAccuracy(0.9499)).toBe('A');
    expect(gradeForAccuracy(0.9)).toBe('A');
    expect(gradeForAccuracy(0.8999)).toBe('B');
    expect(gradeForAccuracy(0.8)).toBe('B');
    expect(gradeForAccuracy(0.7999)).toBe('C');
    expect(gradeForAccuracy(0.7)).toBe('C');
    expect(gradeForAccuracy(0.6999)).toBe('D');
    expect(gradeForAccuracy(0.6)).toBe('D');
    expect(gradeForAccuracy(0.5999)).toBe('F');
    expect(gradeForAccuracy(0)).toBe('F');
  });
});

describe('results', () => {
  it('reports the full picture including the theoretical maximum', () => {
    const score = new ScoreManager();
    score.awardHead('perfect');
    score.awardHead('perfect');
    score.awardHead('perfect');
    score.awardHead('bad');
    const results = score.results(4, 12345);

    expect(results.totalNotes).toBe(4);
    expect(results.judgedNotes).toBe(4);
    expect(results.maxCombo).toBe(3);
    expect(results.finishedAtMs).toBe(12345);
    // (300*3 + 100) / (300*4) = 0.8333 -> B
    expect(results.accuracy).toBeCloseTo(0.8333333, 6);
    expect(results.grade).toBe('B');
    // Theoretical maximum: a flawless run of these four notes, from combo 1 up — 303 + 306 + 309 +
    // 312 at weight 1. (It is *not* "four notes at the capped 2× multiplier", which no play can
    // reach; see `perfectRunScore` and PHASE3_1_NOTES.md.)
    expect(results.maxScore).toBe(303 + 306 + 309 + 312);
    expect(results.maxScore).toBe(
      perfectRunScore(
        Array.from({ length: 4 }, (_, index) => ({ timeMs: index * 1000, lane: 0, type: 'tap' as const })),
        1,
      ),
    );
    expect(results.counts).toEqual({ perfect: 3, good: 0, bad: 1, miss: 0 });
  });
});
