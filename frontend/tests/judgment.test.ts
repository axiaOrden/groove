import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMING_WINDOWS } from '../src/game/GameConfig';
import { classifyTiming, isJudgeable } from '../src/game/JudgmentEngine';

describe('judgment windows', () => {
  it('uses the documented defaults', () => {
    expect(DEFAULT_TIMING_WINDOWS).toEqual({ perfectMs: 45, goodMs: 100, badMs: 160 });
  });

  it('treats each boundary as inclusive (PERFECT <= 45, GOOD <= 100, BAD <= 160)', () => {
    const cases: Array<[number, string]> = [
      [0, 'perfect'],
      [45, 'perfect'],
      [-45, 'perfect'],
      [45.4, 'good'],
      [46, 'good'],
      [100, 'good'],
      [-100, 'good'],
      [100.4, 'bad'],
      [101, 'bad'],
      [160, 'bad'],
      [-160, 'bad'],
      [160.4, 'miss'],
      [161, 'miss'],
      [-500, 'miss'],
      [Number.POSITIVE_INFINITY, 'miss'],
    ];

    for (const [error, expected] of cases) {
      expect(classifyTiming(error), `error ${error}ms`).toBe(expected);
    }
  });

  it('is symmetric for early and late input', () => {
    for (const magnitude of [0, 10, 45, 60, 100, 120, 160]) {
      expect(classifyTiming(magnitude)).toBe(classifyTiming(-magnitude));
    }
  });

  it('reports judgeability inside the BAD window only', () => {
    expect(isJudgeable(160)).toBe(true);
    expect(isJudgeable(-160)).toBe(true);
    expect(isJudgeable(160.01)).toBe(false);
    expect(isJudgeable(161)).toBe(false);
  });

  it('honours custom windows', () => {
    const tight = { perfectMs: 10, goodMs: 30, badMs: 60 };
    expect(classifyTiming(10, tight)).toBe('perfect');
    expect(classifyTiming(11, tight)).toBe('good');
    expect(classifyTiming(30, tight)).toBe('good');
    expect(classifyTiming(31, tight)).toBe('bad');
    expect(classifyTiming(60, tight)).toBe('bad');
    expect(classifyTiming(61, tight)).toBe('miss');
  });
});
