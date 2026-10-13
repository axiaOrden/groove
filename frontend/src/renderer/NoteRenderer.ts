/**
 * NoteRenderer — notes drawn with two InstancedMeshes (one for cap-shaped boxes, one for hold
 * bodies) and per-instance colours.
 *
 * Why instancing + fixed pools:
 *  - several hundred notes can be on screen at once; two draw calls instead of hundreds,
 *  - all matrices/colours come from preallocated scratch objects, so a frame performs zero
 *    allocations and produces no garbage spikes,
 *  - a single monotonically advancing `visibleFrom` pointer culls from the front, and the
 *    loop breaks as soon as notes are further away than the visual lead time, so per-frame
 *    cost is proportional to the notes actually visible (typically 20-60).
 *
 * Positions come from the song clock through `zForTimeToHit`: nothing accumulates per frame,
 * so note placement is identical at 30 fps and at 240 fps.
 */

import * as THREE from 'three';
import type { RuntimeNote } from '../game/JudgmentEngine';
import {
  JUDGMENT_COLORS,
  LANE_COUNT,
  PAST_VISIBLE_MS,
  PAST_VISIBLE_Z,
  holdGeometry,
  laneColorsFor,
  laneToX,
  setActiveLanePalette,
  zForTimeToHit,
} from './Layout';

const CAP_CAPACITY = 640;
const BODY_CAPACITY = 192;

const CAP_SCALE = { x: 0.9, y: 0.17, z: 0.52 };
const HOLD_CAP_SCALE = { x: 0.84, y: 0.2, z: 0.52 };
const BODY_SCALE = { x: 0.84, y: 0.1, z: 1 };
const CAP_Y = 0.17;
const BODY_Y = 0.13;
const TAIL_CAP_SCALE_FACTOR = 0.72;
const BRIGHT_WINDOW_MS = 160;
const BRIGHT_MIX = 0.5;
const MISS_MIN_SCALE = 0.3;

export class NoteRenderer {
  private readonly group = new THREE.Group();
  /** Exposed read-only: diagnostics use the instance counts, tests read the matrices back. */
  readonly caps: THREE.InstancedMesh;
  readonly bodies: THREE.InstancedMesh;
  private readonly geometry: THREE.BoxGeometry;
  private readonly capMaterial: THREE.MeshStandardMaterial;
  private readonly bodyMaterial: THREE.MeshStandardMaterial;
  private laneColors: THREE.Color[];
  private lanesValue = LANE_COUNT;
  private readonly missColor = new THREE.Color(JUDGMENT_COLORS.miss!);
  private readonly scratchMatrix = new THREE.Matrix4();
  private readonly scratchColor = new THREE.Color();
  private readonly scratchPosition = new THREE.Vector3();
  private readonly scratchScale = new THREE.Vector3();
  private readonly scratchQuaternion = new THREE.Quaternion();
  private visibleFrom = 0;
  /** Used to detect a backwards clock jump (seek/resume) and rewind the cull pointer. */
  private lastSongTimeMs = Number.NEGATIVE_INFINITY;

  /** Diagnostic counters (used by the debug overlay and smoke checks). */
  drawnCaps = 0;
  drawnBodies = 0;
  culledFrom = 0;

  constructor(parent: THREE.Object3D) {
    this.geometry = new THREE.BoxGeometry(1, 1, 1);
    this.capMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.2,
      metalness: 0.1,
      emissive: new THREE.Color(0x1a2233),
      emissiveIntensity: 0.8,
    });
    this.bodyMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.45,
      metalness: 0.05,
      transparent: true,
      opacity: 0.72,
    });

    this.caps = new THREE.InstancedMesh(this.geometry, this.capMaterial, CAP_CAPACITY);
    this.bodies = new THREE.InstancedMesh(this.geometry, this.bodyMaterial, BODY_CAPACITY);
    for (const mesh of [this.caps, this.bodies]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false; // instances are repositioned every frame
      mesh.count = 0;
      this.scratchMatrix.identity();
      mesh.setMatrixAt(0, this.scratchMatrix);
      mesh.instanceColor?.setUsage(THREE.DynamicDrawUsage);
    }

    this.laneColors = laneColorsFor(LANE_COUNT).map((hex) => new THREE.Color(hex));

    this.group.add(this.caps, this.bodies);
    parent.add(this.group);
  }

  get laneCount(): number {
    return this.lanesValue;
  }

  /**
   * Follow a chart's lane count. Only the colour table and the bounds check change: notes carry
   * their own lane index and are positioned through `laneToX`, so nothing else has to be rebuilt.
   */
  setLaneCount(laneCount: number): void {
    const lanes = Math.max(1, Math.min(LANE_COUNT, Math.round(laneCount) || LANE_COUNT));
    if (lanes === this.lanesValue) return;
    this.lanesValue = lanes;
    this.laneColors = laneColorsFor(lanes).map((hex) => new THREE.Color(hex));
    this.reset();
  }

  /**
   * Switch the lane palette. The three colours live in `Layout` (one definition for notes, holds,
   * receptors, lane strips and the key/touch indicators), so this only re-reads them.
   */
  setPalette(paletteId: string): void {
    setActiveLanePalette(paletteId);
    this.laneColors = laneColorsFor(this.lanesValue).map((hex) => new THREE.Color(hex));
  }

  /**
   * Draw one frame.
   * @param notes runtime notes, sorted by time (includes the chart offset)
   * @param songTimeMs current song clock position
   * @param leadMs visual lead time for the current speed setting
   */
  update(notes: readonly RuntimeNote[], songTimeMs: number, leadMs: number): void {
    if (songTimeMs < this.lastSongTimeMs - 0.5) {
      this.visibleFrom = 0; // resumed with a count-in, or the playhead was moved backwards
    }
    this.lastSongTimeMs = songTimeMs;

    const pastCutoff = songTimeMs - PAST_VISIBLE_MS;
    this.advanceCullPointer(notes, pastCutoff);

    let capCount = 0;
    let bodyCount = 0;

    for (let i = this.visibleFrom; i < notes.length; i += 1) {
      const note = notes[i]!;
      const timeToHit = note.timeMs - songTimeMs;
      if (timeToHit > leadMs) break;

      const lane = note.lane;
      if (lane < 0 || lane >= this.lanesValue) continue;
      // A hold whose *head* is past the line is still live while its tail is ahead — the player is
      // holding it, and its trail has to keep drawing (its head is simply no longer shown; see the
      // `holding` branch below). Everything else that is long past can only be an unresolved
      // leftover (for example the frame a seek jumps forward, before the engine resolves it), and
      // drawing it would put a huge box on top of the camera.
      const liveHold =
        note.type === 'hold' && note.status !== 'missed' && note.endTimeMs - songTimeMs > -PAST_VISIBLE_MS;
      if (timeToHit < -PAST_VISIBLE_MS && note.status !== 'missed' && !liveHold) continue;
      const headZ = Math.min(PAST_VISIBLE_Z, zForTimeToHit(timeToHit, leadMs));
      const baseColor = this.laneColors[lane]!;

      switch (note.status) {
        case 'hit':
        case 'completed':
        case 'broken':
        case 'interrupted':
          // Consumed notes are gone from the highway; the effect layer shows the feedback.
          continue;

        case 'missed': {
          // The note is behind the hit line now; keep it near the line so it does not balloon
          // into the camera, and shrink it out over the visible-past window.
          const fade = 1 - Math.min(1, Math.max(0, songTimeMs - note.timeMs) / PAST_VISIBLE_MS);
          const scale = MISS_MIN_SCALE + (1 - MISS_MIN_SCALE) * fade;
          capCount = this.writeCap(capCount, lane, headZ, this.missColor, scale);
          continue;
        }

        case 'holding': {
          // The head has been consumed, so the remaining body runs from the hit line to the tail —
          // the same geometry function the falling state uses, anchored at the line instead of at
          // the head, which is what stops the body jumping when the head is hit.
          const geometry = holdGeometry({
            timeMs: note.timeMs,
            endTimeMs: note.endTimeMs,
            songTimeMs,
            leadMs,
            anchoredToLine: true,
          });
          const length = Math.max(0.3, geometry.bodyLength);
          bodyCount = this.writeBody(bodyCount, lane, geometry.bodyCenterZ, length, baseColor, BRIGHT_MIX);
          continue;
        }

        case 'pending':
        default: {
          const bright = Math.abs(timeToHit) <= BRIGHT_WINDOW_MS;
          if (note.type === 'hold' && note.durationMs > 0) {
            // Head cap at the head's own z, tail cap at the tail's, body exactly between them: all
            // three from `holdGeometry`, so the trail can never detach from the head, and a hold
            // longer than the visible road is clipped at the spawn plane instead of stretching
            // (see `Layout.holdGeometry`).
            const geometry = holdGeometry({
              timeMs: note.timeMs,
              endTimeMs: note.endTimeMs,
              songTimeMs,
              leadMs,
              anchoredToLine: false,
            });
            const length = Math.max(0.3, geometry.bodyLength);
            bodyCount = this.writeBody(
              bodyCount,
              lane,
              geometry.bodyCenterZ,
              length,
              baseColor,
              bright ? BRIGHT_MIX : 0.08,
            );
            capCount = this.writeCap(capCount, lane, geometry.headZ, baseColor, 1, HOLD_CAP_SCALE);
            capCount = this.writeCap(
              capCount,
              lane,
              geometry.tailZ,
              baseColor,
              TAIL_CAP_SCALE_FACTOR,
              HOLD_CAP_SCALE,
            );
          } else {
            capCount = this.writeCap(capCount, lane, headZ, baseColor, 1, CAP_SCALE, bright ? BRIGHT_MIX : 0);
          }
          continue;
        }
      }
    }

    this.caps.count = capCount;
    this.bodies.count = bodyCount;
    if (capCount > 0) {
      this.caps.instanceMatrix.needsUpdate = true;
      if (this.caps.instanceColor) this.caps.instanceColor.needsUpdate = true;
    }
    if (bodyCount > 0) {
      this.bodies.instanceMatrix.needsUpdate = true;
      if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;
    }

    this.drawnCaps = capCount;
    this.drawnBodies = bodyCount;
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  /** Reset the cull pointer (after a seek backwards or a restart). */
  reset(): void {
    this.visibleFrom = 0;
    this.lastSongTimeMs = Number.NEGATIVE_INFINITY;
    this.caps.count = 0;
    this.bodies.count = 0;
    this.drawnCaps = 0;
    this.drawnBodies = 0;
    this.culledFrom = 0;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.geometry.dispose();
    this.capMaterial.dispose();
    this.bodyMaterial.dispose();
    this.caps.dispose();
    this.bodies.dispose();
  }

  // ---------------------------------------------------------------- internal --

  private advanceCullPointer(notes: readonly RuntimeNote[], pastCutoff: number): void {
    let index = Math.min(this.visibleFrom, notes.length);
    while (index < notes.length) {
      const note = notes[index]!;
      const unresolved = note.status === 'pending' || note.status === 'holding';
      if (unresolved || note.endTimeMs >= pastCutoff) break;
      index += 1;
    }
    this.visibleFrom = index;
    this.culledFrom = index;
  }

  private writeCap(
    index: number,
    lane: number,
    z: number,
    color: THREE.Color,
    scaleFactor = 1,
    scale = CAP_SCALE,
    brightMix = 0,
  ): number {
    if (index >= CAP_CAPACITY) return index;
    return this.writeInstance(this.caps, index, lane, CAP_Y, z, scale, scaleFactor, color, brightMix);
  }

  private writeBody(
    index: number,
    lane: number,
    z: number,
    length: number,
    color: THREE.Color,
    brightMix: number,
  ): number {
    if (index >= BODY_CAPACITY) return index;
    const scale = { x: BODY_SCALE.x, y: BODY_SCALE.y, z: length };
    return this.writeInstance(this.bodies, index, lane, BODY_Y, z, scale, 1, color, brightMix);
  }

  private writeInstance(
    mesh: THREE.InstancedMesh,
    index: number,
    lane: number,
    y: number,
    z: number,
    scale: { x: number; y: number; z: number },
    scaleFactor: number,
    color: THREE.Color,
    brightMix: number,
  ): number {
    this.scratchPosition.set(laneToX(lane, this.lanesValue), y, Math.min(PAST_VISIBLE_Z, z));
    this.scratchScale.set(
      scale.x * scaleFactor,
      scale.y * scaleFactor,
      scale.z * scaleFactor,
    );
    this.scratchMatrix.compose(this.scratchPosition, this.scratchQuaternion, this.scratchScale);
    mesh.setMatrixAt(index, this.scratchMatrix);

    this.scratchColor.copy(color);
    if (brightMix > 0) this.scratchColor.lerp(WHITE, brightMix);
    mesh.setColorAt(index, this.scratchColor);
    return index + 1;
  }
}

const WHITE = new THREE.Color(0xffffff);
