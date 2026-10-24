/**
 * The land past the playable edge, to about 2 km in every direction.
 *
 * A 2048 × 2048 height map at 2 m, centred on the map, from the same terrain
 * function as the voxel world — so the two meet without a seam — plus broad
 * hills, woods, the shelterbelts running on past the edge, and three distant
 * villages, one with a spire. Features begin 10 m out, so the first ring past
 * the edge is the field itself. The renderer ray-marches it; inside the
 * playable map it is empty (material 0).
 */

import { hash32x4 } from '../../core/hash';
import { Rng } from '../../core/rng';
import { fbm } from './noise';
import { vx } from './params';
import type { WorldPlan } from './plan';
import { fieldHeight } from './terrain';

export const FAR = { NONE: 0, FIELD: 1, PLOUGHED: 2, WOOD: 3, ROOF: 4, WALL: 5, SPIRE: 6 } as const;

export interface FarField {
  size: number;
  /** Cell edge in voxels. */
  cell: number;
  /** World voxel coordinates of cell (0, 0)'s corner. */
  originX: number;
  originZ: number;
  /** Height of each cell's top in voxels (row-major, z rows); -Infinity inside the playable map. */
  height: Float32Array;
  material: Uint8Array;
}

interface Village {
  x: number;
  z: number;
  r: number;
  spire: boolean;
}

function villages(plan: WorldPlan): Village[] {
  const p = plan.params;
  const r = Rng.root(plan.seed).derive('farfield');
  const out: Village[] = [];
  const cx = p.dims.x / 2;
  const cz = p.dims.z / 2;
  while (out.length < 3) {
    const x = cx + r.uniform(-vx(1500, p.voxel), vx(1500, p.voxel));
    const z = cz + r.uniform(-vx(1500, p.voxel), vx(1500, p.voxel));
    const d = Math.sqrt((x - cx) * (x - cx) + (z - cz) * (z - cz));
    if (d < vx(600, p.voxel) || d > vx(1500, p.voxel)) continue;
    out.push({ x, z, r: vx(r.uniform(40, 80), p.voxel), spire: out.length === 0 });
  }
  return out;
}

/** The height (metres) of the far field's cell under (x, z) metres, the grid's edge beyond it; -Infinity inside the playable map. */
export function farHeightM(ff: FarField, xM: number, zM: number, voxel: number): number {
  const col = Math.min(ff.size - 1, Math.max(0, Math.floor((xM / voxel - ff.originX) / ff.cell)));
  const row = Math.min(ff.size - 1, Math.max(0, Math.floor((zM / voxel - ff.originZ) / ff.cell)));
  return ff.height[row * ff.size + col] * voxel;
}

export function emptyFarField(plan: WorldPlan): FarField {
  const p = plan.params;
  const size = 2048;
  const cell = vx(2.0, p.voxel);
  return {
    size,
    cell,
    originX: p.dims.x / 2 - (size * cell) / 2,
    originZ: p.dims.z / 2 - (size * cell) / 2,
    height: new Float32Array(size * size),
    material: new Uint8Array(size * size),
  };
}

/** Fill rows [row0, row1) of `out`. Pure per cell, so rows can be split across workers. */
export function farFieldRows(plan: WorldPlan, row0: number, row1: number, out: FarField): void {
  const p = plan.params;
  const salt = plan.terrain.salt;
  const towns = villages(plan);
  const edge = vx(10, p.voxel);
  const fadeOver = vx(300, p.voxel);
  const hillCell = vx(400, p.voxel);
  const woodCell = vx(250, p.voxel);
  for (let row = row0; row < row1; row++) {
    const z = out.originZ + (row + 0.5) * out.cell;
    for (let col = 0; col < out.size; col++) {
      const x = out.originX + (col + 0.5) * out.cell;
      const i = row * out.size + col;
      if (x >= 0 && x < p.dims.x && z >= 0 && z < p.dims.z) {
        out.height[i] = -Infinity;
        out.material[i] = FAR.NONE;
        continue;
      }
      const dx = x < 0 ? -x : x >= p.dims.x ? x - p.dims.x : 0;
      const dz = z < 0 ? -z : z >= p.dims.z ? z - p.dims.z : 0;
      const dist = Math.max(dx, dz);
      const fade = Math.min(1, dist / fadeOver);
      const hills = Math.min(1, Math.max(0, (fbm(x, z, hillCell, 3, 0.5, salt ^ 0x51ed) - 0.35) / 0.3)) * vx(12, p.voxel);
      let h = fieldHeight(plan.terrain, p, x, z) + hills * fade;
      let material: number = (hash32x4(Math.floor(x / vx(80, p.voxel)), Math.floor(z / vx(60, p.voxel)), salt, 7) & 1) === 0 ? FAR.FIELD : FAR.PLOUGHED;
      if (dist >= edge) {
        const belt = p.layout.shelterbelts.some((bz) => Math.abs(z - bz) < vx(4, p.voxel)) && dx > 0;
        const wood = fbm(x, z, woodCell, 2, 0.5, salt ^ 0x3d00d) > 0.62;
        if (belt || wood) {
          material = FAR.WOOD;
          h += vx(belt ? 4 : 6, p.voxel) * (0.75 + (hash32x4(col, row, salt, 9) & 63) / 256);
        }
        for (const t of towns) {
          const tx = x - t.x;
          const tz = z - t.z;
          if (tx * tx + tz * tz > t.r * t.r) continue;
          const block = (Math.floor(x / out.cell) & 3) !== 3 && (Math.floor(z / out.cell) & 3) !== 3;
          if (block) {
            const tall = hash32x4(Math.floor(x / (out.cell * 4)), Math.floor(z / (out.cell * 4)), salt, 11) & 255;
            material = tall < 128 ? FAR.ROOF : FAR.WALL;
            h += vx(5, p.voxel) + (tall % vx(4, p.voxel));
          } else {
            material = FAR.FIELD;
          }
          if (t.spire && tx * tx + tz * tz < out.cell * out.cell) {
            material = FAR.SPIRE;
            h += vx(25, p.voxel);
          }
        }
      }
      out.height[i] = h;
      out.material[i] = material;
    }
  }
}

export function buildFarField(plan: WorldPlan): FarField {
  const out = emptyFarField(plan);
  farFieldRows(plan, 0, out.size, out);
  return out;
}
