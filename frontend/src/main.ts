/**
 * Bootstrap.
 *
 * Also installs `window.SevenKeys`, a small console/debug surface. It exists so the game can
 * be inspected and driven from the browser console (and from an automated smoke check) without
 * opening the UI: `SevenKeys.app.debugState()`, `SevenKeys.seek(20000)`, `SevenKeys.start()`.
 */

import './styles.css';
import { GameApp } from './ui/GameApp';
import { assertDomContract } from './ui/dom';

const VERSION = '0.3.1-phase3.1';

interface SevenKeysDebugApi {
  version: string;
  app: GameApp;
  state: () => Record<string, unknown>;
  /** Camera framing, touch column rectangles and device capabilities for the current viewport. */
  layout: () => Record<string, unknown>;
  /** Phase 2 analysis/diagnostics numbers for the currently loaded song. */
  diagnostics: () => unknown;
  /** Difficulties of the current song and which one is loaded (phase 3). */
  difficulties: () => Record<string, unknown>;
  /** Switch difficulty of the current song (no re-analysis). */
  setDifficulty: (difficulty: string) => Promise<void>;
  /** Open the import panel (same as the ready-panel button). */
  openImport: () => void;
  /** QA hook: import audio from a URL as if it had been selected locally. */
  importUrl: (url: string, name?: string) => Promise<void>;
  start: () => void;
  pause: () => void;
  resume: () => void;
  restart: () => void;
  seek: (songTimeMs: number) => void;
}

declare global {
  interface Window {
    SevenKeys?: SevenKeysDebugApi;
  }
}

function showFatalError(message: string): void {
  const banner = document.getElementById('error-banner');
  if (banner) {
    banner.textContent = message;
    banner.hidden = false;
  }
  const status = document.getElementById('loading-status');
  if (status) status.textContent = message;
  console.error('[Seven Keys]', message);
}

async function main(): Promise<void> {
  assertDomContract();

  const canvas = document.getElementById('game-canvas');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('expected <canvas id="game-canvas"> in the document');
  }

  const app = new GameApp(canvas);
  window.SevenKeys = {
    version: VERSION,
    app,
    state: () => app.debugState(),
    layout: () => {
      const state = app.debugState();
      return {
        framing: state['framing'],
        touch: state['touch'],
        device: state['device'],
      };
    },
    diagnostics: () => app.debugState()['diagnostics'] ?? null,
    difficulties: () => (app.debugState()['difficulties'] as Record<string, unknown>) ?? {},
    setDifficulty: async (difficulty: string) => {
      const known = app.availableDifficulties;
      if (difficulty !== 'easy' && difficulty !== 'normal' && difficulty !== 'hard') {
        throw new Error(`unknown difficulty: ${difficulty} (available: ${known.join(', ') || 'none'})`);
      }
      await app.setDifficulty(difficulty);
    },
    openImport: () => app.openImportPanel(),
    importUrl: (url: string, name?: string) => app.importFromUrl(url, name),
    start: () => void app.start(),
    pause: () => app.pause(false),
    resume: () => void app.resume(),
    restart: () => void app.restart(),
    seek: (songTimeMs: number) => app.seekTo(songTimeMs),
  };

  await app.init();
  console.info(`[Seven Keys] ${VERSION} ready — try window.SevenKeys.state()`);
}

void main().catch((error: unknown) => {
  showFatalError(error instanceof Error ? `Seven Keys failed to start: ${error.message}` : String(error));
});
