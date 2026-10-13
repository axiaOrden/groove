// @vitest-environment jsdom
/**
 * DeviceProfile tests: the touch-layout decision, the `?touch=` override, px parsing and the
 * cutout probe. All of it is injected, so a hybrid laptop, a phone and a machine without the
 * APIs can all be simulated.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parsePx,
  parseTouchOverride,
  readDeviceProfile,
  readSafeAreaInsets,
  resolveTouchLayout,
} from '../src/ui/DeviceProfile';

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('resolveTouchLayout', () => {
  it('requires a coarse primary pointer and a touch point', () => {
    expect(resolveTouchLayout({ coarsePointer: true, maxTouchPoints: 5 })).toBe(true);
    // hybrid laptop / touchscreen desktop: the primary pointer is still the trackpad
    expect(resolveTouchLayout({ coarsePointer: false, maxTouchPoints: 10 })).toBe(false);
    expect(resolveTouchLayout({ coarsePointer: true, maxTouchPoints: 0 })).toBe(false);
    expect(resolveTouchLayout({ coarsePointer: false, maxTouchPoints: 0 })).toBe(false);
  });

  it('honours an explicit override in both directions', () => {
    expect(resolveTouchLayout({ coarsePointer: false, maxTouchPoints: 0, forced: 'touch' })).toBe(true);
    expect(resolveTouchLayout({ coarsePointer: true, maxTouchPoints: 5, forced: 'desktop' })).toBe(false);
  });
});

describe('parseTouchOverride', () => {
  it('reads the supported spellings and ignores anything else', () => {
    expect(parseTouchOverride('?touch=1')).toBe('touch');
    expect(parseTouchOverride('?touch=true')).toBe('touch');
    expect(parseTouchOverride('?touch=mobile')).toBe('touch');
    expect(parseTouchOverride('?touch=0')).toBe('desktop');
    expect(parseTouchOverride('?touch=false')).toBe('desktop');
    expect(parseTouchOverride('?foo=1&touch=desktop&bar=2')).toBe('desktop');
    expect(parseTouchOverride('?touch=maybe')).toBeNull();
    expect(parseTouchOverride('')).toBeNull();
    expect(parseTouchOverride('?touch')).toBeNull();
  });
});

describe('parsePx', () => {
  it('parses lengths and rejects nonsense', () => {
    expect(parsePx('12px')).toBe(12);
    expect(parsePx('44px')).toBe(44);
    expect(parsePx('7.5px')).toBe(7.5);
    expect(parsePx('0px')).toBe(0);
    expect(parsePx('-4px')).toBe(0);
    expect(parsePx('')).toBe(0);
    expect(parsePx(null)).toBe(0);
    expect(parsePx('abc')).toBe(0);
  });
});

describe('readSafeAreaInsets', () => {
  it('reads the four env() probes from computed style and removes the probe again', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const insets = readSafeAreaInsets(root, () => ({ paddingTop: '0px', paddingRight: '44px', paddingBottom: '2px', paddingLeft: '0px' }) as CSSStyleDeclaration);
    expect(insets).toEqual({ top: 0, right: 44, bottom: 2, left: 0 });
    expect(root.childElementCount).toBe(0);
  });

  it('falls back to zero when the browser does not resolve the env() values', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const insets = readSafeAreaInsets(root, () => ({ paddingTop: '', paddingRight: '', paddingBottom: '', paddingLeft: '' }) as CSSStyleDeclaration);
    expect(insets).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});

describe('readDeviceProfile', () => {
  function fakeWindow(options: { coarse: boolean; touchPoints: number; search?: string }): Window {
    return {
      matchMedia: (query: string) => ({ matches: query === '(pointer: coarse)' ? options.coarse : false }),
      navigator: { maxTouchPoints: options.touchPoints },
      location: { search: options.search ?? '' },
      getComputedStyle: () => ({ paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '38px' }),
    } as unknown as Window;
  }

  it('detects a phone and reads its cutout', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const profile = readDeviceProfile(fakeWindow({ coarse: true, touchPoints: 5 }), root);
    expect(profile.touchLayout).toBe(true);
    expect(profile.coarsePointer).toBe(true);
    expect(profile.maxTouchPoints).toBe(5);
    expect(profile.forced).toBeNull();
    expect(profile.safeInsets.left).toBe(38);
  });

  it('keeps a touchscreen desktop on the keyboard layout', () => {
    const profile = readDeviceProfile(fakeWindow({ coarse: false, touchPoints: 10 }), null);
    expect(profile.touchLayout).toBe(false);
    expect(profile.safeInsets).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('lets the query string force either layout', () => {
    expect(readDeviceProfile(fakeWindow({ coarse: false, touchPoints: 0, search: '?touch=1' }), null).touchLayout).toBe(true);
    expect(readDeviceProfile(fakeWindow({ coarse: true, touchPoints: 5, search: '?touch=0' }), null).touchLayout).toBe(false);
  });

  it('survives a window without matchMedia or navigator touch support', () => {
    const bare = { location: { search: '' }, navigator: {} } as unknown as Window;
    const profile = readDeviceProfile(bare, null);
    expect(profile.touchLayout).toBe(false);
    expect(profile.maxTouchPoints).toBe(0);
  });
});
