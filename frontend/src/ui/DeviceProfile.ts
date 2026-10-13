/**
 * DeviceProfile — what kind of device we are running on, and how much of the screen is usable.
 *
 * Two questions, both of which the layout needs an answer to before the first frame:
 *
 *  1. *Is this a touch-first device?* The answer selects the touch-control layout (big lane
 *     columns, pads at the bottom, compact HUD). A hybrid laptop must NOT get the touch
 *     layout just because it has a touchscreen, so the primary-pointer media query
 *     (`pointer: coarse`) is required in addition to `maxTouchPoints`. A device with a
 *     trackpad or mouse reports `pointer: fine` and keeps the keyboard layout.
 *
 *  2. *Where are the display cutouts?* CSS `env(safe-area-inset-*)` is the only way to learn
 *     this, and it is only readable through computed style. We resolve it once per resize with
 *     a hidden probe element rather than guessing padding values in CSS, so the camera framing
 *     and the touch columns can both respect the notch in landscape.
 *
 * Both are pure functions of their inputs (`matchMedia` results, a query string, computed
 * style), so the whole module is unit testable without a real device — and a `?touch=1`
 * override makes the mobile layout reproducible in a desktop browser for verification.
 */

import type { SafeInsets } from '../renderer/CameraFraming';

export type TouchOverride = 'touch' | 'desktop' | null;

export interface DeviceProfile {
  /** True when the touch-control layout should be used. */
  touchLayout: boolean;
  /** True when a coarse (finger) pointer is the primary input. */
  coarsePointer: boolean;
  /** `navigator.maxTouchPoints`, clamped to a sane range. */
  maxTouchPoints: number;
  /** Explicit `?touch=` override, if any. */
  forced: TouchOverride;
  /** Display cutout insets in CSS px. */
  safeInsets: SafeInsets;
}

export interface PointerCapability {
  coarsePointer: boolean;
  maxTouchPoints: number;
  /** `?touch=1` / `?touch=0` from the URL, for debugging and automated checks. */
  forced?: TouchOverride;
}

/**
 * Touch layout = a coarse primary pointer AND at least one touch point, unless overridden.
 * A user with a mouse plugged into a phone keeps the touch layout (the coarse pointer is still
 * the primary one); a desktop with a touchscreen keeps the keyboard layout.
 */
export function resolveTouchLayout(input: PointerCapability): boolean {
  if (input.forced === 'touch') return true;
  if (input.forced === 'desktop') return false;
  return input.coarsePointer && clampInteger(input.maxTouchPoints, 0, 64) > 0;
}

/** Parse `?touch=1|0|true|false` from a location search string. Anything else is ignored. */
export function parseTouchOverride(search: string): TouchOverride {
  const match = /[?&]touch=([^&]*)/.exec(search);
  if (!match) return null;
  const value = match[1]!.toLowerCase();
  if (value === '1' || value === 'true' || value === 'yes' || value === 'mobile') return 'touch';
  if (value === '0' || value === 'false' || value === 'no' || value === 'desktop') return 'desktop';
  return null;
}

/** `"12px"` -> 12, `""`/garbage/negative -> 0. */
export function parsePx(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

/**
 * Read the display-cutout insets. A hidden probe with one `env()` per side is the only
 * portable way: the values cannot be queried directly and the probe must be in the layout to
 * resolve them.
 */
export function readSafeAreaInsets(
  root: HTMLElement,
  readStyle: (element: HTMLElement) => CSSStyleDeclaration,
): SafeInsets {
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.position = 'fixed';
  probe.style.top = '0';
  probe.style.left = '0';
  probe.style.width = '0';
  probe.style.height = '0';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  probe.style.paddingTop = 'env(safe-area-inset-top, 0px)';
  probe.style.paddingRight = 'env(safe-area-inset-right, 0px)';
  probe.style.paddingBottom = 'env(safe-area-inset-bottom, 0px)';
  probe.style.paddingLeft = 'env(safe-area-inset-left, 0px)';
  root.appendChild(probe);
  try {
    const style = readStyle(probe);
    return {
      top: parsePx(style.paddingTop),
      right: parsePx(style.paddingRight),
      bottom: parsePx(style.paddingBottom),
      left: parsePx(style.paddingLeft),
    };
  } finally {
    probe.remove();
  }
}

/** Read the live capability from the browser, unless `search` overrides it. */
export function readDeviceProfile(
  win: Window = window,
  root: HTMLElement | null = null,
  search: string = win.location?.search ?? '',
): DeviceProfile {
  const coarsePointer = safeMatchMedia(win, '(pointer: coarse)');
  const maxTouchPoints = clampInteger(win.navigator?.maxTouchPoints ?? 0, 0, 64);
  const forced = parseTouchOverride(search);
  return {
    touchLayout: resolveTouchLayout({ coarsePointer, maxTouchPoints, forced }),
    coarsePointer,
    maxTouchPoints,
    forced,
    safeInsets:
      root && typeof win.getComputedStyle === 'function'
        ? readSafeAreaInsets(root, (element) => win.getComputedStyle(element))
        : { top: 0, right: 0, bottom: 0, left: 0 },
  };
}

function safeMatchMedia(win: Window, query: string): boolean {
  if (typeof win.matchMedia !== 'function') return false;
  try {
    return win.matchMedia(query).matches;
  } catch {
    return false;
  }
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
