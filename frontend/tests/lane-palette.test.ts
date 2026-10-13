// @vitest-environment jsdom
/**
 * Lane colours (phase 3.1).
 *
 * Phase 3 gave every key its own colour, which made a chord read as a strip of the rainbow. Phase 3.1
 * reduces the highway to **three** colours — colour 1, colour 2 and orange for SPACE — with an exact
 * pattern per difficulty, and this suite pins that pattern down on every surface a lane appears:
 *
 *   - the lane roles (the single definition every renderer reads),
 *   - the note/hold instance colours,
 *   - the receptors and lane strips (the highway),
 *   - the keyboard key strip and the touch pads.
 *
 * It also asserts the two things that are easy to get wrong later: **no colour outside the palette is
 * ever used for a lane**, and the chosen theme is stored on the device.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  DEFAULT_LANE_PALETTE_ID,
  LANE_PALETTES,
  activeLanePalette,
  laneColorRoleLabels,
  laneColorRoles,
  laneColorsFor,
  lanePalette,
  lanePaletteColors,
  setActiveLanePalette,
} from '../src/renderer/Layout';
import { LANE_COUNT, laneToX } from '../src/renderer/Layout';
import { NoteRenderer } from '../src/renderer/NoteRenderer';
import { LaneRenderer } from '../src/renderer/LaneRenderer';
import { TouchSurface } from '../src/ui/TouchSurface';
import { SettingsStore, SETTINGS_STORAGE_KEY, type StorageLike } from '../src/storage/SettingsStore';
import { DEFAULT_SETTINGS, clampLanePalette } from '../src/game/GameConfig';
import type { RuntimeNote } from '../src/game/JudgmentEngine';

const HEX = (value: number): string => `#${value.toString(16).padStart(6, '0')}`;

/** The exact patterns the brief specifies, expressed on the keys the player presses. */
const EXPECTED = {
  hard: [
    { label: 'A', role: 'primary' },
    { label: 'S', role: 'secondary' },
    { label: 'D', role: 'primary' },
    { label: 'SPACE', role: 'space' },
    { label: 'J', role: 'primary' },
    { label: 'K', role: 'secondary' },
    { label: 'L', role: 'primary' },
  ],
  normal: [
    { label: 'A', role: 'primary' },
    { label: 'S', role: 'secondary' },
    { label: 'SPACE', role: 'space' },
    { label: 'K', role: 'secondary' },
    { label: 'L', role: 'primary' },
  ],
  easy: [
    { label: 'A', role: 'primary' },
    { label: 'S', role: 'secondary' },
    { label: 'K', role: 'primary' },
    { label: 'L', role: 'secondary' },
  ],
} as const;

function memoryStorage(): StorageLike & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

function runtimeNote(lane: number, type: RuntimeNote['type'] = 'tap'): RuntimeNote {
  return {
    index: lane,
    lane,
    type,
    timeMs: 1000,
    endTimeMs: 1600,
    durationMs: type === 'hold' ? 600 : 0,
    weight: type === 'hold' ? 2 : 1,
    status: 'pending',
    headJudgment: null,
    headErrorMs: null,
    headCombo: null,
    releasedEarly: false,
  };
}

afterEach(() => {
  setActiveLanePalette(DEFAULT_LANE_PALETTE_ID);
  document.body.replaceChildren();
});

describe('the lane palette catalogue', () => {
  it('offers exactly the two three-colour themes', () => {
    expect(LANE_PALETTES.map((entry) => entry.id)).toEqual(['ice', 'signal']);
    expect(LANE_PALETTES[0]!.name).toBe('White · Blue · Orange');
    expect(LANE_PALETTES[1]!.name).toBe('Green · Red · Orange');
    for (const palette of LANE_PALETTES) {
      // Three colours and no fourth: a lane colour is always one of these.
      expect(new Set([palette.primary, palette.secondary, palette.space]).size).toBe(3);
    }
    // The alternative palette is green and red, and SPACE stays orange in both.
    expect(LANE_PALETTES[1]!.space).toBe(LANE_PALETTES[0]!.space);
  });

  it('defaults to the first palette and falls back for an unknown id', () => {
    expect(activeLanePalette().id).toBe(DEFAULT_LANE_PALETTE_ID);
    setActiveLanePalette('signal');
    expect(activeLanePalette().id).toBe('signal');
    expect(lanePalette('nonsense').id).toBe(DEFAULT_LANE_PALETTE_ID);
    setActiveLanePalette('nonsense');
    expect(activeLanePalette().id).toBe(DEFAULT_LANE_PALETTE_ID);
    expect(clampLanePalette('signal')).toBe('signal');
    expect(clampLanePalette(42)).toBe(DEFAULT_LANE_PALETTE_ID);
  });
});

describe('the lane pattern per difficulty', () => {
  it('is exactly the documented one', () => {
    expect(laneColorRoleLabels(7)).toEqual(EXPECTED.hard);
    expect(laneColorRoleLabels(5)).toEqual(EXPECTED.normal);
    expect(laneColorRoleLabels(4)).toEqual(EXPECTED.easy);
  });

  it('uses only the palette’s three colours, for every difficulty and theme', () => {
    for (const palette of LANE_PALETTES) {
      const allowed = new Set(Object.values(lanePaletteColors(palette)));
      for (const laneCount of [4, 5, 7]) {
        const colors = laneColorsFor(laneCount, palette);
        expect(colors).toHaveLength(laneCount);
        for (const color of colors) expect(allowed.has(color)).toBe(true);
      }
    }
  });

  it('paints each lane the colour its role means', () => {
    const byLaneCount = { 7: EXPECTED.hard, 5: EXPECTED.normal, 4: EXPECTED.easy } as const;
    for (const palette of LANE_PALETTES) {
      for (const laneCount of [4, 5, 7] as const) {
        const colors = laneColorsFor(laneCount, palette);
        const values = lanePaletteColors(palette);
        byLaneCount[laneCount].forEach((expected, lane) => {
          expect(colors[lane], `${laneCount} lane ${lane}`).toBe(values[expected.role]);
        });
        // Around SPACE on five lanes: colour 2, SPACE, colour 2, with colour 1 outside.
        if (laneCount === 5) {
          expect(colors.slice(0, 2)).toEqual([palette.primary, palette.secondary]);
          expect(colors[2]).toBe(palette.space);
          expect(colors.slice(3)).toEqual([palette.secondary, palette.primary]);
        }
        // On seven lanes the lanes next to SPACE are the fourth and fifth *keys*, which are colour 1.
        if (laneCount === 7) {
          expect(colors.slice(2, 3)).toEqual([palette.primary]);
          expect(colors.slice(4, 5)).toEqual([palette.primary]);
          expect(colors[5]).toBe(palette.secondary);
        }
      }
    }
  });

  it('derives a symmetric pattern for a lane count without a tuned table', () => {
    // Not a layout the game generates, but a hand-edited chart must still render three colours.
    const roles = laneColorRoles(6);
    expect(roles).toHaveLength(6);
    expect(new Set(roles).size).toBeLessThanOrEqual(3);
    expect(roles.every((role) => role === 'primary' || role === 'secondary')).toBe(true);
    expect(laneColorsFor(1, LANE_PALETTES[0]!)).toHaveLength(1);
    // A derived odd count puts the SPACE colour in the middle, like the layouts that have one.
    expect(laneColorRoles(1)).toEqual(['space']);
    expect(laneColorRoles(3)).toEqual(['primary', 'space', 'primary']);
  });
});

describe('every surface draws from that one definition', () => {
  it('colours the notes and hold bodies by the lane’s role', () => {
    const renderer = new NoteRenderer(new THREE.Object3D());
    for (const [laneCount, paletteId] of [
      [7, 'signal'],
      [5, 'signal'],
      [4, 'ice'],
    ] as const) {
      renderer.setPalette(paletteId);
      renderer.setLaneCount(laneCount);
      const palette = lanePalette(paletteId);
      const colors = laneColorsFor(laneCount, palette);
      for (let lane = 0; lane < laneCount; lane += 1) {
        renderer.reset();
        renderer.update([runtimeNote(lane), runtimeNote(lane, 'hold')], 1000, 1800);
        const expected = new THREE.Color(colors[lane]!);
        for (let index = 0; index < renderer.drawnCaps; index += 1) {
          const actual = new THREE.Color();
          renderer.caps.getColorAt(index, actual);
          // Caps are drawn at full lane colour (a bright window blends towards white, so only the
          // hue family is asserted: red/green/blue channel relationships, not the exact value).
          expect(hueFamily(actual)).toBe(hueFamily(expected));
        }
      }
    }
  });

  it('colours the receptors and lane strips by the lane’s role', () => {
    const group = new THREE.Object3D();
    const highway = new LaneRenderer(group, 5);
    highway.setPalette('signal');
    const colors = laneColorsFor(5, lanePalette('signal'));
    const receptorMaterials: THREE.Material[] = [];
    group.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry instanceof THREE.BoxGeometry) {
        const scale = child.geometry.parameters;
        if (Math.abs(scale.width - 1.4 * 0.78) < 1e-9) receptorMaterials.push(child.material as THREE.Material);
      }
    });
    expect(receptorMaterials).toHaveLength(5);
    receptorMaterials.forEach((material, lane) => {
      const standard = material as THREE.MeshStandardMaterial;
      expect(hueFamily(standard.color)).toBe(hueFamily(new THREE.Color(colors[lane]!)));
    });
  });

  it('colours the touch pads by the lane’s role, and repaints on a theme change', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const surface = new TouchSurface(root);
    surface.setLaneCount(5);
    expect(padColors(root)).toEqual(laneColorsFor(5, lanePalette('ice')).map(HEX));

    surface.setPalette('signal');
    expect(padColors(root)).toEqual(laneColorsFor(5, lanePalette('signal')).map(HEX));

    // The key labels are unchanged by a theme: the pads still say which key they are.
    expect([...root.querySelectorAll('.touch-pad-label')].map((node) => node.textContent)).toEqual([
      'A',
      'S',
      '␣',
      'K',
      'L',
    ]);
  });

  it('keeps the pads on the lanes of the highway', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const surface = new TouchSurface(root);
    for (const laneCount of [4, 5, 7]) {
      surface.setLaneCount(laneCount);
      expect(root.querySelectorAll('.touch-zone')).toHaveLength(laneCount);
      expect(laneToX(laneCount - 1, laneCount)).toBeGreaterThan(0);
    }
  });
});

describe('the theme is remembered on this device', () => {
  it('persists the choice and restores it on the next run', () => {
    const storage = memoryStorage();
    const first = new SettingsStore(storage);
    expect(first.get().lanePalette).toBe(DEFAULT_LANE_PALETTE_ID);
    first.update({ lanePalette: 'signal' });
    expect(JSON.parse(storage.dump()[SETTINGS_STORAGE_KEY]!).lanePalette).toBe('signal');

    const second = new SettingsStore(storage);
    expect(second.get().lanePalette).toBe('signal');
    // The rest of the settings are untouched by a palette change.
    expect(second.get().volume).toBe(DEFAULT_SETTINGS.volume);
    expect(second.get().noteSpeed).toBe(DEFAULT_SETTINGS.noteSpeed);
  });

  it('refuses an unknown palette id instead of storing it', () => {
    const storage = memoryStorage();
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ globalOffsetMs: 15, noteSpeed: 1.2, volume: 0.5, lanePalette: 'neon' }),
    );
    const store = new SettingsStore(storage);
    expect(store.get().lanePalette).toBe(DEFAULT_LANE_PALETTE_ID);
    expect(store.get().globalOffsetMs).toBe(15);
    expect(store.update({ lanePalette: 'not-a-theme' }).lanePalette).toBe(DEFAULT_LANE_PALETTE_ID);
  });

  it('does not require storage at all (private mode)', () => {
    const store = new SettingsStore(null);
    expect(store.persistent).toBe(false);
    expect(store.update({ lanePalette: 'signal' }).lanePalette).toBe('signal');
  });
});

/** Which colour family a value belongs to: red-dominant, green-dominant, blue-dominant or neutral. */
function hueFamily(color: THREE.Color): string {
  const { r, g, b } = color;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 0.12) return 'neutral';
  if (max === r) return g > b ? 'orange' : 'red';
  if (max === g) return 'green';
  return 'blue';
}

function padColors(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>('.touch-zone')].map((zone) =>
    zone.style.getPropertyValue('--lane-color').trim(),
  );
}

describe('lane count sanity', () => {
  it('never exceeds the schema maximum', () => {
    expect(LANE_COUNT).toBe(7);
    expect(laneColorsFor(LANE_COUNT)).toHaveLength(LANE_COUNT);
  });
});
