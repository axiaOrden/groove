/**
 * GameEngine — the rules layer.
 *
 * Responsibilities:
 *   - own the runtime notes and their per-note state machine,
 *   - turn (lane, song time) input events and clock ticks into judgments,
 *   - auto-resolve notes the player never hit, exactly once, in chart order,
 *   - settle holds (completed / broken / interrupted by pause),
 *   - report a finished run.
 *
 * It has no dependency on Three.js, Web Audio or the DOM: the only external input is a
 * `SongClock` plus timestamped lane presses. That is what makes the rules unit-testable with
 * a fake clock, and what guarantees "rendering FPS cannot change scoring" — this class never
 * sees a frame.
 *
 * Offset convention (see GameConfig): `judgeTimeMs = songTimeMs - globalOffsetMs` is applied
 * to every judgment and miss deadline identically, so presses and note windows always move
 * together. Note times already include the chart's own `offsetMs`.
 */

import type { Beatmap, TimingWindows } from '../chart/ChartTypes';
import type { JudgmentType, ScoreRules } from './GameConfig';
import { DEFAULT_SCORE_RULES, DEFAULT_TIMING_WINDOWS } from './GameConfig';
import type { RuntimeNote, NoteStatus } from './JudgmentEngine';
import { classifyTiming, createRuntimeNotes } from './JudgmentEngine';
import type { PlayResults } from './ScoreManager';
import { ScoreManager } from './ScoreManager';
import type { SongClock } from '../audio/AudioSource';

export type GamePhase = 'ready' | 'playing' | 'paused' | 'finished';

export type GameEvent =
  | {
      type: 'judgment';
      lane: number;
      judgment: JudgmentType;
      /** Signed timing error in ms (negative = early). Null for auto-misses. */
      errorMs: number | null;
      points: number;
      combo: number;
      noteIndex: number;
      noteStatus: NoteStatus;
    }
  | { type: 'stray-press'; lane: number }
  | { type: 'hold-complete'; lane: number; noteIndex: number; points: number }
  | { type: 'hold-broken'; lane: number; noteIndex: number; releasedAtMs: number }
  | { type: 'interrupted-hold'; lane: number; noteIndex: number }
  | { type: 'finished'; results: PlayResults };

export interface GameEngineOptions {
  chart: Beatmap;
  clock: SongClock;
  windows?: TimingWindows;
  rules?: ScoreRules;
  globalOffsetMs?: number;
}

/** Let the final chord ring out this long after the last note before showing results. */
export const FINISH_TAIL_MS = 1000;

const FULLY_RESOLVED: ReadonlySet<NoteStatus> = new Set<NoteStatus>([
  'hit',
  'completed',
  'broken',
  'missed',
  'interrupted',
]);

export class GameEngine {
  /** Runtime notes, sorted by time. The renderer reads this directly. */
  readonly notes: RuntimeNote[];

  private readonly chart: Beatmap;
  private readonly clock: SongClock;
  private readonly windows: TimingWindows;
  private readonly rules: ScoreRules;
  private readonly lanes: RuntimeNote[][];
  /**
   * Per-lane scan start: the first index that is still `pending`. It only ever advances over
   * notes that are already resolved, so it can never skip a note that still needs judging, and
   * it keeps the per-frame cost proportional to the pending notes rather than to the whole
   * chart (a 2000-note chart costs the same per frame as a 40-note one).
   */
  private readonly laneStart: number[];
  private score: ScoreManager;
  private readonly holding = new Set<RuntimeNote>();
  private readonly pressed: boolean[];
  private readonly events: GameEvent[] = [];
  private readonly chartEndMsValue: number;
  private globalOffsetMs: number;
  private phaseValue: GamePhase = 'ready';
  private lastSongTimeMs = 0;
  private lastJudgeTimeMs = 0;
  private finished = false;
  private pendingValue = 0;

  constructor(options: GameEngineOptions) {
    this.chart = options.chart;
    this.clock = options.clock;
    this.windows = options.windows ?? DEFAULT_TIMING_WINDOWS;
    this.rules = options.rules ?? DEFAULT_SCORE_RULES;
    this.globalOffsetMs = options.globalOffsetMs ?? 0;
    this.score = new ScoreManager(this.rules);

    this.notes = createRuntimeNotes(this.chart.notes, {
      chartOffsetMs: this.chart.offsetMs,
      rules: this.rules,
    });

    this.lanes = Array.from({ length: 7 }, () => []);
    for (const note of this.notes) {
      this.lanes[note.lane]!.push(note);
    }
    this.laneStart = new Array<number>(7).fill(0);
    this.pressed = new Array<boolean>(7).fill(false);
    this.pendingValue = this.notes.length;
    this.chartEndMsValue = this.notes.reduce((max, note) => Math.max(max, note.endTimeMs), 0);
  }

  // ------------------------------------------------------------------ state --

  get phase(): GamePhase {
    return this.phaseValue;
  }

  get globalOffset(): number {
    return this.globalOffsetMs;
  }

  get songTimeMs(): number {
    return this.lastSongTimeMs;
  }

  get judgeTimeMs(): number {
    return this.lastJudgeTimeMs;
  }

  get scoreSnapshot() {
    return this.score.snapshot();
  }

  get totalNotes(): number {
    return this.notes.length;
  }

  /** Notes that still need a head judgment, plus holds that are being held. */
  get pendingNotes(): number {
    return this.pendingValue;
  }

  get chartEndMs(): number {
    return this.chartEndMsValue;
  }

  isLanePressed(lane: number): boolean {
    return this.pressed[lane] === true;
  }

  setGlobalOffsetMs(ms: number): void {
    this.globalOffsetMs = Number.isFinite(ms) ? ms : 0;
  }

  setPhase(phase: GamePhase): void {
    this.phaseValue = phase;
  }

  /** Start judging. Before this, updates and presses are ignored. */
  begin(): void {
    this.phaseValue = 'playing';
    this.lastSongTimeMs = this.clock.getSongTimeMs();
    this.lastJudgeTimeMs = this.lastSongTimeMs - this.globalOffsetMs;
  }

  // ------------------------------------------------------------------ input --

  /**
   * A lane key went down at `songTimeMs`. Judges the closest pending note in the lane whose
   * head is inside the BAD window. A press that matches nothing is a stray press: it is
   * counted for the results screen but never penalised (configurable in phase 2).
   */
  pressLane(lane: number, songTimeMs: number): GameEvent[] {
    if (this.phaseValue === 'paused' || this.phaseValue === 'finished') return this.drainEvents();
    if (this.pressed[lane]) {
      // Duplicate/auto-repeat style event while the key is already down: ignore entirely.
      return this.drainEvents();
    }
    this.pressed[lane] = true;
    this.touchClock(songTimeMs);

    const target = this.findPressTarget(lane, this.lastJudgeTimeMs);
    if (!target) {
      this.score.registerStrayPress();
      this.events.push({ type: 'stray-press', lane });
      return this.drainEvents();
    }

    const errorMs = this.lastJudgeTimeMs - target.timeMs;
    const judgment = classifyTiming(errorMs, this.windows);
    const award = this.score.awardHead(judgment, 1);
    target.headJudgment = judgment;
    target.headErrorMs = errorMs;

    if (target.type === 'tap') {
      target.status = 'hit';
      this.pendingValue -= 1;
    } else {
      target.status = 'holding';
      this.holding.add(target);
    }

    this.events.push({
      type: 'judgment',
      lane,
      judgment,
      errorMs,
      points: award.points,
      combo: award.combo,
      noteIndex: target.index,
      noteStatus: target.status,
    });
    return this.drainEvents();
  }

  /** A lane key went up at `songTimeMs`. Settles an active hold. */
  releaseLane(lane: number, songTimeMs: number): GameEvent[] {
    if (!this.pressed[lane]) return this.drainEvents();
    this.pressed[lane] = false;
    if (this.phaseValue === 'paused' || this.phaseValue === 'finished') return this.drainEvents();
    this.touchClock(songTimeMs);

    const hold = this.activeHold(lane);
    if (!hold) return this.drainEvents();

    if (this.lastJudgeTimeMs >= hold.endTimeMs - this.rules.holdReleaseGraceMs) {
      this.completeHold(hold, lane);
    } else {
      this.breakHold(hold, lane, this.lastJudgeTimeMs);
    }
    return this.drainEvents();
  }

  /** Release every lane without judging (focus loss, pause, seek). */
  releaseAllLanes(reason: 'pause' | 'seek' | 'blur'): GameEvent[] {
    for (const note of [...this.holding]) {
      if (reason === 'pause') {
        note.status = 'interrupted';
        this.score.registerInterruptedHold();
        this.events.push({ type: 'interrupted-hold', lane: note.lane, noteIndex: note.index });
      } else {
        // A seek or focus loss forfeits the tail without breaking combo.
        note.status = 'interrupted';
        this.score.registerInterruptedHold();
      }
      this.holding.delete(note);
      this.pendingValue -= 1;
    }
    this.pressed.fill(false);
    return this.drainEvents();
  }

  // ------------------------------------------------------------------- tick --

  /**
   * Advance the clock. Called once per rendered frame, but its behaviour depends only on the
   * song time it reads, so calling it more or less often changes nothing except how quickly
   * misses are noticed (still exact, because the deadline is derived from the clock).
   */
  update(nowMs?: number): GameEvent[] {
    if (this.phaseValue === 'ready' || this.phaseValue === 'paused' || this.phaseValue === 'finished') {
      return this.drainEvents();
    }

    const songTimeMs = nowMs ?? this.clock.getSongTimeMs();
    this.touchClock(songTimeMs);

    // Auto-miss: notes whose head is past the BAD window and were never pressed.
    for (let lane = 0; lane < this.lanes.length; lane += 1) {
      const notes = this.lanes[lane]!;
      const start = this.advanceLaneStart(lane);
      for (let i = start; i < notes.length; i += 1) {
        const note = notes[i]!;
        if (note.status !== 'pending') continue;
        if (this.lastJudgeTimeMs <= note.timeMs + this.windows.badMs) break;
        note.status = 'missed';
        note.headJudgment = 'miss';
        note.headErrorMs = null;
        this.pendingValue -= 1;
        const award = this.score.awardHead('miss', 1);
        this.events.push({
          type: 'judgment',
          lane,
          judgment: 'miss',
          errorMs: null,
          points: award.points,
          combo: award.combo,
          noteIndex: note.index,
          noteStatus: note.status,
        });
      }
    }

    // Holds that reached their tail while the key is still down.
    for (const note of [...this.holding]) {
      if (this.lastJudgeTimeMs >= note.endTimeMs - this.rules.holdReleaseGraceMs) {
        this.completeHold(note, note.lane);
      }
    }

    this.checkFinished();
    return this.drainEvents();
  }

  // ------------------------------------------------------------------- flow --

  /** Pause: freeze the run, forfeit hold tails without penalty. */
  pause(): GameEvent[] {
    if (this.phaseValue !== 'playing') return this.drainEvents();
    const events = this.releaseAllLanes('pause');
    this.phaseValue = 'paused';
    return events;
  }

  resume(): void {
    if (this.phaseValue === 'paused') {
      this.phaseValue = 'playing';
      this.pressed.fill(false);
    }
  }

  /**
   * Move the playhead (debug tooling today, chart editor preview in phase 4). Notes skipped
   * over resolve as misses on the next `update`; already judged notes stay judged.
   */
  seekTo(songTimeMs: number): GameEvent[] {
    const events = this.releaseAllLanes('seek');
    this.lastSongTimeMs = songTimeMs;
    this.lastJudgeTimeMs = songTimeMs - this.globalOffsetMs;
    return events;
  }

  /** Rebuild all runtime state from the chart. */
  reset(): void {
    this.notes.splice(
      0,
      this.notes.length,
      ...createRuntimeNotes(this.chart.notes, { chartOffsetMs: this.chart.offsetMs, rules: this.rules }),
    );
    this.lanes.forEach((lane) => (lane.length = 0));
    for (const note of this.notes) this.lanes[note.lane]!.push(note);
    this.holding.clear();
    this.pressed.fill(false);
    this.laneStart.fill(0);
    this.events.length = 0;
    this.pendingValue = this.notes.length;
    this.phaseValue = 'ready';
    this.finished = false;
    this.lastSongTimeMs = 0;
    this.lastJudgeTimeMs = 0;
    this.score = new ScoreManager(this.rules);
  }

  getResults(): PlayResults {
    return this.score.results(this.notes.length, this.lastSongTimeMs);
  }

  // ---------------------------------------------------------------- internal --

  private touchClock(songTimeMs: number): void {
    this.lastSongTimeMs = songTimeMs;
    this.lastJudgeTimeMs = songTimeMs - this.globalOffsetMs;
    if (this.phaseValue === 'ready') this.phaseValue = 'playing';
  }

  private advanceLaneStart(lane: number): number {
    const notes = this.lanes[lane];
    if (!notes) return 0;
    let start = this.laneStart[lane]!;
    while (start < notes.length && notes[start]!.status !== 'pending') start += 1;
    this.laneStart[lane] = start;
    return start;
  }

  private findPressTarget(lane: number, judgeTimeMs: number): RuntimeNote | null {
    const notes = this.lanes[lane];
    if (!notes) return null;
    let best: RuntimeNote | null = null;
    let bestAbs = Number.POSITIVE_INFINITY;
    const start = this.advanceLaneStart(lane);

    for (let i = start; i < notes.length; i += 1) {
      const note = notes[i]!;
      if (note.status !== 'pending') continue;
      const error = judgeTimeMs - note.timeMs;
      if (error < -this.windows.badMs) break; // sorted: every later note is even earlier
      if (error > this.windows.badMs) continue; // too late; `update` will miss it
      const abs = Math.abs(error);
      if (abs <= bestAbs) {
        best = note;
        bestAbs = abs;
      }
    }
    return best;
  }

  private activeHold(lane: number): RuntimeNote | null {
    for (const note of this.holding) {
      if (note.lane === lane) return note;
    }
    return null;
  }

  private completeHold(note: RuntimeNote, lane: number): void {
    note.status = 'completed';
    this.holding.delete(note);
    this.pendingValue -= 1;
    const points = this.score.awardHoldTail(note.headJudgment ?? 'perfect', this.rules.holdWeight - 1);
    this.events.push({ type: 'hold-complete', lane, noteIndex: note.index, points });
  }

  private breakHold(note: RuntimeNote, lane: number, releasedAtMs: number): void {
    note.status = 'broken';
    note.releasedEarly = true;
    this.holding.delete(note);
    this.pendingValue -= 1;
    this.score.registerHoldBreak();
    this.events.push({ type: 'hold-broken', lane, noteIndex: note.index, releasedAtMs });
  }

  private checkFinished(): void {
    if (this.finished) return;
    if (this.pendingValue > 0) return;
    // Wait for the outro to ring out so results do not pop up on the final note.
    if (this.lastJudgeTimeMs < this.chartEndMsValue + FINISH_TAIL_MS) return;
    this.finished = true;
    this.phaseValue = 'finished';
    this.events.push({ type: 'finished', results: this.getResults() });
  }

  drainEvents(): GameEvent[] {
    if (this.events.length === 0) return [];
    return this.events.splice(0, this.events.length);
  }

  /** True when a note can no longer change state. */
  static isResolved(note: RuntimeNote): boolean {
    return FULLY_RESOLVED.has(note.status);
  }
}
