/**
 * LaneRenderer — the static highway: road, lane strips, hit line and receptors.
 *
 * Static geometry is built once; per-frame work is only animating the opacity/emissive of the
 * lane strips and receptors (press feedback and hit flashes). Nothing here allocates during
 * `update`, and no state accumulates: the inputs are "which lanes are down right now" and
 * "how strong is the flash", decayed with a frame-rate independent factor.
 *
 * Phase 3: the highway is built for a **lane count** and can be rebuilt for another one
 * (`setLaneCount`) when the player loads a chart of a different difficulty. Rebuilding is a handful
 * of meshes and happens on a menu, never mid-song, so the simple thing — dispose and rebuild — is
 * what it does; there are no empty or disabled lanes, because the road is only ever as wide as the
 * chart it is showing.
 */

import * as THREE from 'three';
import {
  LANE_COUNT,
  LANE_PITCH,
  LANE_WIDTH,
  ROAD_LENGTH,
  laneColorsFor,
  laneToX,
  roadWidthFor,
  setActiveLanePalette,
} from './Layout';

const ROAD_COLOR = 0x0d1626;
const SEPARATOR_COLOR = 0x24344f;
const RAIL_COLOR = 0x2b4a75;
const HIT_LINE_COLOR = 0x9fe8ff;

const STRIP_IDLE_OPACITY = 0.05;
const STRIP_PRESSED_OPACITY = 0.34;
const RECEPTOR_IDLE_EMISSIVE = 0.45;
const RECEPTOR_PRESSED_EMISSIVE = 1.9;
const RECEPTOR_FLASH_EMISSIVE = 2.8;

export class LaneRenderer {
  private readonly group = new THREE.Group();
  private strips: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
  private receptors: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>[] = [];
  private stripOpacity = new Float32Array(LANE_COUNT);
  private flash = new Float32Array(LANE_COUNT);
  private disposables: { dispose(): void }[] = [];
  private lanesValue = LANE_COUNT;

  constructor(parent: THREE.Object3D, laneCount = LANE_COUNT) {
    this.build(laneCount);
    parent.add(this.group);
  }

  get laneCount(): number {
    return this.lanesValue;
  }

  /**
   * Rebuild the highway for another lane count. Idempotent, and a no-op when the count is unchanged,
   * so the caller can simply say "this is the chart now" on every load.
   */
  setLaneCount(laneCount: number): void {
    const lanes = Math.max(1, Math.min(LANE_COUNT, Math.round(laneCount) || LANE_COUNT));
    if (lanes === this.lanesValue && this.strips.length === lanes) return;
    this.build(lanes);
  }

  /**
   * Rebuild the highway in another lane palette. The strips and receptors carry a lane's colour, so
   * they are rebuilt (a handful of meshes, on a menu, exactly like a lane-count change).
   */
  setPalette(paletteId: string): void {
    setActiveLanePalette(paletteId);
    this.build(this.lanesValue);
  }

  private build(laneCount: number): void {
    this.clear();
    this.lanesValue = laneCount;
    this.stripOpacity = new Float32Array(laneCount);
    this.flash = new Float32Array(laneCount);
    this.buildRoad(laneCount);
    this.buildStrips(laneCount);
    this.buildHitLine(laneCount);
    this.buildReceptors(laneCount);
  }

  /** Dispose the current geometry and detach every child, ready for a rebuild. */
  private clear(): void {
    this.group.clear();
    this.strips = [];
    this.receptors = [];
    for (const entry of this.disposables) entry.dispose();
    this.disposables = [];
  }

  /** Per-frame animation. `pressed[lane]` is the live keyboard state. */
  update(dtSec: number, pressed: readonly boolean[]): void {
    const dt = Math.min(0.1, Math.max(0, dtSec));
    for (let lane = 0; lane < this.lanesValue; lane += 1) {
      const isDown = pressed[lane] === true;

      const target = isDown ? STRIP_PRESSED_OPACITY : STRIP_IDLE_OPACITY;
      this.stripOpacity[lane] = approach(this.stripOpacity[lane]!, target, isDown ? 26 : 9, dt);
      const strip = this.strips[lane];
      if (strip) strip.material.opacity = this.stripOpacity[lane]!;

      this.flash[lane] = decay(this.flash[lane]!, dt, 4.5);
      const receptor = this.receptors[lane];
      if (receptor) {
        const base = isDown ? RECEPTOR_PRESSED_EMISSIVE : RECEPTOR_IDLE_EMISSIVE;
        receptor.material.emissiveIntensity = base + this.flash[lane]! * RECEPTOR_FLASH_EMISSIVE;
      }
    }
  }

  /** Light up a lane because a note was hit there. */
  flashLane(lane: number, strength = 1): void {
    if (lane < 0 || lane >= this.lanesValue) return;
    this.flash[lane] = Math.max(this.flash[lane]!, Math.min(1.4, strength));
  }

  /** Force the lane strips/receptors back to rest (used when leaving the gameplay screen). */
  reset(): void {
    this.stripOpacity.fill(STRIP_IDLE_OPACITY);
    this.flash.fill(0);
    this.strips.forEach((strip) => {
      strip.material.opacity = STRIP_IDLE_OPACITY;
    });
    this.receptors.forEach((receptor) => {
      receptor.material.emissiveIntensity = RECEPTOR_IDLE_EMISSIVE;
    });
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
  }

  // ------------------------------------------------------------------ build --

  private buildRoad(laneCount: number): void {
    const roadWidth = roadWidthFor(laneCount);
    const roadGeometry = new THREE.PlaneGeometry(roadWidth, ROAD_LENGTH);
    const roadMaterial = new THREE.MeshStandardMaterial({
      color: ROAD_COLOR,
      roughness: 0.94,
      metalness: 0.04,
      side: THREE.DoubleSide,
    });
    const road = new THREE.Mesh(roadGeometry, roadMaterial);
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0, -ROAD_LENGTH / 2);
    this.group.add(road);
    this.disposables.push(roadGeometry, roadMaterial);

    const separatorGeometry = new THREE.BoxGeometry(0.045, 0.02, ROAD_LENGTH);
    const separatorMaterial = new THREE.MeshBasicMaterial({ color: SEPARATOR_COLOR });
    this.disposables.push(separatorGeometry, separatorMaterial);
    for (let edge = 0; edge <= laneCount; edge += 1) {
      const separator = new THREE.Mesh(separatorGeometry, separatorMaterial);
      separator.position.set(
        laneToX(0, laneCount) - LANE_PITCH / 2 + edge * LANE_PITCH,
        0.015,
        -ROAD_LENGTH / 2,
      );
      this.group.add(separator);
    }

    const railGeometry = new THREE.BoxGeometry(0.1, 0.46, ROAD_LENGTH);
    const railMaterial = new THREE.MeshStandardMaterial({
      color: RAIL_COLOR,
      emissive: new THREE.Color(0x16405f),
      emissiveIntensity: 0.7,
      roughness: 0.5,
    });
    this.disposables.push(railGeometry, railMaterial);
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(railGeometry, railMaterial);
      rail.position.set((side * (roadWidth - 0.3)) / 2, 0.23, -ROAD_LENGTH / 2);
      this.group.add(rail);
    }
  }

  private buildStrips(laneCount: number): void {
    const colors = laneColorsFor(laneCount);
    const stripGeometry = new THREE.PlaneGeometry(LANE_WIDTH * 0.98, ROAD_LENGTH);
    this.disposables.push(stripGeometry);
    for (let lane = 0; lane < laneCount; lane += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: colors[lane]!,
        transparent: true,
        opacity: STRIP_IDLE_OPACITY,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const strip = new THREE.Mesh(stripGeometry, material);
      strip.rotation.x = -Math.PI / 2;
      strip.position.set(laneToX(lane, laneCount), 0.012, -ROAD_LENGTH / 2);
      this.group.add(strip);
      this.strips.push(strip);
      this.stripOpacity[lane] = STRIP_IDLE_OPACITY;
      this.disposables.push(material);
    }
  }

  private buildHitLine(laneCount: number): void {
    const roadWidth = roadWidthFor(laneCount);
    const barGeometry = new THREE.BoxGeometry(roadWidth + 0.7, 0.05, 0.12);
    const barMaterial = new THREE.MeshBasicMaterial({
      color: HIT_LINE_COLOR,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const bar = new THREE.Mesh(barGeometry, barMaterial);
    bar.position.set(0, 0.04, 0);
    this.group.add(bar);
    this.disposables.push(barGeometry, barMaterial);

    const glowGeometry = new THREE.PlaneGeometry(roadWidth + 1.6, 2.4);
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: 0x2f6f9c,
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const glow = new THREE.Mesh(glowGeometry, glowMaterial);
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(0, 0.02, 0);
    this.group.add(glow);
    this.disposables.push(glowGeometry, glowMaterial);
  }

  private buildReceptors(laneCount: number): void {
    const colors = laneColorsFor(laneCount);
    const receptorGeometry = new THREE.BoxGeometry(LANE_WIDTH * 0.78, 0.18, 0.4);
    this.disposables.push(receptorGeometry);
    for (let lane = 0; lane < laneCount; lane += 1) {
      const color = new THREE.Color(colors[lane]!);
      const material = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: RECEPTOR_IDLE_EMISSIVE,
        roughness: 0.35,
        metalness: 0.15,
      });
      const receptor = new THREE.Mesh(receptorGeometry, material);
      receptor.position.set(laneToX(lane, laneCount), 0.11, 0);
      this.group.add(receptor);
      this.receptors.push(receptor);
      this.disposables.push(material);
    }
  }
}

/** Exponential approach that behaves identically at any frame rate. */
function approach(current: number, target: number, rate: number, dtSec: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dtSec));
}

function decay(value: number, dtSec: number, rate: number): number {
  const next = value - value * (1 - Math.exp(-rate * dtSec)) - dtSec * 0.35;
  return next < 0 ? 0 : next;
}
