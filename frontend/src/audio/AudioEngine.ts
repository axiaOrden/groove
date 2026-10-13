/**
 * WebAudioEngine — playback of a decoded AudioBuffer plus the authoritative song clock.
 *
 * Timing model
 * ------------
 * `getSongTimeMs()` is `PlaybackTimeline` evaluated at `AudioContext.currentTime`. Nothing in
 * the gameplay path touches `requestAnimationFrame` deltas, so scoring is independent of the
 * render frame rate. Pausing freezes the timeline exactly where it was and stops the buffer;
 * resuming schedules a *new* AudioBufferSourceNode at the frozen position, which is the same
 * code path phase 2 needs for seeking.
 *
 * Scheduling a start ("count-in")
 * -------------------------------
 * A start is expressed as an anchor: song time `t` occurs exactly at context time
 * `anchorCtxSec`, and the buffer is scheduled to begin at `max(0, t)` seconds of buffer time
 * at the same instant (plus any count-in). Because the timeline extrapolates before the
 * anchor, a count-in is simply "song time is negative" — the renderer therefore shows the
 * first notes approaching while the beeps play, with no special-case code.
 *
 * Hit ticks are synthesised UI feedback (two oscillators and a gain envelope); no audio asset
 * is played for them, and they are independent of the chart's music.
 */

import { PlaybackTimeline } from './PlaybackTimeline';
import type { AudioSourceKind, AudioSourceTimeline, ClockPrecision, SongClock } from './AudioSource';

export interface PlayOptions {
  /** Lead-in before the song position is reached, with count-in beeps. */
  countInMs?: number;
  /** Beat length used to space the count-in beeps. */
  beatMs?: number;
  /** Volume of the count-in beeps (0 disables them). */
  countInVolume?: number;
}

export interface AudioEngineMetrics {
  contextState: string;
  sampleRate: number;
  /** Reported hardware output latency in ms (0 when unsupported). */
  outputLatencyMs: number;
  /** Scheduling look-ahead reported by the context. */
  baseLatencyMs: number;
  /** Wall-clock drift between the audio clock and performance.now() since the last start. */
  driftMs: number;
  durationMs: number;
}

export type TickKind = 'perfect' | 'good' | 'bad' | 'miss' | 'count' | 'count-accent';

const TICK_HZ: Record<TickKind, number> = {
  perfect: 1568,
  good: 1175,
  bad: 784,
  miss: 196,
  count: 880,
  'count-accent': 1320,
};

export class WebAudioEngine implements AudioSourceTimeline, SongClock {
  readonly kind: AudioSourceKind = 'web-audio-buffer';
  readonly clockPrecision: ClockPrecision = 'sample-accurate';
  /** Locally decoded audio is eligible for ranked play once the player has calibrated. */
  readonly rankedEligible = true;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private readonly timeline = new PlaybackTimeline();
  private volume = 0.7;
  private sfxVolume = 0.8;
  private anchorPerfMs = 0;
  private lastPlayError: string | null = null;
  private interruptionHandler: (() => void) | null = null;

  static isSupported(): boolean {
    return typeof window !== 'undefined' && typeof window.AudioContext !== 'undefined';
  }

  /**
   * Create the AudioContext if needed *without* awaiting a resume. Safe to call before a user
   * gesture: the context exists (and reports its sample rate) but stays suspended until the
   * player presses Start, which is what lets the offline demo render at the exact playback
   * sample rate.
   */
  prepareContext(): AudioContext {
    if (!WebAudioEngine.isSupported()) {
      throw new Error('Web Audio API is not available in this browser');
    }
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      // Mobile audio is interrupted (not merely muted) by a call, another app taking focus or
      // the OS suspending the tab. The context leaves 'running' without any action of ours,
      // and in that state the song clock freezes at whatever moment the platform stopped
      // feeding the graph: judgments would be measured against a dead clock, so the game
      // pauses instead.
      this.ctx.addEventListener('statechange', this.handleContextStateChange);
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this.sfx = this.ctx.createGain();
      this.sfx.gain.value = this.sfxVolume;
      this.sfx.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  /** Create (or reuse) the AudioContext and make sure it is running. Call from a gesture. */
  async ensureContext(): Promise<AudioContext> {
    const ctx = this.prepareContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    return ctx;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  get hasAudio(): boolean {
    return this.buffer !== null;
  }

  loadBuffer(buffer: AudioBuffer): void {
    this.buffer = buffer;
    this.stopSource();
    this.timeline.reset();
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    if (this.master) this.master.gain.value = this.volume;
  }

  getVolume(): number {
    return this.volume;
  }

  /**
   * Start (or restart) playback with song time `songTimeMs` anchored at the context clock.
   * `countInMs` delays the audio by that much while `getSongTimeMs()` runs up to the anchor,
   * which is what produces the 3-2-1 lead-in.
   */
  play(songTimeMs: number, options: PlayOptions = {}): void {
    const ctx = this.ctx;
    if (!ctx || !this.buffer) {
      this.lastPlayError = 'play() called before an AudioContext and buffer were available';
      return;
    }
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }

    const countInMs = Math.max(0, options.countInMs ?? 0);
    const beatMs = Math.max(1, options.beatMs ?? 500);
    const countInVolume = options.countInVolume ?? 0.4;

    this.stopSource();

    // Small scheduling safety margin so the first sample is never in the past.
    const anchorCtxSec = ctx.currentTime + 0.05 + countInMs / 1000;
    this.timeline.start(songTimeMs, anchorCtxSec);
    this.anchorPerfMs = performance.now();

    const bufferOffsetSec = Math.max(0, songTimeMs / 1000);
    const leadInSec = Math.max(0, -songTimeMs / 1000);

    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.master ?? ctx.destination);
    source.start(anchorCtxSec + leadInSec, bufferOffsetSec);
    this.source = source;

    if (countInMs > 0 && countInVolume > 0) {
      const beeps = Math.max(1, Math.round(countInMs / beatMs));
      for (let i = 0; i < beeps; i += 1) {
        const at = anchorCtxSec - countInMs / 1000 + (i * beatMs) / 1000;
        const isLast = i === beeps - 1;
        this.scheduleTick(isLast ? 'count-accent' : 'count', at, countInVolume);
      }
    }

    this.lastPlayError = null;
  }

  /** Freeze the clock and stop the buffer. Safe to call repeatedly. */
  pause(): void {
    if (!this.ctx) return;
    this.timeline.freeze(this.timeline.getSongTimeMs(this.ctx.currentTime), this.ctx.currentTime);
    this.stopSource();
  }

  seekAndHold(songTimeMs: number): void {
    if (!this.ctx) {
      this.timeline.freeze(songTimeMs, 0);
      return;
    }
    this.timeline.freeze(songTimeMs, this.ctx.currentTime);
    this.stopSource();
  }

  /** Stop audio and rewind the clock to 0 without starting playback. */
  stop(): void {
    this.stopSource();
    this.timeline.reset();
  }

  getSongTimeMs(): number {
    if (!this.ctx) return this.timeline.getSongTimeMs(0);
    return this.timeline.getSongTimeMs(this.ctx.currentTime);
  }

  getDurationMs(): number {
    return this.buffer ? this.buffer.duration * 1000 : 0;
  }

  isPlaying(): boolean {
    return this.source !== null && this.ctx !== null && this.ctx.state === 'running';
  }

  /**
   * A Web Audio source only stalls if the context itself is not running (for example the tab
   * was throttled). Judgments should be suspended when this returns true.
   */
  isStalled(): boolean {
    if (!this.ctx) return true;
    return this.ctx.state !== 'running';
  }

  getLastError(): string | null {
    return this.lastPlayError;
  }

  /**
   * Called when the audio hardware stops underneath us while a song is playing (phone call,
   * another app taking audio focus, OS tab suspension). The game pauses instead of judging
   * against a frozen clock.
   */
  setInterruptionHandler(handler: (() => void) | null): void {
    this.interruptionHandler = handler;
  }

  metrics(): AudioEngineMetrics {
    const ctx = this.ctx;
    const snapshot = this.timeline.snapshot();
    // Drift is only meaningful once a start anchor exists; before that the context clock has
    // no relationship to performance.now() and the number would be nonsense.
    let driftMs = 0;
    if (ctx && snapshot.mode === 'running') {
      driftMs = (ctx.currentTime - snapshot.anchorCtxSec) * 1000;
      driftMs -= performance.now() - this.anchorPerfMs;
    }
    return {
      contextState: ctx?.state ?? 'none',
      sampleRate: ctx?.sampleRate ?? 0,
      outputLatencyMs: (ctx?.outputLatency ?? 0) * 1000,
      baseLatencyMs: (ctx?.baseLatency ?? 0) * 1000,
      driftMs,
      durationMs: this.getDurationMs(),
    };
  }

  /** Short synthesised UI blip, scheduled immediately. */
  tick(kind: TickKind): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfx) return;
    this.scheduleTick(kind, ctx.currentTime + 0.005, 0.32);
  }

  private scheduleTick(kind: TickKind, whenSec: number, volume: number): void {
    const ctx = this.ctx;
    const out = this.sfx;
    if (!ctx || !out) return;

    const osc = ctx.createOscillator();
    osc.type = kind === 'miss' ? 'square' : 'triangle';
    osc.frequency.value = TICK_HZ[kind];

    const gain = ctx.createGain();
    const duration = kind === 'miss' ? 0.09 : 0.05;
    gain.gain.setValueAtTime(0.0001, whenSec);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), whenSec + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, whenSec + duration);

    osc.connect(gain).connect(out);
    osc.start(whenSec);
    osc.stop(whenSec + duration + 0.02);
  }

  async dispose(): Promise<void> {
    this.stopSource();
    this.timeline.reset();
    if (this.ctx) {
      await this.ctx.close().catch(() => undefined);
      this.ctx = null;
      this.master = null;
      this.sfx = null;
    }
    this.buffer = null;
  }

  private handleContextStateChange = (): void => {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'running') return;
    if (this.timeline.snapshot().mode !== 'running') return; // not playing: nothing to protect
    this.interruptionHandler?.();
  };

  private stopSource(): void {
    if (!this.source) return;
    try {
      this.source.stop();
    } catch {
      /* already stopped */
    }
    this.source.disconnect();
    this.source = null;
  }
}
