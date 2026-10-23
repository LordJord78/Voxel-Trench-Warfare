/**
 * The entrenching tool (the spec's §5, "Digging"; the reference's
 * world/entrenching.py), at 10 cm: loose soil — spoil, rubble, sandbags —
 * cleared from in front of the feet at the reference's rate, 0.125 m³ per
 * 1.35 s. The reference cleared one 0.5 m voxel at a time; here the work is
 * banked until a scoop's worth is due (`scoop_voxels`, 0.26 s), and then the
 * nearest loose voxels in reach go at once — thrown over the parapet, not moved
 * — and the ground about them settles, so nothing is left hanging over the
 * hole. The search is the reference's `find_target`: about a point half the
 * reach ahead, from a voxel below the feet up to the reach, nearest the feet
 * first. Timber, duckboards and undisturbed ground are not shovel work, so the
 * tool cannot quietly re-excavate the map. Banked work survives letting go:
 * being shot at should make you stop, not start again.
 */

import type { Tunables } from '../core/tunables';
import { yawBasis } from '../physics/vec';
import { BRICK, UNIFORM, type BrickMap } from '../world/bricks';
import { settleRegion } from '../world/destruction';
import { isLoose, P } from '../world/materials';
import type { Box } from '../world/region';

export interface EntrenchingTunables {
  reachM: number;
  /** The rate, cubic metres a second. */
  m3PerS: number;
  scoopVoxels: number;
  /** While digging: the exposure shown, and the aim's sway. */
  exposureScale: number;
  swayScale: number;
}

export function entrenchingTunables(tun: Tunables): EntrenchingTunables {
  return {
    reachM: tun.f('entrenching.reach_m'),
    m3PerS: tun.f('entrenching.m3_per_s'),
    scoopVoxels: tun.i('entrenching.scoop_voxels'),
    exposureScale: tun.f('entrenching.exposure_scale'),
    swayScale: tun.f('entrenching.sway_scale'),
  };
}

/** A scoop dug: how many voxels went, and its middle, metres. */
export interface Scoop {
  voxels: number;
  at: [number, number, number];
}

/** Voxels about a scoop its settling starts from. */
const SETTLE_PAD = 2;
/** Voxels further a settling may spread sideways (collapseRegion's pad), for the box a caller is asked to free. */
const SPREAD = 24;

const LOOSE = Uint8Array.from({ length: 256 }, (_, p) => (isLoose(p) ? 1 : 0));

export class Entrenching {
  /** Seconds of digging banked toward the next scoop: kept when digging stops, never more than one scoop's. */
  banked = 0;
  /** Voxels cleared. */
  cleared = 0;
  /** Whether the last tick's digging had anything loose in reach. */
  inReach = false;
  private readonly brick = new Uint8Array(512);

  constructor(
    readonly map: BrickMap,
    readonly t: EntrenchingTunables,
    readonly voxel: number,
    /** The world's water table, voxels: a scoop below it floods. */
    readonly waterTable?: number,
  ) {}

  /** A scoop's worth of digging, seconds. */
  get scoopS(): number {
    return (this.t.scoopVoxels * this.voxel * this.voxel * this.voxel) / this.t.m3PerS;
  }

  /** How far through the next scoop, 0 to 1: the HUD's bar. */
  get fraction(): number {
    return Math.min(1, this.banked / this.scoopS);
  }

  /** The voxels the next scoop would take from feet at `feet` (metres) facing `yaw` (degrees): the nearest loose ones in reach, nearest first, ties by index. */
  findScoop(feet: readonly number[], yaw: number): [number, number, number][] {
    const n = this.t.scoopVoxels;
    const { dims } = this.map;
    const d2s: number[] = [];
    const indices: number[] = [];
    const found: [number, number, number][] = [];
    this.scan(feet, yaw, (x, y, z, d2) => {
      const index = (z * dims.y + y) * dims.x + x;
      let k = found.length;
      if (k === n && (d2 > d2s[k - 1] || (d2 === d2s[k - 1] && index > indices[k - 1]))) return false;
      while (k > 0 && (d2s[k - 1] > d2 || (d2s[k - 1] === d2 && indices[k - 1] > index))) k--;
      d2s.splice(k, 0, d2);
      indices.splice(k, 0, index);
      found.splice(k, 0, [x, y, z]);
      if (found.length > n) {
        d2s.pop();
        indices.pop();
        found.pop();
      }
      return false;
    });
    return found;
  }

  /**
   * One tick of digging: `dt` banked if anything loose is in reach, and a scoop
   * once a scoop's worth is, unless `free` refuses the box its settling may
   * touch (a crater's region out): then the work waits, banked.
   */
  work(feet: readonly number[], yaw: number, dt: number, free?: (box: Box) => boolean): Scoop | null {
    let any = false;
    this.scan(feet, yaw, () => (any = true));
    this.inReach = any;
    if (!any) return null;
    this.banked += dt;
    if (this.banked < this.scoopS) return null;
    const taken = this.findScoop(feet, yaw);
    const box: Box = { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
    for (const [x, y, z] of taken) {
      box.x0 = Math.min(box.x0, x - SETTLE_PAD);
      box.y0 = Math.min(box.y0, y - SETTLE_PAD);
      box.z0 = Math.min(box.z0, z - SETTLE_PAD);
      box.x1 = Math.max(box.x1, x + 1 + SETTLE_PAD);
      box.y1 = Math.max(box.y1, y + 1 + SETTLE_PAD);
      box.z1 = Math.max(box.z1, z + 1 + SETTLE_PAD);
    }
    if (free && !free({ ...box, x0: box.x0 - SPREAD, z0: box.z0 - SPREAD, x1: box.x1 + SPREAD, z1: box.z1 + SPREAD })) {
      this.banked = this.scoopS;
      return null;
    }
    const at: [number, number, number] = [0, 0, 0];
    for (const [x, y, z] of taken) {
      // Thrown over the parapet, not moved: a trench that gets deeper every time someone tidies it is not a mechanic.
      this.map.set(x, y, z, P.AIR);
      at[0] += x + 0.5;
      at[1] += y + 0.5;
      at[2] += z + 0.5;
    }
    settleRegion(this.map, box, this.waterTable);
    this.banked = Math.min(this.banked - this.scoopS, this.scoopS);
    this.cleared += taken.length;
    const per = this.voxel / taken.length;
    return { voxels: taken.length, at: [at[0] * per, at[1] * per, at[2] * per] };
  }

  /**
   * Each loose voxel in reach of `feet`, with its squared distance in voxels, until `visit` says
   * stop: the reference's search box about a point half the reach ahead, a voxel below the feet
   * to the reach above them, a brick at a time so empty and uniform bricks cost one look.
   */
  private scan(feet: readonly number[], yaw: number, visit: (x: number, y: number, z: number, d2: number) => boolean): void {
    const { map } = this;
    const reach = this.t.reachM / this.voxel;
    const span = Math.ceil(reach - 1e-9);
    const [forward] = yawBasis(yaw);
    const fx = feet[0] / this.voxel;
    const fy = feet[1] / this.voxel;
    const fz = feet[2] / this.voxel;
    const cx = Math.floor(fx + forward.x * reach * 0.5);
    const cy = Math.floor(fy);
    const cz = Math.floor(fz + forward.z * reach * 0.5);
    const x0 = Math.max(0, cx - span);
    const y0 = Math.max(0, cy - 1);
    const z0 = Math.max(0, cz - span);
    const x1 = Math.min(map.dims.x, cx + span + 1);
    const y1 = Math.min(map.dims.y, cy + span + 1);
    const z1 = Math.min(map.dims.z, cz + span + 1);
    const r2 = reach * reach;
    for (let bz = Math.floor(z0 / BRICK); bz * BRICK < z1; bz++) {
      for (let by = Math.floor(y0 / BRICK); by * BRICK < y1; by++) {
        for (let bx = Math.floor(x0 / BRICK); bx * BRICK < x1; bx++) {
          const bi = map.brickIndex(bx, by, bz);
          const e = map.table[bi];
          if (e === 0) continue;
          const uniform = (e & UNIFORM) !== 0;
          if (uniform && !LOOSE[e & 0xff]) continue;
          if (!uniform) map.readBrick(bi, this.brick);
          for (let z = Math.max(z0, bz * BRICK); z < Math.min(z1, (bz + 1) * BRICK); z++) {
            for (let y = Math.max(y0, by * BRICK); y < Math.min(y1, (by + 1) * BRICK); y++) {
              for (let x = Math.max(x0, bx * BRICK); x < Math.min(x1, (bx + 1) * BRICK); x++) {
                if (!uniform && !LOOSE[this.brick[(x & 7) + ((y & 7) << 3) + ((z & 7) << 6)]]) continue;
                const dx = x + 0.5 - fx;
                const dy = y + 0.5 - fy;
                const dz = z + 0.5 - fz;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 <= r2 && visit(x, y, z, d2)) return;
              }
            }
          }
        }
      }
    }
  }
}
