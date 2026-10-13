/**
 * EffectRenderer — hit feedback: one pooled additive ring per judgment.
 *
 * Pooling policy: a fixed ring of instances is reused; when every instance is busy the oldest
 * is recycled. Nothing is allocated after construction (the one texture is generated once on
 * an offscreen canvas), so a dense 16th-note burst never triggers GC.
 *
 * Effects are driven by the *song* clock, not by wall time, which means they freeze exactly
 * with gameplay when the player pauses.
 */

import * as THREE from 'three';
import { JUDGMENT_COLORS, laneToX } from './Layout';

export type EffectKind = keyof typeof JUDGMENT_COLORS;

const RING_RESOLUTION = 128;

const KIND_PROFILE: Record<string, { lifeMs: number; maxScale: number; color: number }> = {
  perfect: { lifeMs: 460, maxScale: 3.9, color: JUDGMENT_COLORS.perfect! },
  good: { lifeMs: 400, maxScale: 3.0, color: JUDGMENT_COLORS.good! },
  bad: { lifeMs: 340, maxScale: 2.3, color: JUDGMENT_COLORS.bad! },
  miss: { lifeMs: 320, maxScale: 2.0, color: JUDGMENT_COLORS.miss! },
  hold: { lifeMs: 420, maxScale: 2.6, color: JUDGMENT_COLORS.hold! },
  stray: { lifeMs: 240, maxScale: 1.6, color: JUDGMENT_COLORS.stray! },
};

interface EffectInstance {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  active: boolean;
  startMs: number;
  lifeMs: number;
  maxScale: number;
}

function createRingTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = RING_RESOLUTION;
  canvas.height = RING_RESOLUTION;
  const context = canvas.getContext('2d');
  if (!context) {
    const fallback = new THREE.Texture();
    return fallback;
  }
  const center = RING_RESOLUTION / 2;
  const gradient = context.createRadialGradient(center, center, 0, center, center, center);
  gradient.addColorStop(0, 'rgba(255,255,255,0.30)');
  gradient.addColorStop(0.45, 'rgba(255,255,255,0.10)');
  gradient.addColorStop(0.68, 'rgba(255,255,255,0.92)');
  gradient.addColorStop(0.82, 'rgba(255,255,255,0.28)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, RING_RESOLUTION, RING_RESOLUTION);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export class EffectRenderer {
  private readonly group = new THREE.Group();
  private readonly instances: EffectInstance[] = [];
  private readonly geometry: THREE.PlaneGeometry;
  private readonly texture: THREE.Texture;
  private cursor = 0;

  /** Number of rings drawn on the last update (debug/telemetry). */
  activeCount = 0;

  constructor(parent: THREE.Object3D, capacity = 40) {
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.texture = createRingTexture();

    for (let i = 0; i < capacity; i += 1) {
      const material = new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(this.geometry, material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      this.group.add(mesh);
      this.instances.push({ mesh, active: false, startMs: 0, lifeMs: 1, maxScale: 1 });
    }

    parent.add(this.group);
  }

  /** Fire a ring at a lane. `atMs` is song time, so effects pause with the music. */
  spawn(lane: number, kind: EffectKind, atMs: number, strength = 1): void {
    const profile = KIND_PROFILE[kind] ?? KIND_PROFILE.good!;
    const instance = this.instances[this.cursor]!;
    this.cursor = (this.cursor + 1) % this.instances.length;

    instance.active = true;
    instance.startMs = atMs;
    instance.lifeMs = profile.lifeMs;
    instance.maxScale = profile.maxScale * Math.min(1.4, Math.max(0.5, strength));

    const mesh = instance.mesh;
    mesh.visible = true;
    mesh.material.color.setHex(profile.color);
    mesh.material.opacity = 0.95;
    mesh.position.set(laneToX(lane), 0.1, 0);
    mesh.scale.setScalar(0.9);
  }

  update(songTimeMs: number): void {
    let active = 0;
    for (const instance of this.instances) {
      if (!instance.active) continue;
      const t = (songTimeMs - instance.startMs) / instance.lifeMs;
      if (t >= 1 || t < 0) {
        instance.active = false;
        instance.mesh.visible = false;
        continue;
      }
      const eased = 1 - (1 - t) ** 3;
      instance.mesh.scale.setScalar(0.9 + (instance.maxScale - 0.9) * eased);
      instance.mesh.material.opacity = 0.95 * (1 - t) ** 1.7;
      active += 1;
    }
    this.activeCount = active;
  }

  clear(): void {
    for (const instance of this.instances) {
      instance.active = false;
      instance.mesh.visible = false;
    }
    this.activeCount = 0;
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.geometry.dispose();
    this.texture.dispose();
    this.instances.forEach((instance) => instance.mesh.material.dispose());
  }
}
