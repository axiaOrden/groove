// @vitest-environment jsdom
/**
 * TouchSurface geometry tests.
 *
 * The columns must land on the projected lanes (that is what makes a thumb hit the lane the
 * player aimed at), must be big enough to be usable on a phone, must tile the width without
 * dead gaps, and must follow a rotation or a resize.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeFraming, type Framing } from '../src/renderer/CameraFraming';
import { LANE_COUNT } from '../src/renderer/Layout';
import { TouchSurface } from '../src/ui/TouchSurface';

function makeSurface() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return { root, surface: new TouchSurface(root) };
}

function apply(surface: TouchSurface, framing: Framing, width: number, height: number, topPx: number) {
  surface.layoutForFraming(framing, topPx, width, height);
}

function phoneFraming(width = 800, height = 360, insets?: { left: number }): Framing {
  return computeFraming({ viewportWidth: width, viewportHeight: height, touchLayout: true, insets });
}

let root: HTMLElement | null = null;

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  root?.remove();
  root = null;
  document.body.replaceChildren();
});

describe('TouchSurface columns', () => {
  it('creates one column per lane with the lane colour and key label', () => {
    const { root: node, surface } = makeSurface();
    root = node;
    const zones = [...node.querySelectorAll<HTMLElement>('.touch-zone')];
    expect(zones).toHaveLength(LANE_COUNT);
    expect(zones.map((zone) => zone.dataset.lane)).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    expect(zones.every((zone) => zone.dataset.active === 'false')).toBe(true);
    expect(zones.map((zone) => zone.querySelector('.touch-pad-label')?.textContent)).toEqual([
      'A',
      'S',
      'D',
      '␣',
      'J',
      'K',
      'L',
    ]);
    expect(surface.isInteractive()).toBe(false);
    expect(node.hidden).toBe(true); // hidden until the game is playing
  });

  it('puts every projected lane inside its own column, centred for the inner lanes', () => {
    const { root: node, surface } = makeSurface();
    root = node;
    const framing = phoneFraming();
    apply(surface, framing, 800, 360, 60);

    surface.zoneRects().forEach((rect, lane) => {
      const projected = framing.laneCentersPx[lane]!;
      expect(rect.left, `lane ${lane} left`).toBeLessThanOrEqual(projected);
      expect(rect.right, `lane ${lane} right`).toBeGreaterThanOrEqual(projected);
      // Inner columns are the midpoint between their neighbours, so their centre is the lane
      // centre. The two outer columns are extended to the screen edge on purpose (no dead
      // strip a thumb could land in) and are therefore wider on the outside.
      if (lane > 0 && lane < LANE_COUNT - 1) {
        expect((rect.left + rect.right) / 2, `lane ${lane} centre`).toBeCloseTo(projected, 6);
      }
    });
  });

  it('tiles the whole width with no gaps or overlaps', () => {
    const { root: node, surface } = makeSurface();
    root = node;
    apply(surface, phoneFraming(), 800, 360, 60);
    const rects = surface.zoneRects();
    expect(rects[0]!.left).toBe(0);
    expect(rects[LANE_COUNT - 1]!.right).toBe(800);
    for (let lane = 1; lane < rects.length; lane += 1) {
      expect(rects[lane]!.left).toBeCloseTo(rects[lane - 1]!.right, 6);
    }
  });

  it('gives each lane a large touch target on a landscape phone', () => {
    const { root: node, surface } = makeSurface();
    root = node;
    apply(surface, phoneFraming(), 800, 360, 60);
    for (const rect of surface.zoneRects()) {
      expect(rect.right - rect.left).toBeGreaterThanOrEqual(48);
      expect(rect.bottom - rect.top).toBeGreaterThanOrEqual(96);
    }
  });

  it('keeps the columns clear of the HUD and above the bottom edge', () => {
    const { root: node, surface } = makeSurface();
    root = node;
    const framing = phoneFraming();
    apply(surface, framing, 800, 360, 96);
    for (const rect of surface.zoneRects()) {
      expect(rect.top).toBeGreaterThanOrEqual(96);
      expect(rect.bottom).toBeLessThanOrEqual(framing.usable.top + framing.usable.height);
    }
  });

  it('sizes the pads as a short bottom strip so notes are never covered', () => {
    const { root: node, surface } = makeSurface();
    root = node;
    apply(surface, phoneFraming(), 800, 360, 60);
    const pads = [...node.querySelectorAll<HTMLElement>('.touch-pad')];
    expect(pads).toHaveLength(LANE_COUNT);
    const height = Number.parseFloat(pads[0]!.style.height);
    expect(height).toBeGreaterThanOrEqual(34);
    expect(height).toBeLessThanOrEqual(84);
    expect(height / 360).toBeLessThan(0.25);
  });

  it('follows a rotation and a resize', () => {
    const { root: node, surface } = makeSurface();
    root = node;
    const landscape = phoneFraming(800, 360);
    apply(surface, landscape, 800, 360, 60);
    const landscapeRects = surface.zoneRects();

    const portrait = phoneFraming(360, 800);
    apply(surface, portrait, 360, 800, 90);
    const portraitRects = surface.zoneRects();

    expect(portraitRects[0]!.right - portraitRects[0]!.left).toBeLessThan(
      landscapeRects[0]!.right - landscapeRects[0]!.left,
    );
    expect(portraitRects[LANE_COUNT - 1]!.right).toBe(360);
    portraitRects.forEach((rect, lane) => {
      expect(rect.left, `lane ${lane}`).toBeLessThanOrEqual(portrait.laneCentersPx[lane]!);
      expect(rect.right, `lane ${lane}`).toBeGreaterThanOrEqual(portrait.laneCentersPx[lane]!);
    });

    apply(surface, landscape, 800, 360, 60);
    expect(surface.zoneRects()).toEqual(landscapeRects);
  });

  it('follows the safe-area insets of a notched phone', () => {
    const { root: node, surface } = makeSurface();
    root = node;
    const framing = phoneFraming(800, 360, { left: 44 });
    apply(surface, framing, 800, 360, 60);
    const rects = surface.zoneRects();
    // every column still contains its lane centre, and the road sits right of the cutout
    rects.forEach((rect, lane) => {
      expect(rect.left).toBeLessThanOrEqual(framing.laneCentersPx[lane]!);
      expect(rect.right).toBeGreaterThanOrEqual(framing.laneCentersPx[lane]!);
    });
    expect(framing.laneCentersPx[0]!).toBeGreaterThan(44);
  });

  it('lights and clears lanes independently', () => {
    const { root: node, surface } = makeSurface();
    root = node;
    apply(surface, phoneFraming(), 800, 360, 60);
    const zones = [...node.querySelectorAll<HTMLElement>('.touch-zone')];

    surface.setLaneActive(1, true);
    surface.setLaneActive(6, true);
    expect(zones[1]!.dataset.active).toBe('true');
    expect(zones[6]!.dataset.active).toBe('true');
    expect(zones[0]!.dataset.active).toBe('false');

    surface.clearLanes();
    expect(zones.every((zone) => zone.dataset.active === 'false')).toBe(true);
  });

  it('publishes and retracts interactivity', () => {
    const { root: node, surface } = makeSurface();
    root = node;
    apply(surface, phoneFraming(), 800, 360, 60);

    surface.setInteractive(true);
    expect(node.hidden).toBe(false);
    expect(node.dataset.interactive).toBe('true');

    surface.setLaneActive(2, true);
    surface.setInteractive(false);
    expect(node.hidden).toBe(true);
    expect(node.dataset.interactive).toBe('false');
    expect(node.querySelector<HTMLElement>('[data-lane="2"]')!.dataset.active).toBe('false');
  });

  it('resolves every projected lane centre to its own lane', () => {
    const { root: node, surface } = makeSurface();
    root = node;
    const framing = phoneFraming();
    apply(surface, framing, 800, 360, 60);
    framing.laneCentersPx.forEach((centre, lane) => {
      expect(surface.laneAtPoint(centre, 320), `lane ${lane}`).toBe(lane);
    });
  });

  it('gives a boundary pixel to the column that owns it', () => {
    const { root: node, surface } = makeSurface();
    root = node;
    const framing = phoneFraming();
    apply(surface, framing, 800, 360, 60);
    const rects = surface.zoneRects();
    for (let lane = 1; lane < LANE_COUNT; lane += 1) {
      const boundary = rects[lane]!.left;
      expect(surface.laneAtPoint(boundary - 0.5, 320), `left of lane ${lane}`).toBe(lane - 1);
      expect(surface.laneAtPoint(boundary, 320), `lane ${lane}`).toBe(lane);
    }
    // The outer columns are extended to the screen edges: no dead strip a thumb could land in.
    expect(surface.laneAtPoint(0, 320)).toBe(0);
    expect(surface.laneAtPoint(799.5, 320)).toBe(LANE_COUNT - 1);
  });

  it('returns null above the columns and tolerates a small drift over the edge', () => {
    const { root: node, surface } = makeSurface();
    root = node;
    apply(surface, phoneFraming(), 800, 360, 96);
    const centre = surface.zoneRects()[3]!;
    expect(surface.laneAtPoint(centre.left + 2, 0)).toBeNull();
    expect(surface.laneAtPoint(centre.left + 2, 96 - 8)).toBe(3); // within the slack
    expect(surface.laneAtPoint(centre.left + 2, 96 - 40)).toBeNull();
    expect(surface.laneAtPoint(centre.left + 2, 360)).toBe(3); // the bottom edge still counts
  });

  it('ignores non-finite coordinates', () => {
    const { root: node, surface } = makeSurface();
    root = node;
    apply(surface, phoneFraming(), 800, 360, 60);
    expect(surface.laneAtPoint(Number.NaN, 200)).toBeNull();
    expect(surface.laneAtPoint(200, Number.POSITIVE_INFINITY)).toBeNull();
    const owning = surface.zoneRects().find((rect) => 200 >= rect.left && 200 < rect.right)!;
    expect(surface.laneAtPoint(200, 200)).toBe(owning.lane);
  });

  it('follows a rotation', () => {
    const { root: node, surface } = makeSurface();
    root = node;
    apply(surface, phoneFraming(800, 360), 800, 360, 60);
    const portrait = phoneFraming(360, 800);
    apply(surface, portrait, 360, 800, 90);
    portrait.laneCentersPx.forEach((centre, lane) => {
      expect(surface.laneAtPoint(centre, 700), `lane ${lane} in portrait`).toBe(lane);
    });
  });

  it('ignores a layout with the wrong number of lanes', () => {
    const { root: node, surface } = makeSurface();
    root = node;
    apply(surface, phoneFraming(), 800, 360, 60);
    const before = surface.zoneRects();
    surface.layout({
      laneCentersPx: [10, 20, 30],
      usable: { left: 0, top: 0, width: 800, height: 360 },
      topPx: 0,
      viewportWidth: 800,
      viewportHeight: 360,
    });
    expect(surface.zoneRects()).toEqual(before);
  });
});
