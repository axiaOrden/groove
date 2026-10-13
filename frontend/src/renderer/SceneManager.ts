/**
 * SceneManager — renderer, scene, camera and resize handling.
 *
 * Deliberately small: it owns nothing gameplay related, so the same scene can later host the
 * chart editor (phase 4) or a results showcase.
 *
 * Performance notes:
 *  - pixel ratio is capped at 2 so a 4K/retina display does not quadruple fill cost,
 *  - no shadow maps and only two lights: everything that moves (notes, effects) uses
 *    additive or unlit materials,
 *  - fog doubles as the "far away" cue so no geometry needs real distance fading.
 */

import * as THREE from 'three';
import type { Framing, FramingMode } from './CameraFraming';
import {
  CAMERA_FAR,
  CAMERA_FOV,
  CAMERA_NEAR,
  CAMERA_POSITION,
  CAMERA_TARGET,
  FOG_COLOR,
  FOG_FAR,
  FOG_NEAR,
} from './Layout';

export const MAX_PIXEL_RATIO = 2;

export class SceneManager {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly world: THREE.Group;

  private readonly hemisphere: THREE.HemisphereLight;
  private readonly keyLight: THREE.DirectionalLight;
  private width = 1;
  private height = 1;
  private framingModeValue: FramingMode = 'desktop';

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false,
    });
    this.renderer.setClearColor(FOG_COLOR, 1);
    this.renderer.setPixelRatio(Math.min(MAX_PIXEL_RATIO, window.devicePixelRatio || 1));

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(FOG_COLOR);
    this.scene.fog = new THREE.Fog(FOG_COLOR, FOG_NEAR, FOG_FAR);

    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, CAMERA_NEAR, CAMERA_FAR);
    this.camera.position.set(CAMERA_POSITION.x, CAMERA_POSITION.y, CAMERA_POSITION.z);
    this.camera.lookAt(CAMERA_TARGET.x, CAMERA_TARGET.y, CAMERA_TARGET.z);

    this.hemisphere = new THREE.HemisphereLight(0x9dc4ff, 0x0a0f1c, 1.15);
    this.keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
    this.keyLight.position.set(4.5, 13, 7);
    this.scene.add(this.hemisphere, this.keyLight);

    // Everything highway-related lives under one group so it can be swapped wholesale.
    this.world = new THREE.Group();
    this.scene.add(this.world);
  }

  resize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(Math.min(MAX_PIXEL_RATIO, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Apply a solved camera pose (see `CameraFraming`). Called after every resize, so the
   * highway keeps filling the same fraction of a phone in landscape and the touch columns
   * (which are derived from the same projection) keep matching the lanes they sit under.
   *
   * The desktop framing is the phase 1 camera verbatim, so this is a no-op on a desktop
   * viewport: same position, same target, same 52 degree fov.
   */
  applyFraming(framing: Framing): void {
    const { position, target, fov } = framing.camera;
    this.camera.fov = fov;
    this.camera.position.set(position.x, position.y, position.z);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(target.x, target.y, target.z);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
    this.framingModeValue = framing.mode;
  }

  get framingMode(): FramingMode {
    return this.framingModeValue;
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  setPixelRatioCap(cap: number): void {
    this.renderer.setPixelRatio(Math.min(cap, window.devicePixelRatio || 1));
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /** Renderer statistics for the FPS/debug readout. */
  get stats(): {
    drawCalls: number;
    triangles: number;
    programs: number;
    geometries: number;
    textures: number;
    fov: number;
    aspect: number;
  } {
    const info = this.renderer.info;
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      fov: this.camera.fov,
      aspect: this.camera.aspect,
    };
  }

  dispose(): void {
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
      else material?.dispose();
    });
    this.renderer.dispose();
  }
}
