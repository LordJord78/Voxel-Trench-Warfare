/**
 * The flares' shadow maps (flare-shadow.wgsl): for each of up to FLARE_MAPS burning flares, the
 * hemisphere below it on a paraboloid, FLARE_MAP_SIZE² texels, each how far from the flare its ray
 * runs before the voxel world stops it, within the flare's reach. Flares hang over the field, so all
 * their light that a voxel could stop goes down from them. The maps lie in the key light's atlas
 * (key-shadow.ts), below its height map, four tiles to a row; the froxels ask flareLit whether a
 * flare reaches a point, so its glow in the haze is cut into shafts by what stands between.
 *
 * The burning flares nearest the eye hold the maps, a flare by its id (the battle's are fired and go
 * out, so its place in the frame's lights changes under it), or its index if it has none: FLARE_MAPS
 * of them, or as many as the preset holds (quality.ts's FLARE_SHADOW_MAPS); the rest light unshadowed.
 *
 * A flare keeps its map while it burns. The map is traced as the key's is, a sixteenth a frame in
 * tiles of 8 × 8: each sixteenth again once its flare has moved a voxel since it was traced, or the
 * world has changed; all of it when the flare is new to its map or jumps a metre in a frame (lit
 * again where it began). A flare that is out, by the hour or guttered, has none.
 */

import type { SceneLight } from './lights';

export type Vec3 = readonly [number, number, number];

export const FLARE_MAPS = 8;
/** Texels each way of a flare's map (flare-shadow.wgsl's FLARE_MAP_SIZE). */
export const FLARE_MAP_SIZE = 256;
/** Frames a map is traced over, a sixteenth a frame, as the key's. */
const SLOTS = 16;
/** The texels of a whole map, and of a sixteenth of it. */
const ALL = FLARE_MAP_SIZE * FLARE_MAP_SIZE;
const SIXTEENTH = ALL / SLOTS;
/** In metres: how far a flare may move in a frame before its map is traced outright; and since a sixteenth was traced, before that is traced again (a voxel, in voxels). */
const JUMP_M = 1;
const MOVE_VOXELS = 1;
/** A slot no light holds. */
const NONE = 0xffffffff;

/** A direction below a flare (d.y ≤ 0, unit) on the paraboloid's unit disc. */
export function paraboloid(d: Vec3): [number, number] {
  const k = 1 / (1 - d[1]);
  return [d[0] * k, d[2] * k];
}

/** A point of the unit disc as the direction below a flare it stands for. */
export function unparaboloid(s: number, t: number): [number, number, number] {
  const r = s * s + t * t;
  const k = 1 / (1 + r);
  return [2 * s * k, (r - 1) * k, 2 * t * k];
}

/** The texel of each 4 × 4 block of tiles a sixteenth traces, in turn (key-shadow.ts's order). */
const ORDER: [number, number][] = [
  [0, 0], [2, 2], [2, 0], [0, 2], [1, 1], [3, 3], [3, 1], [1, 3],
  [1, 0], [3, 2], [3, 0], [1, 2], [0, 1], [2, 3], [2, 1], [0, 3],
];

interface Mapped {
  /** Which flare: its id, or −1 − its index for one without. */
  key: number;
  /** Its index in this frame's lights, as the shaders read them. */
  light: number;
  /** Voxels: where the flare is, and how far its light reaches. */
  at: Vec3;
  reach: number;
  /** Where it was last frame, and where each sixteenth was traced from (null: not yet), with the world as it then was. */
  last: Vec3;
  traced: (Vec3 | null)[];
  tracedWorld: number[];
  count: number;
}

export class FlareShadows {
  /** The maps' flares as flareLit reads them (flare-shadow.wgsl's FlareInfo): each slot's light, place and reach. */
  readonly info: GPUBuffer;
  /** This frame's texels to trace of each map (FlareBuild). */
  readonly build: GPUBuffer;
  private readonly device: GPUDevice;
  private readonly slots: (Mapped | null)[] = new Array(FLARE_MAPS).fill(null);
  private world = 0;

  static create(device: GPUDevice): FlareShadows {
    return new FlareShadows(device);
  }

  private constructor(device: GPUDevice) {
    this.device = device;
    this.info = device.createBuffer({ label: 'flare shadows', size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.build = device.createBuffer({ label: 'flare shadows build', size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.writeInfo();
  }

  /**
   * The frame's lights, flares burning at `flares` of their strength (lights.ts), at `voxel` metres a
   * voxel: the `maps` (at most FLARE_MAPS) burning flares nearest `eye` (voxels) hold maps, or without
   * an eye the first.
   */
  setFlares(lights: readonly SceneLight[], flares: number, voxel: number, eye?: readonly number[], maps = FLARE_MAPS): void {
    let burning: number[] = [];
    lights.forEach((l, i) => {
      if (l.kind === 'flare' && l.intensity * flares > 0) burning.push(i);
    });
    if (eye) {
      const away = (i: number) => {
        const p = lights[i].position;
        const d = [p[0] / voxel - eye[0], p[1] / voxel - eye[1], p[2] / voxel - eye[2]];
        return d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
      };
      burning.sort((a, b) => away(a) - away(b) || a - b);
    }
    burning = burning.slice(0, Math.min(maps, FLARE_MAPS));
    const keyOf = (i: number) => lights[i].id ?? -1 - i;
    const keys = burning.map(keyOf);
    // A flare keeps its slot while it burns; a new one takes a free slot.
    for (let k = 0; k < FLARE_MAPS; k++) if (this.slots[k] && !keys.includes(this.slots[k]!.key)) this.slots[k] = null;
    for (const i of burning) {
      const l = lights[i];
      const at: Vec3 = [l.position[0] / voxel, l.position[1] / voxel, l.position[2] / voxel];
      const held = this.slots.find((s) => s?.key === keyOf(i));
      if (held) {
        held.light = i;
        held.last = held.at;
        held.at = at;
        held.reach = l.radius / voxel;
        if (Math.hypot(at[0] - held.last[0], at[1] - held.last[1], at[2] - held.last[2]) * voxel > JUMP_M) held.traced.fill(null);
      } else {
        const k = this.slots.indexOf(null);
        this.slots[k] = { key: keyOf(i), light: i, at, reach: l.radius / voxel, last: at, traced: new Array(SLOTS).fill(null), tracedWorld: new Array(SLOTS).fill(0), count: 0 };
      }
    }
    this.writeInfo();
  }

  /** The world changed (an edit was uploaded): every map is to be traced again. */
  worldChanged(): void {
    this.world++;
  }

  /** The lights that hold maps, in ascending order. */
  mapped(): number[] {
    return this.slots.flatMap((s) => (s ? [s.light] : [])).sort((a, b) => a - b);
  }

  /** This frame's texels to trace, written for the build (outright for a map traced from nowhere, else its next stale sixteenth); how many in all. */
  next(): number {
    const jobs: number[][] = [];
    let start = 0;
    this.slots.forEach((s, k) => {
      if (!s) return;
      if (s.traced.every((t): boolean => t === null)) {
        s.traced.fill(s.at);
        s.tracedWorld.fill(this.world);
        jobs.push([k, 1, 0, start]);
        start += ALL;
        return;
      }
      const stale = (j: number) => {
        const t = s.traced[j];
        return t === null || this.world !== s.tracedWorld[j] || Math.hypot(s.at[0] - t[0], s.at[1] - t[1], s.at[2] - t[2]) > MOVE_VOXELS;
      };
      for (let i = 0; i < SLOTS; i++) {
        const j = (s.count + i) % SLOTS;
        if (!stale(j)) continue;
        s.count = j + 1;
        s.traced[j] = s.at;
        s.tracedWorld[j] = this.world;
        const [ox, oy] = ORDER[j];
        jobs.push([k, 4, ox | (oy << 16), start]);
        start += SIXTEENTH;
        return;
      }
    });
    const data = new Uint32Array(36);
    jobs.forEach((j, n) => data.set(j, n * 4));
    data.set([jobs.length, start], 32);
    this.device.queue.writeBuffer(this.build, 0, data);
    return start;
  }

  destroy(): void {
    this.info.destroy();
    this.build.destroy();
  }

  /** Each slot's light (NONE if empty), then its place and reach. */
  private writeInfo(): void {
    const data = new ArrayBuffer(160);
    const u = new Uint32Array(data, 0, 8);
    const f = new Float32Array(data, 32, 32);
    this.slots.forEach((s, k) => {
      u[k] = s ? s.light : NONE;
      if (s) f.set([s.at[0], s.at[1], s.at[2], s.reach], k * 4);
    });
    this.device.queue.writeBuffer(this.info, 0, data);
  }
}
