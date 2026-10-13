/**
 * LanePressTracker — who currently holds each lane.
 *
 * Phase 1 had a single input source (the keyboard), so a lane could simply be a member of a
 * `Set<number>`. Phase 1.5 adds touch, and with touch a lane can legitimately be held by more
 * than one thing at once:
 *
 *   - two fingers on the same lane (the wide pads make that easy to do by accident),
 *   - a key and a finger on the same lane,
 *   - a finger still down when the other finger is lifted.
 *
 * So lane state is a *set of sources* per lane, keyed by a stable string id:
 *
 *   keyboard -> `key:KeyA`   (one source per physical key, i.e. per lane)
 *   pointer  -> `pointer:17` (one source per touch/pointer id)
 *
 * Invariants this class exists to enforce:
 *
 *   1. A lane is *down* while at least one source holds it, and goes *up* exactly when the
 *      last holder releases. Releasing one finger therefore cannot release another finger's
 *      lane.
 *   2. A source holds at most one lane and never migrates: a second `acquire` for a source
 *      that is already down is reported as `duplicate` and changes nothing. This is the
 *      duplicate-press guard (OS key auto-repeat, a re-sent keydown, a double pointerdown).
 *   3. Every transition is reported exactly once, so callers can rely on press/release pairs
 *      when driving visual feedback.
 *
 * It contains no DOM, no timers and no audio knowledge, which is what makes the whole
 * touch-input contract testable in Node.
 */

export type LaneSourceKind = 'keyboard' | 'pointer';

export interface LaneRelease {
  lane: number;
  /** The source that caused the lane to go up. */
  sourceId: string;
  /** Remaining holders of the lane after this release (normally empty). */
  remaining: number;
}

export type AcquireResult =
  /** The lane went from up to down: emit a press. */
  | 'pressed'
  /** The lane was already held (by this source or another): emit nothing. */
  | 'duplicate';

export class LanePressTracker {
  /** lane -> set of source ids currently holding it. */
  private readonly holders: Array<Set<string>>;
  /** source id -> lane it holds. */
  private readonly lanes = new Map<string, number>();

  constructor(readonly laneCount = 7) {
    this.holders = Array.from({ length: laneCount }, () => new Set<string>());
  }

  /** `key:KeyA` / `pointer:3` — the naming scheme is part of the debug output. */
  static keyboardSource(code: string): string {
    return `key:${code}`;
  }

  static pointerSource(pointerId: number): string {
    return `pointer:${pointerId}`;
  }

  /**
   * Register a source holding a lane. Returns `pressed` only for the transition the caller
   * should turn into a note judgment.
   */
  acquire(lane: number, sourceId: string): AcquireResult {
    if (!this.isValidLane(lane)) return 'duplicate';
    if (this.lanes.has(sourceId)) return 'duplicate';
    const set = this.holders[lane]!;
    const wasUp = set.size === 0;
    set.add(sourceId);
    this.lanes.set(sourceId, lane);
    return wasUp ? 'pressed' : 'duplicate';
  }

  /**
   * Release whatever lane a source holds. Returns the release when the lane became free, or
   * null when the source was unknown (a stale pointer up after focus loss, a repeated keyup)
   * or another source still holds the lane.
   */
  release(sourceId: string): LaneRelease | null {
    const lane = this.lanes.get(sourceId);
    if (lane === undefined) return null;
    this.lanes.delete(sourceId);
    const set = this.holders[lane]!;
    set.delete(sourceId);
    if (set.size > 0) return null;
    return { lane, sourceId, remaining: 0 };
  }

  /** Release every source on one lane (used when a lane's pad is torn down). */
  releaseLane(lane: number): LaneRelease[] {
    const set = this.holders[lane];
    if (!set || set.size === 0) return [];
    const sources = [...set];
    const releases: LaneRelease[] = [];
    for (const sourceId of sources) {
      const release = this.release(sourceId);
      if (release) releases.push(release);
    }
    return releases;
  }

  /**
   * Drop every source. Returns the lanes that were down, in lane order, so the caller can
   * clear visual state. Used on blur, tab hide, pause and orientation change — without a
   * keyup/pointerup the game would otherwise believe a hold is still being held.
   */
  releaseAll(): number[] {
    const down = this.pressedLanes();
    this.lanes.clear();
    for (const set of this.holders) set.clear();
    return down;
  }

  isDown(lane: number): boolean {
    return !this.isValidLane(lane) ? false : this.holders[lane]!.size > 0;
  }

  /** Lanes currently held by at least one source, in lane order. */
  pressedLanes(): number[] {
    const lanes: number[] = [];
    for (let lane = 0; lane < this.holders.length; lane += 1) {
      if (this.isDown(lane)) lanes.push(lane);
    }
    return lanes;
  }

  sourcesOn(lane: number): string[] {
    if (!this.isValidLane(lane)) return [];
    return [...this.holders[lane]!];
  }

  laneOf(sourceId: string): number | null {
    const lane = this.lanes.get(sourceId);
    return lane === undefined ? null : lane;
  }

  get activeSourceCount(): number {
    return this.lanes.size;
  }

  isValidLane(lane: number): boolean {
    return Number.isInteger(lane) && lane >= 0 && lane < this.holders.length;
  }
}
