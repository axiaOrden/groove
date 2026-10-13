/**
 * OrientationGate — portrait warning, fullscreen and orientation lock.
 *
 * A seven-lane highway needs width: in portrait the seven lanes would each be ~46 px wide and
 * the road could only occupy the lower third of the screen (see `CameraFraming`, which reports
 * that case as clamped). So a touch device in portrait sees a rotate-device overlay and the
 * game is held paused; in landscape it plays normally.
 *
 * Three rules keep this from being annoying or fragile:
 *
 *  1. **One shot, remembered.** Fullscreen and orientation lock are only ever requested from a
 *     user gesture (never on load) and at most once per browser — the fact that we asked is
 *     persisted, so a player who prefers the browser UI is not asked again. The buttons stay
 *     available for anyone who changes their mind.
 *  2. **Failures are normal.** `screen.orientation.lock()` does not exist in Firefox and can be
 *     rejected in Chrome (not fullscreen, unsupported orientation). Every attempt is wrapped
 *     and reported as a value ('locked' | 'unsupported' | 'rejected'), never thrown, and never
 *     retried in a loop.
 *  3. **Resume only when the layout is ready.** Leaving portrait fires one resize (often two,
 *     mid-animation). The "ready" notification is debounced so the game is only resumed once
 *     the viewport has settled, and only if the pause was caused by the rotation itself.
 *
 * Everything the module touches (window, document, storage, the fullscreen target) is injected,
 * so the whole policy is unit testable without a device or a browser.
 */

import type { StorageLike } from '../storage/SettingsStore';

export const IMMERSIVE_FLAG_KEY = 'seven-keys.immersive.v1';

/**
 * `timeout` is a real outcome, not a nicety: some embedded browsers (and this project's own
 * preview shell) return a `requestFullscreen()` promise that never settles, and awaiting it
 * would strand the immersive path forever.
 */
export type FullscreenOutcome = 'entered' | 'exited' | 'already' | 'unsupported' | 'rejected' | 'timeout';
/** `skipped` = we did not ask, because fullscreen never became active. */
export type OrientationLockOutcome = 'locked' | 'unsupported' | 'rejected' | 'skipped' | 'timeout';

export interface OrientationGateOptions {
  win: Window;
  doc: Document;
  /** Element to put fullscreen (the stage, so the canvas and the HUD go fullscreen). */
  fullscreenTarget: HTMLElement;
  /** The rotate-device overlay. */
  overlay: HTMLElement;
  /** Buttons that toggle fullscreen (HUD icon and the overlay's own button). */
  fullscreenButtons?: HTMLElement[];
  /** Remembering that we already asked once. */
  storage?: StorageLike | null;
  /** Only touch layouts get the portrait gate. */
  enabled: () => boolean;
  /** Portrait entered: pause now, it is never a judgement call. */
  onPortraitEntered?: () => void;
  /** Back in landscape and the viewport has settled: it is safe to resume. */
  onLandscapeSettled?: () => void;
  /** A fullscreen/orientation attempt finished (for logging and the debug API). */
  onImmersiveResult?: (result: { fullscreen: FullscreenOutcome; lock: OrientationLockOutcome }) => void;
  /** How long to wait for the viewport to settle after leaving portrait. */
  settleMs?: number;
  /** How long to wait for a fullscreen/orientation request to settle before giving up on it. */
  requestTimeoutMs?: number;
}

const DEFAULT_SETTLE_MS = 260;
const DEFAULT_REQUEST_TIMEOUT_MS = 1200;

/** `screen.orientation.lock` is Chrome-only, hence the optional member. */
interface LockableOrientation {
  lock?: (orientation: string) => Promise<void>;
  unlock?: () => void;
}

export class OrientationGate {
  private readonly settleMs: number;
  private readonly requestTimeoutMs: number;
  private portraitValue = false;
  private overlayVisible = false;
  private dismissedForSession = false;
  private started = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastResult: { fullscreen: FullscreenOutcome; lock: OrientationLockOutcome } | null = null;
  private readonly resizeHandler: () => void;
  private readonly fullscreenChangeHandler: () => void;
  private readonly clickHandler: () => void;

  constructor(private readonly options: OrientationGateOptions) {
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.resizeHandler = () => this.evaluate();
    this.fullscreenChangeHandler = () => this.syncFullscreenButtons();
    this.clickHandler = () => void this.toggleFullscreen();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.options.win.addEventListener('resize', this.resizeHandler);
    this.options.win.addEventListener('orientationchange', this.resizeHandler);
    this.options.doc.addEventListener('fullscreenchange', this.fullscreenChangeHandler);
    for (const button of this.options.fullscreenButtons ?? []) {
      button.addEventListener('click', this.clickHandler);
    }
    this.syncFullscreenButtons();
    this.evaluate();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.options.win.removeEventListener('resize', this.resizeHandler);
    this.options.win.removeEventListener('orientationchange', this.resizeHandler);
    this.options.doc.removeEventListener('fullscreenchange', this.fullscreenChangeHandler);
    for (const button of this.options.fullscreenButtons ?? []) {
      button.removeEventListener('click', this.clickHandler);
    }
    this.clearSettleTimer();
  }

  /** Re-read the viewport and update the overlay. Called on every resize and on start. */
  evaluate(): void {
    const portrait = this.isPortrait();
    const blockable = portrait && this.options.enabled() && !this.dismissedForSession;
    this.overlayVisible = blockable;
    this.options.overlay.hidden = !blockable;

    if (portrait === this.portraitValue) return;
    this.portraitValue = portrait;

    if (portrait) {
      this.clearSettleTimer();
      this.options.onPortraitEntered?.();
      return;
    }
    // Leaving portrait: wait for the viewport to settle before letting the game resume.
    this.clearSettleTimer();
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      if (this.isPortrait()) return;
      this.options.onLandscapeSettled?.();
    }, this.settleMs);
  }

  get portrait(): boolean {
    return this.portraitValue;
  }

  get showingOverlay(): boolean {
    return this.overlayVisible;
  }

  get settlePending(): boolean {
    return this.settleTimer !== null;
  }

  /** "Continue anyway": stop gating this session (the layout stays the clamped portrait one). */
  dismiss(): void {
    this.dismissedForSession = true;
    this.options.overlay.hidden = true;
    this.overlayVisible = false;
    this.clearSettleTimer();
    this.options.onLandscapeSettled?.();
  }

  isPortrait(win: Window = this.options.win): boolean {
    const width = win.innerWidth || 0;
    const height = win.innerHeight || 0;
    return height > width * 1.02;
  }

  get fullscreen(): boolean {
    return this.options.doc.fullscreenElement !== null && this.options.doc.fullscreenElement !== undefined;
  }

  get lastImmersive(): { fullscreen: FullscreenOutcome; lock: OrientationLockOutcome } | null {
    return this.lastResult;
  }

  /** True once we have already asked for immersive mode in this browser. */
  get immersiveRequested(): boolean {
    return this.readFlag();
  }

  // --------------------------------------------------------------- requests ---

  async toggleFullscreen(): Promise<FullscreenOutcome> {
    const result = this.fullscreen ? await this.exitFullscreen() : await this.enterFullscreen();
    this.syncFullscreenButtons();
    return result;
  }

  async enterFullscreen(): Promise<FullscreenOutcome> {
    if (this.fullscreen) return 'already';
    const target = this.options.fullscreenTarget;
    if (typeof target.requestFullscreen !== 'function') return 'unsupported';
    try {
      // `navigationUI: 'hide'` is a hint; browsers that do not know it ignore the option.
      const settled = await settleWithin(
        target.requestFullscreen({ navigationUI: 'hide' }),
        this.requestTimeoutMs,
      );
      if (settled === 'timeout') return this.fullscreen ? 'entered' : 'timeout';
      return 'entered';
    } catch {
      return 'rejected';
    }
  }

  async exitFullscreen(): Promise<FullscreenOutcome> {
    const doc = this.options.doc;
    if (!this.fullscreen) return 'already';
    if (typeof doc.exitFullscreen !== 'function') return 'unsupported';
    try {
      await doc.exitFullscreen();
      return 'exited';
    } catch {
      return 'rejected';
    }
  }

  /** Landscape lock, only meaningful while fullscreen. Never throws. */
  async lockLandscape(): Promise<OrientationLockOutcome> {
    const screenRef = this.options.win.screen as { orientation?: LockableOrientation } | undefined;
    const orientation = screenRef?.orientation;
    if (!orientation || typeof orientation.lock !== 'function') return 'unsupported';
    try {
      const settled = await settleWithin(orientation.lock('landscape'), this.requestTimeoutMs);
      return settled === 'timeout' ? 'timeout' : 'locked';
    } catch {
      return 'rejected';
    }
  }

  /**
   * The one-shot attempt, meant to be called from the Start button's gesture. No-op once it has
   * been tried in this browser: we never ask twice and never show a native prompt.
   */
  async requestImmersiveOnce(): Promise<{ fullscreen: FullscreenOutcome; lock: OrientationLockOutcome } | null> {
    if (this.readFlag()) return null;
    this.writeFlag();
    return this.enterImmersive();
  }

  /** Force the attempt now (the fullscreen button). */
  async enterImmersive(): Promise<{ fullscreen: FullscreenOutcome; lock: OrientationLockOutcome }> {
    const fullscreen = await this.enterFullscreen();
    // Lock after the request settles: Chrome only allows a lock once fullscreen is active.
    const fullscreenActive = fullscreen === 'entered' || fullscreen === 'already' || this.fullscreen;
    const lock = fullscreenActive ? await this.lockLandscape() : 'skipped';
    const result = { fullscreen, lock };
    this.lastResult = result;
    this.syncFullscreenButtons();
    this.options.onImmersiveResult?.(result);
    return result;
  }

  /**
   * Update the fullscreen buttons for the current state: the accessible title on every button,
   * and the visible text for the ones that carry a `[data-role="label"]` (the icon-only HUD
   * button keeps its glyph and just gets a new title).
   */
  syncFullscreenButtons(): void {
    const label = this.fullscreen ? 'Exit fullscreen' : 'Enter fullscreen';
    for (const button of this.options.fullscreenButtons ?? []) {
      button.title = label;
      button.setAttribute('aria-pressed', this.fullscreen ? 'true' : 'false');
      const labelNode = button.querySelector('[data-role="label"]');
      if (labelNode) labelNode.textContent = this.fullscreen ? '⤡ Exit fullscreen' : '⤢ Fullscreen';
    }
  }

  // ------------------------------------------------------------------ flags ---

  private readFlag(): boolean {
    // Without storage we cannot know whether we already asked, and asking again is the worse
    // failure mode: treat "unknown" as "already asked".
    if (!this.options.storage) return true;
    try {
      return this.options.storage.getItem(IMMERSIVE_FLAG_KEY) === '1';
    } catch {
      return true;
    }
  }

  private writeFlag(): void {
    try {
      this.options.storage?.setItem(IMMERSIVE_FLAG_KEY, '1');
    } catch {
      /* ignore: the flag is a nicety */
    }
  }

  private clearSettleTimer(): void {
    if (this.settleTimer === null) return;
    clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }
}

/** Await a promise that is allowed to never settle, giving up after `timeoutMs`. */
async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
