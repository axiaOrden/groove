/**
 * Section preview — play a few seconds of a song with click tracks over it.
 *
 * This is the diagnostic half of "does the chart match the music". Numbers can tell you the grid
 * moved 46 ms; only listening tells you whether the notes are *on* the hits, and the fastest way to
 * hear that is to play a short section with a click on every beat and a blip on every generated
 * note. If the clicks and the music agree, the chart is aligned; if the note blips land between the
 * drum hits, the analyser and the generator disagree and you can hear exactly where.
 *
 * Deliberately separate from the gameplay `WebAudioEngine`:
 *
 *  - the game's engine owns the *authoritative* song clock and is paused/seeked by the state
 *    machine; a preview is a fire-and-forget diagnostic that must never be able to disturb a run;
 *  - so this class creates its own `AudioContext`, schedules one buffer source plus its clicks, and
 *    closes nothing until `dispose()`. Two contexts coexist happily; the preview is only reachable
 *    from the import panel, where no run is in progress.
 *
 * Clicks are scheduled ahead of time on the audio clock (never from `requestAnimationFrame`), so the
 * click grid is sample-accurate against the music even if the page stutters. The animation frame is
 * used *only* to move the playhead in the diagnostics timeline.
 */

export interface PreviewClickTrack {
  /** Beat times in song milliseconds; played as a low, dry tick. */
  beats?: readonly number[];
  /** Generated note times in song milliseconds; SPACE (lane 3) gets a different pitch. */
  notes?: readonly number[];
}

export interface SectionPreviewRequest extends PreviewClickTrack {
  buffer: AudioBuffer;
  startMs: number;
  endMs: number;
  /** Play the beat tick track. */
  beatClick?: boolean;
  /** Play the note blip track. */
  noteClick?: boolean;
  /** Lanes per note, parallel to `notes`; lane 3 (SPACE) is pitched higher so it is audible apart. */
  noteLanes?: readonly number[];
  /** Called with the song time while playing, and with `null` when playback stops. */
  onTime?: (songTimeMs: number | null) => void;
  /** Called once when the section finishes on its own. */
  onEnded?: () => void;
}

const TICK_HZ = 880;
const NOTE_HZ = 1760;
const SPACE_HZ = 2640;

export class SectionPreview {
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private scheduled: Array<{ osc: OscillatorNode; gain: GainNode }> = [];
  private frame = 0;
  private startedAt = 0;
  private startMs = 0;
  private endMs = 0;
  private request: SectionPreviewRequest | null = null;
  private stopped = true;

  get playing(): boolean {
    return !this.stopped;
  }

  get currentRequest(): SectionPreviewRequest | null {
    return this.request;
  }

  /** Begin playback. Returns the `AudioContext` so the caller can report a resume failure. */
  async play(request: SectionPreviewRequest): Promise<void> {
    this.stop();
    if (request.endMs <= request.startMs) return;
    const context = this.ensureContext();
    if (context.state === 'suspended') await context.resume();

    this.request = request;
    this.startMs = request.startMs;
    this.endMs = Math.min(request.endMs, request.startMs + request.buffer.duration * 1000);
    this.stopped = false;

    const source = context.createBufferSource();
    source.buffer = request.buffer;
    const master = context.createGain();
    master.gain.value = 0.9;
    source.connect(master).connect(context.destination);

    const at = context.currentTime + 0.08; // a beat of lead-in, so the first click is not clipped
    const offsetSec = Math.max(0, this.startMs / 1000);
    const durationSec = (this.endMs - this.startMs) / 1000;
    this.startedAt = at;
    this.source = source;

    if (request.beatClick !== false) {
      for (const beatMs of request.beats ?? []) {
        this.scheduleClick(context, master, at, beatMs, TICK_HZ, 0.18, 0.04);
      }
    }
    if (request.noteClick !== false) {
      const noteLanes = request.noteLanes ?? [];
      (request.notes ?? []).forEach((noteMs, index) => {
        const lane = noteLanes[index];
        const hz = lane === 3 ? SPACE_HZ : NOTE_HZ;
        this.scheduleClick(context, master, at, noteMs, hz, 0.12, 0.03);
      });
    }

    source.onended = () => {
      if (this.stopped) return;
      this.stop();
      request.onEnded?.();
    };
    source.start(at, offsetSec, durationSec);
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    for (const { osc } of this.scheduled) {
      try {
        osc.stop();
      } catch {
        /* already stopped */
      }
      osc.disconnect();
    }
    this.scheduled = [];
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        /* never started, or already finished */
      }
      this.source.disconnect();
      this.source = null;
    }
    const request = this.request;
    this.request = null;
    request?.onTime?.(null);
  }

  dispose(): void {
    this.stop();
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') void context.close();
  }

  /**
   * Schedule one click, but only if its time falls inside the section.
   *
   * The gain envelope is a short exponential decay rather than a rectangular window: a click that
   * stops abruptly is a broadband pop that smears across the very frequencies the player is trying
   * to compare, which defeats the purpose of the tool.
   */
  private scheduleClick(
    context: AudioContext,
    destination: AudioNode,
    at: number,
    songTimeMs: number,
    hz: number,
    level: number,
    decaySec: number,
  ): void {
    if (songTimeMs < this.startMs || songTimeMs > this.endMs) return;
    // Scheduling into the past throws nothing but plays immediately; ignore those instead.
    const offsetSec = (songTimeMs - this.startMs) / 1000;
    const when = at + offsetSec;
    if (when < context.currentTime) return;
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = 'triangle';
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(level, when + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + decaySec);
    osc.connect(gain).connect(destination);
    osc.start(when);
    osc.stop(when + decaySec + 0.01);
    this.scheduled.push({ osc, gain });
  }

  /** Move the playhead. Animation frames drive the *display* only; timing comes from the audio clock. */
  private tick(): void {
    if (this.stopped) return;
    const context = this.context;
    const request = this.request;
    if (!context || !request) return;
    const elapsedMs = (context.currentTime - this.startedAt) * 1000;
    const songTimeMs = this.startMs + elapsedMs;
    if (elapsedMs >= 0) request.onTime?.(Math.max(this.startMs, songTimeMs));
    if (songTimeMs > this.endMs + 60) {
      this.stop();
      request.onEnded?.();
      return;
    }
    this.frame = requestAnimationFrame(() => this.tick());
  }

  private ensureContext(): AudioContext {
    if (!this.context || this.context.state === 'closed') {
      this.context = new AudioContext({ latencyHint: 'interactive' });
    }
    return this.context;
  }
}
