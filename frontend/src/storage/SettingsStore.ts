/**
 * SettingsStore — small player settings in localStorage.
 *
 * README guidance: localStorage is for small preferences only. Charts, decoded audio and
 * drafts belong in IndexedDB (phase 4). The key is versioned so a future schema change can be
 * migrated instead of throwing away the player's calibration.
 *
 * Every read is defensive: a hand-edited or corrupt value falls back to the default rather
 * than poisoning gameplay. Storage access is wrapped because private browsing modes can throw
 * on `localStorage` access itself.
 */

import type { GameSettings } from '../game/GameConfig';
import { DEFAULT_SETTINGS, NOTE_SPEED_LIMITS, OFFSET_LIMITS, clampLanePalette } from '../game/GameConfig';

export const SETTINGS_STORAGE_KEY = 'seven-keys.settings.v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function safeStorage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const probe = '__seven_keys_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

export function clampSettings(input: Partial<GameSettings>): GameSettings {
  const merged = { ...DEFAULT_SETTINGS, ...input };
  return {
    globalOffsetMs: clamp(roundToStep(merged.globalOffsetMs, OFFSET_LIMITS.step), OFFSET_LIMITS.min, OFFSET_LIMITS.max),
    noteSpeed: clamp(roundToStep(merged.noteSpeed, NOTE_SPEED_LIMITS.step), NOTE_SPEED_LIMITS.min, NOTE_SPEED_LIMITS.max),
    volume: clamp(merged.volume, 0, 1),
    // A removed or renamed palette must not poison the setting: the id is validated against the
    // palette catalogue and falls back to the default theme.
    lanePalette: clampLanePalette(merged.lanePalette),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min === 0 ? 0 : min;
  return Math.min(max, Math.max(min, value));
}

function roundToStep(value: number, step: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value / step) * step;
}

export class SettingsStore {
  private current: GameSettings;
  private readonly storage: StorageLike | null;

  constructor(storage: StorageLike | null = safeStorage()) {
    this.storage = storage;
    this.current = this.read();
  }

  get(): GameSettings {
    return { ...this.current };
  }

  update(partial: Partial<GameSettings>): GameSettings {
    this.current = clampSettings({ ...this.current, ...partial });
    this.persist();
    return this.get();
  }

  reset(): GameSettings {
    this.current = { ...DEFAULT_SETTINGS };
    this.persist();
    return this.get();
  }

  /** True when persistence is actually available (false in private mode / sandboxed frames). */
  get persistent(): boolean {
    return this.storage !== null;
  }

  private read(): GameSettings {
    if (!this.storage) return { ...DEFAULT_SETTINGS };
    try {
      const raw = this.storage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_SETTINGS };
      return clampSettings(parsed as Partial<GameSettings>);
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(this.current));
    } catch {
      /* quota or private mode: settings simply do not persist */
    }
  }
}
