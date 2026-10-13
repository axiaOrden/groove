/**
 * InputManager — keyboard *and* touch into one stream of lane events.
 *
 * Correctness details that matter for a rhythm game:
 *  - `event.repeat` is dropped, so holding a key does not machine-gun presses. OS auto-repeat
 *    can also arrive as a *fresh* keydown in some setups, so a lane is additionally treated as
 *    "down" until every source holding it has let go: a second keydown for an already-down
 *    lane is ignored.
 *  - `preventDefault()` is called for the seven mapped keys on both keydown and keyup, which
 *    stops SPACE from scrolling the page and stops the letters from reaching focused widgets.
 *  - Simultaneous chords work because every lane is tracked independently.
 *  - Losing focus or hiding the tab releases every lane: without a keyup or pointerup the game
 *    would otherwise think a hold is still being held.
 *  - Keystrokes aimed at form controls (the settings sliders) are ignored.
 *
 * Touch (phase 1.5)
 * -----------------
 * Pointer Events are used directly — no synthetic keyboard events — and they feed the same
 * `LanePressTracker` and the same `onLanePress`/`onLaneRelease` callbacks as the keyboard, so
 * a finger and a key are judged by exactly the same code path with the same audio-clock
 * timestamps.
 *
 *  - Every pointer id is mapped to the lane it went down on (`pointerLanes`), so a release
 *    cannot land on the wrong lane even if the finger drifted.
 *  - `pointerdown` captures the pointer on its lane zone. Every subsequent event for that
 *    pointer — including `pointerup` — is delivered to the captured element, which is what
 *    makes a press survive a finger sliding into a neighbouring lane (`pointerup` after
 *    `pointercancel` and after focus loss can only arrive where we can still see it).
 *  - Two fingers on one lane are allowed but do not judge twice (see `LanePressTracker`), and
 *    lifting one finger does not release the lane the other finger is holding.
 *  - `pointercancel` (the OS took the gesture away: system gesture, call, orientation change)
 *    is treated exactly like `pointerup`, so a hold is settled rather than left stuck.
 *
 * Sliding (phase 1.6)
 * ------------------
 * A finger that stays on the glass can move between lanes: crossing a column boundary releases
 * the lane it was on and presses the lane it arrived in. Both are ordinary press/release pairs
 * through the same pipeline, so a slide judges notes exactly like a tap, and sliding out of a
 * hold ends that hold.
 *
 *  - The lane is resolved from the pointer's *coordinates* against the surface's cached column
 *    rectangles. It cannot be resolved from `event.target`: `setPointerCapture` retargets every
 *    event of the gesture to the column the finger started on, so `pointerenter`/`pointerleave`
 *    never fire for the columns being crossed. (A bare element attached without a resolver falls
 *    back to `elementFromPoint`, which keeps taps working everywhere.)
 *  - Moving inside one lane is a no-op: no repeated press, and nothing allocated.
 *  - Crossing several lanes within a single event presses only the destination lane. A swipe is
 *    judged where it lands, not as a glissando, and the work per event stays constant.
 *  - Leaving the columns (upwards, over the HUD) releases the lane but keeps the finger tracked,
 *    so re-entering presses a lane again without the player lifting their finger.
 *  - Two fingers may share one lane: it stays down until the last of them leaves, and the second
 *    arrival does not re-judge it.
 *  - Window-level `pointerup`/`pointercancel`/`pointermove` listeners are a safety net for the
 *    platforms without capture: a gesture that wanders off the surface is still settled instead
 *    of leaving a lane stuck down. Every one of those paths is idempotent.
 *
 * Presses are timestamped by the caller via `nowMs()`, which reads the *audio* clock. That
 * value is sampled in the same task as the DOM event, so it is not quantised to a frame —
 * which is also why touch needs no special latency handling: there is no per-frame input poll.
 */

import { KEY_CODE_TO_LANE, LANE_KEYS } from './GameConfig';
import { LanePressTracker } from './LanePressTracker';

export interface InputCallbacks {
  /** Authoritative song time in ms (usually the audio clock). */
  nowMs(): number;
  onLanePress(lane: number, songTimeMs: number): void;
  onLaneRelease(lane: number, songTimeMs: number): void;
  /** Optional immediate visual feedback, fired even when the game is paused. */
  onLaneVisual?(lane: number, active: boolean): void;
  onTogglePause(): void;
  onRestart(): void;
  onFocusLost(): void;
}

/**
 * The part of a touch surface the input layer needs: a root to bind to, plus a way to resolve a
 * viewport point to a lane. `TouchSurface` implements it. Passing a bare element is also
 * supported — lanes are then resolved with a DOM hit test, which keeps taps working but loses the
 * cached-rectangle path that slides use.
 */
export interface PointerSurface {
  readonly root: HTMLElement;
  laneAtPoint(clientX: number, clientY: number): number | null;
}

function isPointerSurface(value: HTMLElement | PointerSurface): value is PointerSurface {
  return typeof (value as PointerSurface).laneAtPoint === 'function';
}

export class InputManager {
  private readonly tracker = new LanePressTracker(LANE_KEYS.length);
  /** pointerId -> lane, i.e. the touch half of "who is holding what". */
  private readonly pointerLanes = new Map<number, number>();
  /**
   * Every pointer currently down on the surface, including one that has slid off the columns.
   * Keeping those pointers tracked is what lets a finger re-enter and press a lane again without
   * being lifted; it is also what tells apart "this finger left the highway" (release) from
   * "this whole gesture ended" (forget).
   */
  private readonly downPointers = new Set<number>();
  /** Resolves a viewport point to a lane; installed by `attachPointer`. */
  private laneAtPoint: ((clientX: number, clientY: number) => number | null) | null = null;
  private enabled = false;
  private attached = false;
  private pointerRoot: HTMLElement | null = null;
  private pointerAttached = false;
  private readonly keydownHandler: (event: KeyboardEvent) => void;
  private readonly keyupHandler: (event: KeyboardEvent) => void;
  private readonly blurHandler: () => void;
  private readonly visibilityHandler: () => void;
  private readonly pointerDownHandler: (event: PointerEvent) => void;
  private readonly pointerMoveHandler: (event: PointerEvent) => void;
  private readonly pointerUpHandler: (event: PointerEvent) => void;
  private readonly pointerCancelHandler: (event: PointerEvent) => void;
  private readonly pointerCaptureHandler: (event: PointerEvent) => void;

  constructor(
    private readonly callbacks: InputCallbacks,
    private readonly target: Window = window,
    private readonly documentRef: Document = document,
  ) {
    this.keydownHandler = (event) => this.handleKeyDown(event);
    this.keyupHandler = (event) => this.handleKeyUp(event);
    this.blurHandler = () => {
      this.releaseAll();
      this.callbacks.onFocusLost();
    };
    this.visibilityHandler = () => {
      if (this.documentRef.visibilityState === 'hidden') {
        this.releaseAll();
        this.callbacks.onFocusLost();
      }
    };
    this.pointerDownHandler = (event) => this.handlePointerDown(event);
    this.pointerMoveHandler = (event) => this.handlePointerMove(event);
    this.pointerUpHandler = (event) => this.handlePointerEnd(event, 'up');
    this.pointerCancelHandler = (event) => this.handlePointerEnd(event, 'cancel');
    this.pointerCaptureHandler = (event) => this.handlePointerEnd(event, 'lostcapture');
  }

  attach(): void {
    if (this.attached) return;
    this.target.addEventListener('keydown', this.keydownHandler);
    this.target.addEventListener('keyup', this.keyupHandler);
    this.target.addEventListener('blur', this.blurHandler);
    this.documentRef.addEventListener('visibilitychange', this.visibilityHandler);
    this.attached = true;
  }

  detach(): void {
    if (!this.attached) return;
    this.target.removeEventListener('keydown', this.keydownHandler);
    this.target.removeEventListener('keyup', this.keyupHandler);
    this.target.removeEventListener('blur', this.blurHandler);
    this.documentRef.removeEventListener('visibilitychange', this.visibilityHandler);
    this.attached = false;
  }

  /**
   * Attach pointer handling to a lane surface. Events are delegated from the zone elements
   * (`[data-lane]`), so the surface can rebuild its zones on resize without re-binding.
   *
   * The surface object supplies the point -> lane resolver used while sliding; passing a bare
   * element is still supported and degrades to a DOM hit test.
   */
  attachPointer(surface: HTMLElement | PointerSurface): void {
    const root = isPointerSurface(surface) ? surface.root : surface;
    if (this.pointerAttached && this.pointerRoot === root) return;
    this.detachPointer();
    this.laneAtPoint = isPointerSurface(surface) ? (x, y) => surface.laneAtPoint(x, y) : null;
    root.addEventListener('pointerdown', this.pointerDownHandler);
    root.addEventListener('pointermove', this.pointerMoveHandler);
    root.addEventListener('pointerup', this.pointerUpHandler);
    root.addEventListener('pointercancel', this.pointerCancelHandler);
    root.addEventListener('lostpointercapture', this.pointerCaptureHandler);
    root.addEventListener('contextmenu', preventContextMenu);
    // Safety net. With pointer capture the root sees the whole gesture; without it (or once a
    // finger leaves the surface for a region that owns its own pointer events) an end event can
    // be delivered somewhere the root never sees, which would leave the lane stuck down. These
    // listeners are cheap and idempotent: they ignore pointers we are not tracking.
    this.target.addEventListener('pointermove', this.pointerMoveHandler);
    this.target.addEventListener('pointerup', this.pointerUpHandler);
    this.target.addEventListener('pointercancel', this.pointerCancelHandler);
    this.target.addEventListener('lostpointercapture', this.pointerCaptureHandler);
    this.pointerRoot = root;
    this.pointerAttached = true;
  }

  detachPointer(): void {
    const root = this.pointerRoot;
    this.pointerRoot = null;
    this.pointerAttached = false;
    this.laneAtPoint = null;
    this.pointerLanes.clear();
    this.downPointers.clear();
    if (!root) return;
    root.removeEventListener('pointerdown', this.pointerDownHandler);
    root.removeEventListener('pointermove', this.pointerMoveHandler);
    root.removeEventListener('pointerup', this.pointerUpHandler);
    root.removeEventListener('pointercancel', this.pointerCancelHandler);
    root.removeEventListener('lostpointercapture', this.pointerCaptureHandler);
    root.removeEventListener('contextmenu', preventContextMenu);
    this.target.removeEventListener('pointermove', this.pointerMoveHandler);
    this.target.removeEventListener('pointerup', this.pointerUpHandler);
    this.target.removeEventListener('pointercancel', this.pointerCancelHandler);
    this.target.removeEventListener('lostpointercapture', this.pointerCaptureHandler);
  }

  /**
   * Enable gameplay input. Disabling releases everything so a key or finger held while the
   * game was paused cannot leave a lane stuck down or fire a late judgment on resume.
   */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.releaseAll();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  isLaneDown(lane: number): boolean {
    return this.tracker.isDown(lane);
  }

  pressedLanes(): number[] {
    return this.tracker.pressedLanes();
  }

  /**
   * Copy the live lane state into a caller-owned array. Used by the renderer so the per-frame
   * path allocates nothing.
   */
  writePressedState(target: boolean[]): boolean[] {
    for (let lane = 0; lane < target.length; lane += 1) {
      target[lane] = this.tracker.isDown(lane);
    }
    return target;
  }

  /**
   * Lane a pointer id is currently holding, or null when it is untracked or has slid off the
   * columns. Exposed for tests and the debug API so the pointerId -> lane mapping can be asserted
   * without reaching into the DOM.
   */
  pointerLane(pointerId: number): number | null {
    const lane = this.pointerLanes.get(pointerId);
    return lane === undefined ? null : lane;
  }

  /** Pointers the surface is still tracking (down, whether or not they are on a lane). */
  get activePointers(): number {
    return this.downPointers.size;
  }

  /** Pointers that currently hold a lane (i.e. `activePointers` minus the ones off the columns). */
  get pointersOnLanes(): number {
    return this.pointerLanes.size;
  }

  /** Release every lane without dispatching note judgments. */
  releaseAll(): void {
    const wasDown = this.tracker.releaseAll();
    this.pointerLanes.clear();
    this.downPointers.clear();
    for (const lane of wasDown) this.callbacks.onLaneVisual?.(lane, false);
  }

  /** Lane key labels for the HUD, in lane order. */
  static keyLabels(): string[] {
    return LANE_KEYS.map((entry) => entry.label);
  }

  // ------------------------------------------------------------------ touch ---

  /**
   * Register a pointer going down on a lane. Returns true when this press started the lane
   * (i.e. produced a judgment); a second finger on a held lane returns false.
   */
  pointerDown(lane: number, pointerId: number): boolean {
    if (!this.enabled) return false;
    if (!this.tracker.isValidLane(lane)) return false;
    // A repeated pointerdown for a pointer we already track (a double event, or a stray
    // re-delivery) must not press again.
    if (this.downPointers.has(pointerId)) return false;
    this.downPointers.add(pointerId);
    this.pointerLanes.set(pointerId, lane);

    const result = this.tracker.acquire(lane, LanePressTracker.pointerSource(pointerId));
    // The pad lights up for every finger, even one that does not re-judge the lane.
    this.callbacks.onLaneVisual?.(lane, true);
    if (result !== 'pressed') return false;
    this.callbacks.onLanePress(lane, this.callbacks.nowMs());
    return true;
  }

  /**
   * Register a pointer going up (or being cancelled). Returns the lane that went up, or null
   * when the pointer was unknown (already released, or cleared by focus loss), had slid off the
   * columns, or another source still holds the lane.
   */
  pointerUp(pointerId: number): number | null {
    const tracked = this.downPointers.delete(pointerId);
    const lane = this.pointerLanes.get(pointerId);
    this.pointerLanes.delete(pointerId);
    if (!tracked || lane === undefined) return null;
    const release = this.tracker.release(LanePressTracker.pointerSource(pointerId));
    if (!release) return null;
    this.callbacks.onLaneVisual?.(release.lane, false);
    this.callbacks.onLaneRelease(release.lane, this.callbacks.nowMs());
    return release.lane;
  }

  /**
   * Move a tracked pointer to a lane, or off the columns (`lane === null`).
   *
   * This is the whole slide rule: release what the pointer was on (only judged when the lane is
   * actually left by its last holder), then press where it arrived (only judged when the lane was
   * not already held). Returns the lane that was pressed, or null when nothing was judged.
   *
   * Public so the slide contract can be tested without synthesising DOM events for every case;
   * `pointermove` resolves a point to a lane and calls this.
   */
  movePointerToLane(pointerId: number, lane: number | null): number | null {
    if (!this.downPointers.has(pointerId)) return null;
    const target = lane !== null && this.tracker.isValidLane(lane) ? lane : null;
    const current = this.pointerLanes.get(pointerId);
    if (target === current) return null; // same lane (or still off the surface): nothing to do

    this.pointerLanes.delete(pointerId);
    if (current !== undefined) {
      const release = this.tracker.release(LanePressTracker.pointerSource(pointerId));
      if (release) {
        this.callbacks.onLaneVisual?.(release.lane, false);
        this.callbacks.onLaneRelease(release.lane, this.callbacks.nowMs());
      }
    }
    if (target === null) return null;

    this.pointerLanes.set(pointerId, target);
    const result = this.tracker.acquire(target, LanePressTracker.pointerSource(pointerId));
    // The lane lights up for every finger that arrives, even when it is already held by another.
    this.callbacks.onLaneVisual?.(target, true);
    if (result !== 'pressed') return null;
    this.callbacks.onLanePress(target, this.callbacks.nowMs());
    return target;
  }

  // ---------------------------------------------------------------- keyboard ---

  private handleKeyDown(event: KeyboardEvent): void {
    const lane = KEY_CODE_TO_LANE[event.code];

    if (lane !== undefined) {
      // Stop SPACE from scrolling and the letters from typing, even when input is disabled.
      event.preventDefault();
      if (event.repeat) return;
      if (!this.enabled) return;
      const source = LanePressTracker.keyboardSource(event.code);
      const result = this.tracker.acquire(lane, source);
      // Even a lane already held by another finger lights up for this key; it just does not
      // judge the note twice.
      this.callbacks.onLaneVisual?.(lane, true);
      if (result !== 'pressed') return;
      this.callbacks.onLanePress(lane, this.callbacks.nowMs());
      return;
    }

    if (this.isFormTarget(event.target)) return;

    if (event.code === 'Escape') {
      event.preventDefault();
      this.callbacks.onTogglePause();
    } else if (event.code === 'KeyR') {
      event.preventDefault();
      this.callbacks.onRestart();
    }
  }

  private handleKeyUp(event: KeyboardEvent): void {
    const lane = KEY_CODE_TO_LANE[event.code];
    if (lane === undefined) return;
    event.preventDefault();
    const release = this.tracker.release(LanePressTracker.keyboardSource(event.code));
    if (!release) return; // another source (a finger) still holds this lane
    this.callbacks.onLaneVisual?.(release.lane, false);
    this.callbacks.onLaneRelease(release.lane, this.callbacks.nowMs());
  }

  // ----------------------------------------------------------------- pointers ---

  private handlePointerDown(event: PointerEvent): void {
    const zone = this.zoneFor(event.target);
    if (!zone) return;
    const lane = Number(zone.dataset.lane);
    if (!Number.isInteger(lane)) return;
    // Suppress the compatibility mouse events (and with them the click, double-tap zoom and
    // text selection) for a touch that is aimed at the highway. Page scrolling itself is
    // prevented by `touch-action: none` on the surface.
    if (event.cancelable !== false) event.preventDefault();
    if (!this.enabled) return;
    this.capturePointer(zone, event.pointerId);
    this.pointerDown(lane, event.pointerId);
  }

  /**
   * A finger moved. Almost every move on the page is filtered out by one Set lookup (mouse moves
   * on desktop, a finger that never started on a lane); a tracked touch costs the same handful of
   * comparisons as an in-lane move, with no allocation and no layout read.
   */
  private handlePointerMove(event: PointerEvent): void {
    if (!this.downPointers.has(event.pointerId)) return;
    if (!this.enabled) return;
    // Coalesced events are deliberately not walked: only the destination lane is pressed, and the
    // newest sample is the event itself, so the intermediate crossings could only add work.
    this.movePointerToLane(event.pointerId, this.resolveLane(event.clientX, event.clientY));
  }

  /**
   * Lane under a viewport point, or null when the point is off the columns. The injected resolver
   * is authoritative (cached rectangles, no layout work); the `elementFromPoint` fallback exists
   * for a bare-element attachment — including environments where core DOM hit testing is absent.
   */
  private resolveLane(clientX: number, clientY: number): number | null {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    if (this.laneAtPoint) return this.laneAtPoint(clientX, clientY);
    const documentRef = this.documentRef;
    if (typeof documentRef.elementFromPoint !== 'function') return null;
    let node: Element | null = null;
    try {
      node = documentRef.elementFromPoint(clientX, clientY);
    } catch {
      return null;
    }
    if (!(node instanceof Element)) return null;
    const zone = node.closest<HTMLElement>('[data-lane]');
    if (!zone || (this.pointerRoot && !this.pointerRoot.contains(zone))) return null;
    const lane = Number(zone.dataset.lane);
    return Number.isInteger(lane) ? lane : null;
  }

  private handlePointerEnd(event: PointerEvent, kind: 'up' | 'cancel' | 'lostcapture'): void {
    // `lostpointercapture` also fires right after a normal pointerup (where the map entry is
    // already gone) and after pointercancel; releasing an unknown pointer is a no-op.
    if (kind === 'up' && event.cancelable !== false) event.preventDefault();
    this.pointerUp(event.pointerId);
  }

  private capturePointer(zone: HTMLElement, pointerId: number): void {
    const capture = (zone as Partial<HTMLElement>).setPointerCapture;
    if (typeof capture !== 'function') return;
    try {
      capture.call(zone, pointerId);
    } catch {
      // A pointer that has already been released, or a non-PointerEvent environment.
    }
  }

  /** The lane zone an event target belongs to, if it is inside our pointer surface. */
  private zoneFor(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    const zone = target.closest<HTMLElement>('[data-lane]');
    if (!zone) return null;
    if (this.pointerRoot && !this.pointerRoot.contains(zone)) return null;
    return zone;
  }

  private isFormTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }
}

/** Long-press on a lane must not open the context menu or the text-selection callout. */
function preventContextMenu(event: Event): void {
  event.preventDefault();
}
