/**
 * High-score storage: **separate per song and per difficulty**, versioned on the way in and out.
 *
 * Why a separate store rather than a field on the song record:
 *
 *   - scores change far more often than a chart does (every play), so writing one must not rewrite
 *     the chart and the analysis metadata;
 *   - a score is *per difficulty*, and the difficulty set is exactly what phase 3 added;
 *   - `songs` stays the import-side record of what was analysed, and this store is the play-side
 *     record of how it went.
 *
 * **Versioning, and why weights are stored rather than re-derived.** Difficulty weights are
 * configuration: they can be retuned in a later build. A score earned at weight 1.0 must not be
 * silently rescaled to 2.0 by a display that multiplies the stored number, so every entry records
 * `scoreVersion`, the `difficultyWeight` it was earned with and the `generatorVersion` of the chart
 * it was earned on. Comparison happens only *within* one difficulty (the picker never puts an Easy
 * score next to a Hard one), which is the honest way to compare runs scored under different weights.
 * Entries written by a newer build — or a nonsense entry — are refused on read rather than guessed
 * at (`ScoreRecordError`), exactly like `SongRecord`.
 *
 * The store keeps the **best** run per (song, difficulty) and the total number of attempts. Keeping
 * every attempt would grow without bound for a player who likes one song; the last result is still
 * shown on the results screen (it just is not persisted).
 */

import type { ChartDifficulty } from '../chart/Difficulty';
import { isChartDifficulty } from '../chart/Difficulty';
import type { Grade } from '../chart/ScoreModel';

/** Bumped when the stored shape changes; a newer version is refused with a readable message. */
export const SCORE_RECORD_VERSION = 1;

export interface ScoreEntry {
  /** Shape version of this entry. */
  scoreVersion: number;
  /** `${songId}::${difficulty}` — the IndexedDB key. */
  key: string;
  songId: string;
  title: string;
  difficulty: ChartDifficulty;
  /** Score multiplier the run was played at, stored so a later retune cannot rewrite history. */
  difficultyWeight: number;
  /** Generator version of the chart, so a score on an older chart can be spotted. */
  generatorVersion: string;
  score: number;
  maxScore: number;
  accuracy: number;
  grade: Grade;
  maxCombo: number;
  totalNotes: number;
  recordedAt: string;
}

export interface ScoreSubmission {
  songId: string;
  title: string;
  difficulty: ChartDifficulty;
  difficultyWeight: number;
  generatorVersion: string;
  score: number;
  maxScore: number;
  accuracy: number;
  grade: Grade;
  maxCombo: number;
  totalNotes: number;
  recordedAt?: string;
}

export class ScoreRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScoreRecordError';
  }
}

export function scoreKey(songId: string, difficulty: ChartDifficulty): string {
  return `${songId}::${difficulty}`;
}

export interface ScoreStore {
  readonly kind: 'indexeddb' | 'memory';
  /** Best entry for a song + difficulty, or null when it has never been played. */
  best(songId: string, difficulty: ChartDifficulty): Promise<ScoreEntry | null>;
  /** All entries for one song, in difficulty order. */
  forSong(songId: string): Promise<ScoreEntry[]>;
  /**
   * Record a run: keeps it when it beats the stored best, and counts the attempt either way.
   * Returns the (possibly unchanged) best entry plus whether this run was a new best.
   */
  submit(submission: ScoreSubmission): Promise<{ entry: ScoreEntry; isBest: boolean; attempts: number }>;
  /** Attempts recorded for a song + difficulty. */
  attempts(songId: string, difficulty: ChartDifficulty): Promise<number>;
  /** Forget every score of a song (used when the song is deleted from the library). */
  removeSong(songId: string): Promise<void>;
}

interface AttemptRecord {
  attempts: number;
  lastPlayedAt: string;
}

export function encodeScoreEntry(entry: ScoreEntry): string {
  return JSON.stringify(entry);
}

/**
 * Parse and validate an untrusted entry. Throws `ScoreRecordError` with a message that can be
 * shown to the player (or, more usually, logged and skipped while listing).
 */
export function decodeScoreEntry(value: unknown): ScoreEntry | null {
  const parsed = typeof value === 'string' ? safeParse(value) : value;
  if (typeof parsed !== 'object' || parsed === null) return null;
  const entry = parsed as Partial<ScoreEntry>;
  if (typeof entry.scoreVersion !== 'number') return null;
  if (entry.scoreVersion > SCORE_RECORD_VERSION) {
    throw new ScoreRecordError(
      `This score was saved by a newer version of the game (score v${entry.scoreVersion}, ` +
        `this build understands v${SCORE_RECORD_VERSION}).`,
    );
  }
  if (typeof entry.songId !== 'string' || entry.songId.length === 0) return null;
  if (!isChartDifficulty(entry.difficulty)) return null;
  if (!Number.isFinite(entry.score) || (entry.score ?? -1) < 0) return null;
  return {
    scoreVersion: entry.scoreVersion,
    key: typeof entry.key === 'string' ? entry.key : scoreKey(entry.songId, entry.difficulty),
    songId: entry.songId,
    title: typeof entry.title === 'string' ? entry.title : 'Unknown',
    difficulty: entry.difficulty,
    // A pre-phase-3 entry (there is none in the wild, but the shape allows it) is treated as weight
    // 1: that is what a score with no weight was actually played at.
    difficultyWeight: Number.isFinite(entry.difficultyWeight) ? (entry.difficultyWeight as number) : 1,
    generatorVersion: typeof entry.generatorVersion === 'string' ? entry.generatorVersion : 'unknown',
    score: entry.score as number,
    maxScore: Number.isFinite(entry.maxScore) ? (entry.maxScore as number) : 0,
    accuracy: Number.isFinite(entry.accuracy) ? (entry.accuracy as number) : 0,
    grade: (entry.grade ?? 'F') as Grade,
    maxCombo: Number.isFinite(entry.maxCombo) ? (entry.maxCombo as number) : 0,
    totalNotes: Number.isFinite(entry.totalNotes) ? (entry.totalNotes as number) : 0,
    recordedAt: typeof entry.recordedAt === 'string' ? entry.recordedAt : new Date().toISOString(),
  };
}

export function entryFromSubmission(
  submission: ScoreSubmission,
  now: () => Date = () => new Date(),
): ScoreEntry {
  return {
    scoreVersion: SCORE_RECORD_VERSION,
    key: scoreKey(submission.songId, submission.difficulty),
    songId: submission.songId,
    title: submission.title,
    difficulty: submission.difficulty,
    difficultyWeight: submission.difficultyWeight,
    generatorVersion: submission.generatorVersion,
    score: submission.score,
    maxScore: submission.maxScore,
    accuracy: submission.accuracy,
    grade: submission.grade,
    maxCombo: submission.maxCombo,
    totalNotes: submission.totalNotes,
    recordedAt: submission.recordedAt ?? now().toISOString(),
  };
}

/** Shared "keep the best" rule: higher score wins; ties go to the more accurate run. */
export function isBetterEntry(candidate: ScoreEntry, current: ScoreEntry | null): boolean {
  if (current === null) return true;
  if (candidate.score !== current.score) return candidate.score > current.score;
  return candidate.accuracy > current.accuracy;
}

/** In-memory store: the fallback when IndexedDB is unavailable, and what the tests use. */
export class MemoryScoreStore implements ScoreStore {
  readonly kind = 'memory' as const;
  private readonly entries = new Map<string, string>();
  private readonly attemptCounts = new Map<string, AttemptRecord>();

  async best(songId: string, difficulty: ChartDifficulty): Promise<ScoreEntry | null> {
    const raw = this.entries.get(scoreKey(songId, difficulty));
    return raw === undefined ? null : decodeScoreEntry(raw);
  }

  async forSong(songId: string): Promise<ScoreEntry[]> {
    const out: ScoreEntry[] = [];
    for (const raw of this.entries.values()) {
      const entry = decodeScoreEntry(raw);
      if (entry && entry.songId === songId) out.push(entry);
    }
    return out.sort((a, b) => a.difficulty.localeCompare(b.difficulty));
  }

  async submit(submission: ScoreSubmission): Promise<{ entry: ScoreEntry; isBest: boolean; attempts: number }> {
    const entry = entryFromSubmission(submission);
    const current = await this.best(submission.songId, submission.difficulty);
    const isBest = isBetterEntry(entry, current);
    if (isBest) this.entries.set(entry.key, encodeScoreEntry(entry));
    const attempts = await this.bumpAttempts(submission);
    return { entry: isBest ? entry : (current as ScoreEntry), isBest, attempts };
  }

  async attempts(songId: string, difficulty: ChartDifficulty): Promise<number> {
    return this.attemptCounts.get(scoreKey(songId, difficulty))?.attempts ?? 0;
  }

  async removeSong(songId: string): Promise<void> {
    for (const key of [...this.entries.keys()]) {
      const entry = decodeScoreEntry(this.entries.get(key)!);
      if (entry?.songId === songId) this.entries.delete(key);
    }
    for (const key of [...this.attemptCounts.keys()]) {
      if (key.startsWith(`${songId}::`)) this.attemptCounts.delete(key);
    }
  }

  private async bumpAttempts(submission: ScoreSubmission): Promise<number> {
    const key = scoreKey(submission.songId, submission.difficulty);
    const record = this.attemptCounts.get(key);
    const attempts = (record?.attempts ?? 0) + 1;
    this.attemptCounts.set(key, { attempts, lastPlayedAt: submission.recordedAt ?? new Date().toISOString() });
    return attempts;
  }
}

/**
 * IndexedDB store, sharing the library database (`seven-keys`) but not the record shape: `songs`
 * holds what was imported, `scores` holds how it went, `score-attempts` counts tries.
 *
 * The three object stores are created in the same `onupgradeneeded` handler as the song stores (see
 * `SongLibrary.openSongLibrary`), so upgrading an existing database creates them in place and no
 * song or chart is touched by the version bump.
 */
export const SCORES_STORE = 'scores';
export const SCORE_ATTEMPTS_STORE = 'score-attempts';

export class IndexedDbScoreStore implements ScoreStore {
  readonly kind = 'indexeddb' as const;

  constructor(private readonly db: IDBDatabase) {}

  async best(songId: string, difficulty: ChartDifficulty): Promise<ScoreEntry | null> {
    const key = scoreKey(songId, difficulty);
    const raw = await this.getStore(SCORES_STORE, (store) => store.get(key) as IDBRequest<unknown>);
    return raw === undefined ? null : decodeScoreEntry(raw);
  }

  async forSong(songId: string): Promise<ScoreEntry[]> {
    const all = await this.getStore(SCORES_STORE, (store) => store.getAll() as IDBRequest<unknown[]>);
    const out: ScoreEntry[] = [];
    for (const raw of all) {
      const entry = decodeScoreEntry(raw);
      if (entry && entry.songId === songId) out.push(entry);
    }
    return out.sort((a, b) => a.difficulty.localeCompare(b.difficulty));
  }

  async submit(submission: ScoreSubmission): Promise<{ entry: ScoreEntry; isBest: boolean; attempts: number }> {
    const entry = entryFromSubmission(submission);
    const current = await this.best(submission.songId, submission.difficulty);
    const isBest = isBetterEntry(entry, current);
    if (isBest) {
      await this.transact([SCORES_STORE], 'readwrite', (tx) => {
        tx.objectStore(SCORES_STORE).put(entry);
      });
    }
    const attempts = await this.bumpAttempts(submission);
    return { entry: isBest ? entry : (current as ScoreEntry), isBest, attempts };
  }

  async attempts(songId: string, difficulty: ChartDifficulty): Promise<number> {
    const raw = await this.getStore(
      SCORE_ATTEMPTS_STORE,
      (store) => store.get(scoreKey(songId, difficulty)) as IDBRequest<AttemptRecord | undefined>,
    );
    return raw?.attempts ?? 0;
  }

  async removeSong(songId: string): Promise<void> {
    const all = await this.getStore(SCORES_STORE, (store) => store.getAllKeys() as IDBRequest<IDBValidKey[]>);
    const attempts = await this.getStore(
      SCORE_ATTEMPTS_STORE,
      (store) => store.getAllKeys() as IDBRequest<IDBValidKey[]>,
    );
    const doomedScores = all.filter((key) => String(key).startsWith(`${songId}::`));
    const doomedAttempts = attempts.filter((key) => String(key).startsWith(`${songId}::`));
    if (doomedScores.length === 0 && doomedAttempts.length === 0) return;
    await this.transact([SCORES_STORE, SCORE_ATTEMPTS_STORE], 'readwrite', (tx) => {
      const scoreStore = tx.objectStore(SCORES_STORE);
      for (const key of doomedScores) scoreStore.delete(key);
      const attemptStore = tx.objectStore(SCORE_ATTEMPTS_STORE);
      for (const key of doomedAttempts) attemptStore.delete(key);
    });
  }

  private async bumpAttempts(submission: ScoreSubmission): Promise<number> {
    const key = scoreKey(submission.songId, submission.difficulty);
    const current = await this.getStore(
      SCORE_ATTEMPTS_STORE,
      (store) => store.get(key) as IDBRequest<AttemptRecord | undefined>,
    );
    const attempts = (current?.attempts ?? 0) + 1;
    await this.transact([SCORE_ATTEMPTS_STORE], 'readwrite', (tx) => {
      tx.objectStore(SCORE_ATTEMPTS_STORE).put({
        key,
        attempts,
        lastPlayedAt: submission.recordedAt ?? new Date().toISOString(),
      });
    });
    return attempts;
  }

  private async getStore<T>(
    name: string,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const tx = this.db.transaction(name, 'readonly');
    const result = await requestToPromise(run(tx.objectStore(name)));
    await transactionDone(tx);
    return result;
  }

  private async transact(
    names: string[],
    mode: IDBTransactionMode,
    run: (tx: IDBTransaction) => void,
  ): Promise<void> {
    const tx = this.db.transaction(names, mode);
    run(tx);
    await transactionDone(tx);
  }
}

export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
