// @vitest-environment jsdom
/**
 * OrientationGate tests: portrait detection and the overlay, the pause/resume handshake, the
 * fullscreen/orientation-lock outcomes (including the unsupported and rejected paths) and the
 * "never nag twice" rule.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IMMERSIVE_FLAG_KEY, OrientationGate } from '../src/ui/OrientationGate';

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, writable: true, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, writable: true, configurable: true });
}

function memoryStorage(): { store: Map<string, string>; getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

interface Setup {
  gate: OrientationGate;
  overlay: HTMLElement;
  target: HTMLElement;
  button: HTMLButtonElement;
  storage: ReturnType<typeof memoryStorage>;
  portrait: number;
  settled: number;
  results: string[];
  setPortrait(value: boolean): void;
  setEnabled(value: boolean): void;
}

function setup(options: { enabled?: boolean; storage?: ReturnType<typeof memoryStorage> | null; settleMs?: number } = {}): Setup {
  const overlay = document.createElement('div');
  overlay.hidden = true;
  const target = document.createElement('div');
  const button = document.createElement('button');
  const label = document.createElement('span');
  label.dataset['role'] = 'label';
  button.appendChild(label);
  document.body.append(overlay, target, button);

  let enabled = options.enabled ?? true;
  const storage = options.storage === undefined ? memoryStorage() : options.storage;
  const counters = { portrait: 0, settled: 0 };
  const results: string[] = [];

  const gate = new OrientationGate({
    win: window,
    doc: document,
    fullscreenTarget: target,
    overlay,
    fullscreenButtons: [button],
    storage,
    enabled: () => enabled,
    onPortraitEntered: () => {
      counters.portrait += 1;
    },
    onLandscapeSettled: () => {
      counters.settled += 1;
    },
    onImmersiveResult: (result) => results.push(`${result.fullscreen}/${result.lock}`),
    settleMs: options.settleMs ?? 20,
    requestTimeoutMs: 30,
  });
  gate.start();

  return {
    gate,
    overlay,
    target,
    button,
    storage: storage as ReturnType<typeof memoryStorage>,
    get portrait() {
      return counters.portrait;
    },
    get settled() {
      return counters.settled;
    },
    results,
    setPortrait(value: boolean) {
      setViewport(value ? 360 : 800, value ? 800 : 360);
      window.dispatchEvent(new Event('resize'));
    },
    setEnabled(value: boolean) {
      enabled = value;
      gate.evaluate();
    },
  } as Setup;
}

beforeEach(() => {
  setViewport(800, 360);
  document.body.replaceChildren();
});

afterEach(() => {
  vi.useRealTimers();
  // A stubbed exitFullscreen cannot clear jsdom's own property, so reset it between tests.
  Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
  Object.defineProperty(document, 'exitFullscreen', { value: undefined, configurable: true });
  // jsdom has no screen orientation API; give each test a clean one so a stub cannot leak.
  Object.defineProperty(window, 'screen', { value: { orientation: {} }, configurable: true });
  document.body.replaceChildren();
});

describe('portrait detection and the rotate overlay', () => {
  it('shows the overlay in portrait and hides it again in landscape', () => {
    const s = setup();
    expect(s.gate.portrait).toBe(false);
    expect(s.overlay.hidden).toBe(true);
    expect(s.portrait).toBe(0);

    s.setPortrait(true);
    expect(s.gate.portrait).toBe(true);
    expect(s.gate.showingOverlay).toBe(true);
    expect(s.overlay.hidden).toBe(false);
    expect(s.portrait).toBe(1);

    // A second resize while still in portrait must not fire another pause.
    window.dispatchEvent(new Event('resize'));
    expect(s.portrait).toBe(1);

    s.setPortrait(false);
    expect(s.overlay.hidden).toBe(true);
    expect(s.gate.portrait).toBe(false);
    expect(s.settled).toBe(0); // nothing to resume yet
  });

  it('pauses on portrait and reports the layout as settled only after the viewport stops moving', () => {
    vi.useFakeTimers();
    const s = setup({ settleMs: 200 });
    s.setPortrait(true);
    s.setPortrait(false);
    expect(s.settled).toBe(0);
    expect(s.gate.settlePending).toBe(true);

    vi.advanceTimersByTime(150);
    expect(s.settled).toBe(0);

    vi.advanceTimersByTime(100);
    expect(s.settled).toBe(1);
    expect(s.gate.settlePending).toBe(false);
  });

  it('captures the device back into portrait during the settle window', () => {
    vi.useFakeTimers();
    const s = setup({ settleMs: 200 });
    s.setPortrait(true);
    s.setPortrait(false);
    s.setPortrait(true);
    vi.advanceTimersByTime(400);
    expect(s.settled).toBe(0);
    expect(s.gate.portrait).toBe(true);
    expect(s.portrait).toBe(2);
  });

  it('never gates a non-touch layout', () => {
    const s = setup({ enabled: false });
    s.setPortrait(true);
    expect(s.gate.portrait).toBe(true);
    expect(s.overlay.hidden).toBe(true);
    expect(s.portrait).toBe(1);
  });

  it('stops gating for the session when the player continues in portrait', () => {
    vi.useFakeTimers();
    const s = setup({ settleMs: 200 });
    s.setPortrait(true);
    expect(s.overlay.hidden).toBe(false);
    s.gate.dismiss();
    expect(s.overlay.hidden).toBe(true);
    expect(s.settled).toBe(1); // continuing means "let the game run"

    window.dispatchEvent(new Event('resize'));
    expect(s.overlay.hidden).toBe(true);
    expect(s.gate.portrait).toBe(true);
  });

  it('stops listening after stop()', () => {
    const s = setup();
    s.gate.stop();
    s.setPortrait(true);
    expect(s.portrait).toBe(0);
  });
});

describe('fullscreen and orientation lock', () => {
  it('reports unsupported when the platform has no fullscreen API', async () => {
    const s = setup();
    expect('requestFullscreen' in s.target).toBe(false);
    expect(await s.gate.enterFullscreen()).toBe('unsupported');
    expect(await s.gate.toggleFullscreen()).toBe('unsupported');
  });

  it('enters and leaves fullscreen, and updates the button', async () => {
    const s = setup();
    const request = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(s.target, 'requestFullscreen', { value: request, configurable: true });
    Object.defineProperty(document, 'exitFullscreen', { value: exit, configurable: true });

    expect(await s.gate.enterFullscreen()).toBe('entered');
    expect(request).toHaveBeenCalledWith({ navigationUI: 'hide' });
    expect(s.button.title).toBe('Enter fullscreen'); // still not actually fullscreen in jsdom

    Object.defineProperty(document, 'fullscreenElement', { value: s.target, configurable: true });
    s.gate.syncFullscreenButtons();
    expect(s.gate.fullscreen).toBe(true);
    expect(s.button.title).toBe('Exit fullscreen');
    expect(s.button.querySelector('[data-role="label"]')!.textContent).toContain('Exit');

    expect(await s.gate.toggleFullscreen()).toBe('exited');
    expect(exit).toHaveBeenCalled();
  });

  it('treats a rejected fullscreen request as a normal outcome', async () => {
    const s = setup();
    Object.defineProperty(s.target, 'requestFullscreen', {
      value: vi.fn().mockRejectedValue(new Error('not allowed')),
      configurable: true,
    });
    expect(await s.gate.enterFullscreen()).toBe('rejected');
    expect(await s.gate.enterImmersive()).toEqual({ fullscreen: 'rejected', lock: 'skipped' });
    expect(s.results).toEqual(['rejected/skipped']);
  });

  it('reports the orientation lock outcomes without throwing', async () => {
    const s = setup();
    Object.defineProperty(s.target, 'requestFullscreen', { value: vi.fn().mockResolvedValue(undefined), configurable: true });
    // Firefox: no lock at all
    expect(await s.gate.lockLandscape()).toBe('unsupported');

    const lock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'screen', { value: { orientation: { lock } }, configurable: true });
    expect(await s.gate.lockLandscape()).toBe('locked');
    expect(lock).toHaveBeenCalledWith('landscape');

    lock.mockRejectedValueOnce(new Error('not fullscreen'));
    expect(await s.gate.lockLandscape()).toBe('rejected');
    expect(await s.gate.enterImmersive()).toEqual({ fullscreen: 'entered', lock: 'locked' });
    expect(s.results.at(-1)).toBe('entered/locked');
  });

  it('gives up on a fullscreen promise that never settles instead of hanging', async () => {
    const s = setup();
    Object.defineProperty(s.target, 'requestFullscreen', {
      value: vi.fn(() => new Promise<void>(() => undefined)), // never settles (WebView behaviour)
      configurable: true,
    });
    expect(await s.gate.enterFullscreen()).toBe('timeout');
    // fullscreen never became active, so locking the orientation would be pointless
    expect(await s.gate.enterImmersive()).toEqual({ fullscreen: 'timeout', lock: 'skipped' });
    expect(s.results.at(-1)).toBe('timeout/skipped');
  });

  it('reports a lock request that never settles as a timeout', async () => {
    const s = setup();
    Object.defineProperty(window, 'screen', {
      value: { orientation: { lock: vi.fn(() => new Promise<void>(() => undefined)) } },
      configurable: true,
    });
    expect(await s.gate.lockLandscape()).toBe('timeout');
  });

  it('asks for immersive mode only once', async () => {
    const s = setup();
    const request = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(s.target, 'requestFullscreen', { value: request, configurable: true });

    // fullscreen went through, but this platform has no orientation lock to ask for
    expect(await s.gate.requestImmersiveOnce()).toEqual({ fullscreen: 'entered', lock: 'unsupported' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(s.storage.store.get(IMMERSIVE_FLAG_KEY)).toBe('1');

    expect(await s.gate.requestImmersiveOnce()).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not nag when a previous session already asked', async () => {
    const storage = memoryStorage();
    storage.setItem(IMMERSIVE_FLAG_KEY, '1');
    const s = setup({ storage });
    const request = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(s.target, 'requestFullscreen', { value: request, configurable: true });
    expect(await s.gate.requestImmersiveOnce()).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(s.gate.immersiveRequested).toBe(true);
  });

  it('behaves as "already asked" when storage is unavailable', async () => {
    const s = setup({ storage: null });
    expect(s.gate.immersiveRequested).toBe(true);
    expect(await s.gate.requestImmersiveOnce()).toBeNull();
  });
});
