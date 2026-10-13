/**
 * TouchSurface — the seven lane columns a finger can hit.
 *
 * This is deliberately *not* a second gameplay surface: it owns no rules, no clock and no
 * state beyond "which lane is lit". Its only job is to put seven DOM columns exactly where the
 * seven 3D lane columns are, and to hand pointer events to `InputManager`.
 *
 * Geometry comes from the same projection the renderer uses (`CameraFraming`), so the columns
 * are derived from the camera rather than approximated from CSS percentages:
 *
 *     boundary_i = midpoint(laneCentre_{i-1}, laneCentre_i)
 *     column_i   = [boundary_{i-1}, boundary_i]        (extended to both screen edges)
 *
 * Each column is therefore as wide as a lane (~103 px on a 800 px-wide phone) and every pixel
 * between the two screen edges maps to the nearest lane: there are no dead gaps to miss in the
 * heat of a song, and the columns are centred on the lanes so a finger tends to land right.
 *
 * Vertically the columns start below the HUD text (so reaching for the score cannot trigger a
 * note) and end at the bottom of the usable area. The visible pads are a short strip pinned to
 * the bottom of each column: they stay where a resting thumb is and, being ~12% of the height,
 * they never cover the notes coming down the middle of the screen.
 *
 * Sliding (phase 1.6)
 * ------------------
 * The surface is also the authority on *which lane a point belongs to* (`laneAtPoint`). That is
 * what makes A -> S -> D slides work: `pointerdown` captures the pointer on the column it started
 * on, so every later event for that finger is retargeted to that one element and `event.target`
 * stops describing where the finger is. Resolving the lane from the pointer's coordinates is
 * therefore the only correct answer, and doing it against the rectangles cached here (rather than
 * a DOM hit test or `getBoundingClientRect` per event) means a slide costs a handful of
 * comparisons and no layout work — which is what keeps 120 Hz touch panels happy.
 */

import { LANE_KEYS } from '../game/GameConfig';
import { LANE_COLORS } from '../renderer/Layout';
import type { Framing } from '../renderer/CameraFraming';

export interface TouchSurfaceLayout {
  /** Projected lane centres at the hit line, in viewport px. */
  laneCentersPx: readonly number[];
  /** Usable viewport rectangle in CSS px. */
  usable: { left: number; top: number; width: number; height: number };
  /** Where the interactive area starts (below the HUD), in CSS px from the top. */
  topPx: number;
  /** Viewport width and height, used to extend the outer columns to the screen edges. */
  viewportWidth: number;
  viewportHeight: number;
}

export interface ZoneRect {
  lane: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const TOUCH_LAYER_ID = 'touch-layer';

/** Minimum height of the interactive columns; below this the layer would be untappable. */
const MIN_COLUMN_HEIGHT_PX = 96;

/**
 * Vertical tolerance around the column band, in CSS px. A finger drifting a few pixels above the
 * top edge (or below the bottom one) keeps its lane instead of being treated as a release; the
 * gap it has to cross to actually leave is still smaller than a thumb. This only ever *widens*
 * the columns: leaving the surface upwards is a deliberate, testable transition.
 */
const VERTICAL_SLACK_PX = 12;

export class TouchSurface {
  readonly root: HTMLElement;
  private readonly zones: HTMLElement[] = [];
  private readonly pads: HTMLElement[] = [];
  /** Client-space rectangles, one per lane, refreshed by `layout()`. */
  private lastRects: ZoneRect[] = [];
  private interactive = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.build();
    this.applyInteractive(false);
  }

  /**
   * Position the columns for a framing. Cheap (seven style writes) and idempotent, so it can be
   * called on every resize.
   */
  layout(container: TouchSurfaceLayout): void {
    const { laneCentersPx, usable, viewportWidth, viewportHeight } = container;
    const lanes = this.zones.length;
    if (laneCentersPx.length !== lanes) return;

    const top = clampNumber(container.topPx, usable.top, usable.top + usable.height - MIN_COLUMN_HEIGHT_PX);
    const bottom = usable.top + usable.height;
    const left = 0;
    const right = viewportWidth;

    // A PointerEvent carries `clientX`/`clientY`, so the cached rectangles have to be in the same
    // space for `laneAtPoint`. The layer is `inset: 0` inside #stage and is therefore normally at
    // (0, 0); reading the origin here (once per resize, before the style writes) keeps the slide
    // hit test correct even if the surface is ever offset — and keeps every `pointermove` free of
    // layout reads.
    this.originX = readOrigin(this.root, 'left');
    this.originY = readOrigin(this.root, 'top');

    const rects: ZoneRect[] = [];
    for (let lane = 0; lane < lanes; lane += 1) {
      const startBoundary = lane === 0 ? left : midpoint(laneCentersPx[lane - 1]!, laneCentersPx[lane]!);
      const endBoundary = lane === lanes - 1 ? right : midpoint(laneCentersPx[lane]!, laneCentersPx[lane + 1]!);
      const zoneLeft = clampNumber(startBoundary, left, right);
      const zoneRight = Math.max(zoneLeft + 1, clampNumber(endBoundary, left, right));
      rects.push({
        lane,
        left: zoneLeft + this.originX,
        right: zoneRight + this.originX,
        top: top + this.originY,
        bottom: bottom + this.originY,
      });

      const zone = this.zones[lane]!;
      zone.style.left = `${zoneLeft.toFixed(2)}px`;
      zone.style.width = `${(zoneRight - zoneLeft).toFixed(2)}px`;
      zone.style.top = `${top.toFixed(2)}px`;
      zone.style.height = `${Math.max(0, bottom - top).toFixed(2)}px`;
    }

    const padHeight = clampNumber(Math.round(viewportHeight * 0.12), 34, 84);
    for (const pad of this.pads) {
      pad.style.height = `${padHeight}px`;
    }
    this.lastRects = rects;
  }

  /** Convenience wrapper for a `Framing` plus the HUD-driven top edge. */
  layoutForFraming(framing: Framing, topPx: number, viewportWidth: number, viewportHeight: number): void {
    this.layout({
      laneCentersPx: framing.laneCentersPx,
      usable: framing.usable,
      topPx,
      viewportWidth,
      viewportHeight,
    });
  }

  /**
   * Enable or disable the columns. Disabled columns are `pointer-events: none` and hidden, so
   * menus behind them stay clickable and a stray tap on the ready screen does nothing.
   */
  setInteractive(interactive: boolean): void {
    if (this.interactive === interactive) return;
    this.applyInteractive(interactive);
  }

  private applyInteractive(interactive: boolean): void {
    this.interactive = interactive;
    this.root.dataset.interactive = interactive ? 'true' : 'false';
    this.root.hidden = !interactive;
    if (!interactive) this.clearLanes();
  }

  isInteractive(): boolean {
    return this.interactive;
  }

  /** Immediate per-finger feedback; safe to call for every pointer event. */
  setLaneActive(lane: number, active: boolean): void {
    const zone = this.zones[lane];
    if (!zone) return;
    zone.dataset.active = active ? 'true' : 'false';
  }

  clearLanes(): void {
    for (const zone of this.zones) zone.dataset.active = 'false';
  }

  /** Current column rectangles (client space), for tests and the debug API. */
  zoneRects(): ZoneRect[] {
    return this.lastRects.map((rect) => ({ ...rect }));
  }

  /**
   * Lane under a viewport point, or null when the point is outside the columns.
   *
   * Allocation free and O(lanes): the arrays are walked, nothing is built, and no DOM query or
   * layout read happens — this runs on every pointermove, including at 120 Hz.
   *
   * Returning null means "left the surface": the caller releases the lane the pointer was on and
   * presses it again when the finger comes back.
   */
  laneAtPoint(clientX: number, clientY: number): number | null {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    const rects = this.lastRects;
    for (let index = 0; index < rects.length; index += 1) {
      const rect = rects[index]!;
      if (clientX < rect.left || clientX >= rect.right) continue;
      if (clientY < rect.top - VERTICAL_SLACK_PX || clientY > rect.bottom + VERTICAL_SLACK_PX) continue;
      return rect.lane;
    }
    return null;
  }

  // ------------------------------------------------------------------ build ---

  private originX = 0;
  private originY = 0;

  private build(): void {
    this.root.replaceChildren();
    this.zones.length = 0;
    this.pads.length = 0;
    for (let lane = 0; lane < LANE_KEYS.length; lane += 1) {
      const zone = document.createElement('div');
      zone.className = 'touch-zone';
      zone.dataset.lane = String(lane);
      zone.dataset.active = 'false';
      zone.setAttribute('aria-hidden', 'true');
      zone.style.setProperty('--lane-color', colorFor(lane));

      const pad = document.createElement('div');
      pad.className = 'touch-pad';
      const label = document.createElement('span');
      label.className = 'touch-pad-label';
      label.textContent = LANE_KEYS[lane]!.label === 'SPACE' ? '␣' : LANE_KEYS[lane]!.label;
      pad.appendChild(label);
      zone.appendChild(pad);

      this.root.appendChild(zone);
      this.zones.push(zone);
      this.pads.push(pad);
    }
  }
}

function colorFor(lane: number): string {
  return `#${LANE_COLORS[lane % LANE_COLORS.length]!.toString(16).padStart(6, '0')}`;
}

function midpoint(a: number, b: number): number {
  return (a + b) / 2;
}

/** Offset of the surface in the viewport, guarded for environments without layout (jsdom). */
function readOrigin(root: HTMLElement, side: 'left' | 'top'): number {
  const rect = root.getBoundingClientRect();
  const value = rect[side];
  return Number.isFinite(value) ? value : 0;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (max < min) return min;
  return value < min ? min : value > max ? max : value;
}
