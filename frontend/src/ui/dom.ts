/**
 * Typed DOM helpers.
 *
 * `index.html` owns the UI skeleton and this module is the contract between it and
 * TypeScript: `assertDomContract()` runs at boot and fails loudly (in the error banner) if an
 * id was renamed or removed, instead of producing a silent undefined crash mid-song.
 */

const cache = new Map<string, HTMLElement>();

export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const cached = cache.get(id);
  if (cached) return cached as T;
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`DOM contract violated: expected element #${id} (see frontend/index.html)`);
  }
  cache.set(id, node);
  return node as T;
}

/** Every id that src/ui/*.ts depends on. Keep in sync with index.html. */
export const REQUIRED_DOM_IDS: readonly string[] = [
  'game-canvas',
  'touch-layer',
  'hud',
  'hud-stats',
  'hud-song-title',
  'hud-song-sub',
  'hud-score',
  'hud-time',
  'hud-fps',
  'hud-progress',
  'stat-accuracy',
  'stat-maxcombo',
  'stat-perfect',
  'stat-good',
  'stat-bad',
  'stat-miss',
  'stat-holds',
  'hud-combo',
  'hud-combo-value',
  'judgement-layer',
  'hud-countdown',
  'key-hints',
  'btn-pause',
  'btn-restart',
  'btn-fullscreen',
  'btn-fullscreen-ready',
  'btn-fullscreen-rotate',
  'btn-portrait-continue',
  'rotate-overlay',
  'overlay',
  'panel-loading',
  'loading-status',
  'loading-progress',
  'panel-ready',
  'setting-offset',
  'setting-offset-value',
  'setting-speed',
  'setting-speed-value',
  'setting-volume',
  'setting-volume-value',
  'btn-start',
  'panel-pause',
  'btn-resume',
  'btn-restart-2',
  'btn-back',
  'panel-results',
  'result-grade',
  'result-score',
  'result-accuracy',
  'result-maxcombo',
  'result-perfect',
  'result-good',
  'result-bad',
  'result-miss',
  'result-holds-completed',
  'result-holds-broken',
  'result-stray',
  'result-notes',
  'btn-retry',
  'btn-back-2',
  // phase 2: import + library + diagnostics
  'btn-open-import',
  'panel-import',
  'import-drop',
  'import-file',
  'import-file-name',
  'import-title',
  'import-seed',
  'import-save',
  'import-ogg',
  'import-ogg-hint',
  'import-progress-wrap',
  'import-stage',
  'import-progress',
  'import-status',
  'import-error',
  'import-results',
  'import-analyzed-title',
  'import-stats',
  'import-stat-bpm',
  'import-stat-confidence',
  'import-stat-beats',
  'import-stat-onsets',
  'import-stat-notes',
  'import-stat-density',
  'import-stat-analysis',
  'import-warnings',
  'btn-import-play',
  'btn-diagnostics',
  'btn-import-back',
  'library-list',
  'library-note',
  // phase 2.1: diagnostics live inside the import panel (no floating window any more)
  'diag-panel',
  'diag-source',
  'diag-numbers',
  'diag-warnings',
  'diag-lows',
  'diag-advanced',
  'diag-timeline',
  'diag-tables',
  'diag-selection',
  'btn-preview-section',
  'btn-preview-stop',
  'preview-beats',
  'preview-notes',
  'preview-info',
  'error-banner',
];

export function assertDomContract(): void {
  const missing = REQUIRED_DOM_IDS.filter((id) => document.getElementById(id) === null);
  if (missing.length > 0) {
    throw new Error(`DOM contract violated: missing #${missing.join(', #')}`);
  }
}

/** Write text only when it changed: avoids pointless layout work every frame. */
export function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

/** Write an attribute only when it changed. */
export function setAttr(node: HTMLElement, name: string, value: string): void {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

export function setHidden(node: HTMLElement, hidden: boolean): void {
  if (node.hidden !== hidden) node.hidden = hidden;
}

/** Restart a CSS animation on a reused element (for pooled popups). */
export function restartAnimation(node: HTMLElement): void {
  node.style.animation = 'none';
  // Force a reflow so the browser registers the cleared animation before it is restored.
  void node.offsetWidth;
  node.style.animation = '';
}

export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function formatPercent(value: number, digits = 2): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatOffset(ms: number): string {
  const rounded = Math.round(ms);
  return `${rounded > 0 ? '+' : ''}${rounded} ms`;
}
