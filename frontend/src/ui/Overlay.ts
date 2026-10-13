/**
 * Overlay — the modal panels (loading / ready / paused / results) plus the settings controls.
 *
 * Owns the SettingsStore because the settings live in the ready panel, and notifies the app
 * through a callback whenever a value changes so the running game can pick it up immediately
 * (note speed and volume are safe to change mid-song; the offset is read on every judgment).
 */

import type { GameSettings } from '../game/GameConfig';
import { NOTE_SPEED_LIMITS, OFFSET_LIMITS } from '../game/GameConfig';
import { LANE_PALETTES, lanePalette } from '../renderer/Layout';
import type { SettingsStore } from '../storage/SettingsStore';
import { el, setHidden, setText } from './dom';

export type PanelName = 'loading' | 'ready' | 'pause' | 'results' | 'import' | null;

export interface OverlayCallbacks {
  onStart(): void;
  /** Open the MP3 import workflow (phase 2). */
  onOpenImport(): void;
  onPause(): void;
  onResume(): void;
  onRestart(): void;
  onBackToMenu(): void;
  onSettingsChange(settings: GameSettings): void;
}

const PANEL_IDS: Record<Exclude<PanelName, null>, string> = {
  loading: 'panel-loading',
  ready: 'panel-ready',
  pause: 'panel-pause',
  results: 'panel-results',
  import: 'panel-import',
};

export class Overlay {
  private readonly root = el('overlay');
  private readonly errorBanner = el('error-banner');
  private readonly loadingStatus = el('loading-status');
  private readonly loadingProgress = el('loading-progress');
  private readonly offsetInput = el<HTMLInputElement>('setting-offset');
  private readonly offsetValue = el('setting-offset-value');
  private readonly speedInput = el<HTMLInputElement>('setting-speed');
  private readonly speedValue = el('setting-speed-value');
  private readonly volumeInput = el<HTMLInputElement>('setting-volume');
  private readonly volumeValue = el('setting-volume-value');
  private readonly paletteSelect = el<HTMLSelectElement>('setting-palette');
  private current: PanelName = 'loading';
  private errorMessage: string | null = null;

  constructor(
    private readonly settings: SettingsStore,
    private readonly callbacks: OverlayCallbacks,
  ) {
    this.offsetInput.min = String(OFFSET_LIMITS.min);
    this.offsetInput.max = String(OFFSET_LIMITS.max);
    this.offsetInput.step = String(OFFSET_LIMITS.step);
    this.speedInput.min = String(NOTE_SPEED_LIMITS.min);
    this.speedInput.max = String(NOTE_SPEED_LIMITS.max);
    this.speedInput.step = String(NOTE_SPEED_LIMITS.step);

    // The lane palette is a choice between named themes, so it is a select built from the single
    // catalogue in `renderer/Layout` — there is no second list of names or colours to drift.
    this.paletteSelect.replaceChildren();
    for (const palette of LANE_PALETTES) {
      const option = document.createElement('option');
      option.value = palette.id;
      option.textContent = palette.name;
      this.paletteSelect.appendChild(option);
    }

    this.bindSettings();

    el('btn-start').addEventListener('click', () => this.callbacks.onStart());
    el('btn-open-import').addEventListener('click', () => this.callbacks.onOpenImport());
    el('btn-resume').addEventListener('click', () => this.callbacks.onResume());
    el('btn-restart').addEventListener('click', () => this.callbacks.onRestart());
    el('btn-restart-2').addEventListener('click', () => this.callbacks.onRestart());
    el('btn-retry').addEventListener('click', () => this.callbacks.onRestart());
    el('btn-back').addEventListener('click', () => this.callbacks.onBackToMenu());
    el('btn-back-2').addEventListener('click', () => this.callbacks.onBackToMenu());
    el('btn-pause').addEventListener('click', () => this.callbacks.onPause());

    this.syncSettingsInputs();
    this.showPanel('loading');
  }

  showPanel(panel: PanelName): void {
    this.current = panel;
    for (const [name, id] of Object.entries(PANEL_IDS)) {
      setHidden(el(id), name !== panel);
    }
    setHidden(this.root, panel === null);
  }

  get panel(): PanelName {
    return this.current;
  }

  setLoading(ratio: number, label?: string): void {
    this.loadingProgress.style.width = `${Math.min(1, Math.max(0, ratio)) * 100}%`;
    if (label) setText(this.loadingStatus, label);
  }

  syncSettingsInputs(): void {
    const settings = this.settings.get();
    this.offsetInput.value = String(settings.globalOffsetMs);
    this.speedInput.value = String(settings.noteSpeed);
    this.volumeInput.value = String(Math.round(settings.volume * 100));
    this.paletteSelect.value = lanePalette(settings.lanePalette).id;
    setText(this.offsetValue, `${settings.globalOffsetMs > 0 ? '+' : ''}${settings.globalOffsetMs} ms`);
    setText(this.speedValue, `${settings.noteSpeed.toFixed(1)}×`);
    setText(this.volumeValue, `${Math.round(settings.volume * 100)}%`);
  }

  setError(message: string | null): void {
    this.errorMessage = message;
    setText(this.errorBanner, message ?? '');
    setHidden(this.errorBanner, message === null);
  }

  getError(): string | null {
    return this.errorMessage;
  }

  private bindSettings(): void {
    this.offsetInput.addEventListener('input', () => {
      const next = this.settings.update({ globalOffsetMs: Number(this.offsetInput.value) });
      this.syncSettingsInputs();
      this.callbacks.onSettingsChange(next);
    });
    this.speedInput.addEventListener('input', () => {
      const next = this.settings.update({ noteSpeed: Number(this.speedInput.value) });
      this.syncSettingsInputs();
      this.callbacks.onSettingsChange(next);
    });
    this.volumeInput.addEventListener('input', () => {
      const next = this.settings.update({ volume: Number(this.volumeInput.value) / 100 });
      this.syncSettingsInputs();
      this.callbacks.onSettingsChange(next);
    });
    this.paletteSelect.addEventListener('change', () => {
      const next = this.settings.update({ lanePalette: this.paletteSelect.value });
      this.syncSettingsInputs();
      this.callbacks.onSettingsChange(next);
    });
  }
}
