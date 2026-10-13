/**
 * Shared interface for anything that can act as a song clock.
 *
 * Two implementations are planned, and their timing guarantees are **not** equivalent.
 * The interface exposes `clockPrecision` and `rankedEligible` so the rest of the game cannot
 * quietly treat them as interchangeable:
 *
 * | implementation        | clockPrecision    | rankedEligible | notes                                                |
 * |-----------------------|-------------------|----------------|------------------------------------------------------|
 * | `WebAudioSource`      | sample-accurate   | yes, when the user has calibrated | (phase 1-2) decoded AudioBuffer scheduled on an `AudioContext`; song time is derived from the audio clock. |
 * | `YouTubePlayerSource` | approximate       | **no**         | (phase 6) `getCurrentTime()` is coarse, ad/buffer stalls and seeking are invisible; only usable as an experimental, unranked reference. |
 *
 * Consequences that callers must respect:
 *  - Only `rankedEligible` sources may submit scores that claim competitive validity.
 *  - An `approximate` source must additionally report `isStalled()`; while stalled the game
 *    suspends judgments instead of judging against a drifting clock.
 */

export type AudioSourceKind = 'web-audio-buffer' | 'youtube-iframe';

export type ClockPrecision = 'sample-accurate' | 'approximate';

export interface AudioSourceTimeline {
  readonly kind: AudioSourceKind;
  /** How trustworthy `getSongTimeMs()` is. */
  readonly clockPrecision: ClockPrecision;
  /** Whether results from this source may count as competitive (see README anti-cheat notes). */
  readonly rankedEligible: boolean;

  /** Milliseconds from the first audio sample. May be negative during a count-in. */
  getSongTimeMs(): number;
  /** Length of the song in ms, or 0 when unknown. */
  getDurationMs(): number;
  isPlaying(): boolean;
  /**
   * True while the source cannot advance reliably (buffering, seeking, ad playback).
   * `WebAudioSource` never stalls; `YouTubePlayerSource` will.
   */
  isStalled(): boolean;
}

/** Minimal clock contract consumed by gameplay; satisfied by `AudioSourceTimeline`. */
export interface SongClock {
  getSongTimeMs(): number;
}

/** Convenience base class with the behaviours every source shares. */
export abstract class BaseAudioSource implements AudioSourceTimeline {
  abstract readonly kind: AudioSourceKind;
  abstract readonly clockPrecision: ClockPrecision;
  abstract readonly rankedEligible: boolean;

  private durationMs = 0;

  protected setDuration(durationMs: number): void {
    this.durationMs = Math.max(0, durationMs);
  }

  abstract getSongTimeMs(): number;
  abstract isPlaying(): boolean;

  getDurationMs(): number {
    return this.durationMs;
  }

  isStalled(): boolean {
    return false;
  }
}
