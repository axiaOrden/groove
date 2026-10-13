/**
 * PlaybackTimeline — the authoritative song clock, as pure arithmetic.
 *
 * The whole game derives note positions and judgments from this one function of the audio
 * context clock. Frame deltas are never accumulated anywhere, so render frame rate cannot
 * influence scoring.
 *
 *   songTimeMs(ctxSec) = anchorSongMs + (ctxSec - anchorCtxSec) * 1000
 *
 * Three states:
 *   idle    nothing loaded; song time is a constant.
 *   running anchored at (anchorSongMs, anchorCtxSec); song time may legitimately be
 *           **negative** during a count-in (song time 0 is the first audio sample).
 *   frozen  the clock is pinned to `frozenSongMs` (pause) until `resumeCtxSec`, after which
 *           the running formula above takes over. `anchorCtxSec === resumeCtxSec` by
 *           construction, so resuming is seamless: no jump, no accumulated drift.
 *
 * Because the state is a closed-form function of the context clock, "pause does not
 * desynchronise the chart" is a property that can be unit tested without any Web Audio.
 */

export type TimelineMode = 'idle' | 'running' | 'frozen';

export interface TimelineSnapshot {
  mode: TimelineMode;
  anchorSongMs: number;
  anchorCtxSec: number;
  frozenSongMs: number;
  resumeCtxSec: number | null;
}

export class PlaybackTimeline {
  private mode: TimelineMode = 'idle';
  private anchorSongMs = 0;
  private anchorCtxSec = 0;
  private frozenSongMs = 0;
  private resumeCtxSec: number | null = null;

  /**
   * Begin playing `songTimeMs` at context time `anchorCtxSec`. Song time before the anchor
   * simply extrapolates, which is how a count-in is expressed: an anchor of
   * (0ms, now + 1.2s) means the song starts in 1.2 s and time runs from -1200 ms.
   */
  start(songTimeMs: number, anchorCtxSec: number): void {
    this.mode = 'running';
    this.anchorSongMs = songTimeMs;
    this.anchorCtxSec = anchorCtxSec;
    this.frozenSongMs = songTimeMs;
    this.resumeCtxSec = null;
  }

  /** Pin the clock (pause). `songTimeMs` is normally the value just read from `getSongTimeMs`. */
  freeze(songTimeMs: number, ctxSec: number): void {
    this.mode = 'frozen';
    this.frozenSongMs = songTimeMs;
    this.anchorSongMs = songTimeMs;
    this.anchorCtxSec = ctxSec;
    this.resumeCtxSec = null;
  }

  /**
   * Hold the clock at `songTimeMs` until `resumeCtxSec`, then run from `songTimeMs` at real
   * speed. Used by "resume with count-in": audio is scheduled to start exactly at the anchor,
   * so the first note after the pause keeps its original wall-clock relationship.
   */
  resumeAt(songTimeMs: number, resumeCtxSec: number): void {
    this.mode = 'frozen';
    this.frozenSongMs = songTimeMs;
    this.anchorSongMs = songTimeMs;
    this.anchorCtxSec = resumeCtxSec;
    this.resumeCtxSec = resumeCtxSec;
  }

  reset(): void {
    this.mode = 'idle';
    this.anchorSongMs = 0;
    this.anchorCtxSec = 0;
    this.frozenSongMs = 0;
    this.resumeCtxSec = null;
  }

  getSongTimeMs(ctxSec: number): number {
    if (this.mode === 'idle') return this.frozenSongMs;
    if (this.mode === 'running') {
      return this.anchorSongMs + (ctxSec - this.anchorCtxSec) * 1000;
    }
    if (this.resumeCtxSec !== null && ctxSec >= this.resumeCtxSec) {
      return this.anchorSongMs + (ctxSec - this.anchorCtxSec) * 1000;
    }
    return this.frozenSongMs;
  }

  /** True when time is actually advancing at `ctxSec` (used to gate audio/state changes). */
  isRunning(ctxSec: number): boolean {
    if (this.mode === 'running') return true;
    return this.mode === 'frozen' && this.resumeCtxSec !== null && ctxSec >= this.resumeCtxSec;
  }

  snapshot(): TimelineSnapshot {
    return {
      mode: this.mode,
      anchorSongMs: this.anchorSongMs,
      anchorCtxSec: this.anchorCtxSec,
      frozenSongMs: this.frozenSongMs,
      resumeCtxSec: this.resumeCtxSec,
    };
  }
}
