/**
 * Boxes and dense region copies.
 *
 * Carving, collapse and flooding touch every voxel in a box, sometimes many
 * times. Doing that through the brick table costs a lookup per access, so they
 * copy the box out into a flat array, work there, and write back only what
 * changed — which also keeps the dirty set to the bricks that really moved.
 */

import { BRICK, BrickMap, UNIFORM, type Dims } from './bricks';

/** Half-open voxel box: [x0, x1) × [y0, y1) × [z0, z1). */
export interface Box {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

/** Clamp to the world, widening fractional edges outward; null if nothing is left. */
export function clampBox(box: Box, dims: Dims): Box | null {
  const out = {
    x0: Math.max(0, Math.floor(box.x0)),
    y0: Math.max(0, Math.floor(box.y0)),
    z0: Math.max(0, Math.floor(box.z0)),
    x1: Math.min(dims.x, Math.ceil(box.x1)),
    y1: Math.min(dims.y, Math.ceil(box.y1)),
    z1: Math.min(dims.z, Math.ceil(box.z1)),
  };
  if (out.x0 >= out.x1 || out.y0 >= out.y1 || out.z0 >= out.z1) return null;
  return out;
}

export class Region {
  readonly box: Box;
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly data: Uint8Array;
  private readonly original: Uint8Array;

  private constructor(box: Box, data: Uint8Array) {
    this.box = box;
    this.sx = box.x1 - box.x0;
    this.sy = box.y1 - box.y0;
    this.sz = box.z1 - box.z0;
    this.data = data;
    this.original = data.slice();
  }

  /** Copy a box out of the map, brick by brick. */
  static extract(map: BrickMap, box: Box): Region {
    const b = clampBox(box, map.dims);
    if (!b) throw new RangeError('region is empty once clamped to the world');
    const sx = b.x1 - b.x0;
    const sy = b.y1 - b.y0;
    const data = new Uint8Array(sx * sy * (b.z1 - b.z0));
    for (let kz = b.z0 >> 3; kz <= (b.z1 - 1) >> 3; kz++) {
      const z0 = Math.max(b.z0, kz * BRICK);
      const z1 = Math.min(b.z1, kz * BRICK + BRICK);
      for (let ky = b.y0 >> 3; ky <= (b.y1 - 1) >> 3; ky++) {
        const y0 = Math.max(b.y0, ky * BRICK);
        const y1 = Math.min(b.y1, ky * BRICK + BRICK);
        for (let kx = b.x0 >> 3; kx <= (b.x1 - 1) >> 3; kx++) {
          const bi = map.brickIndex(kx, ky, kz);
          const e = map.table[bi];
          if (e === 0) continue;
          const x0 = Math.max(b.x0, kx * BRICK);
          const x1 = Math.min(b.x1, kx * BRICK + BRICK);
          const view = e & UNIFORM ? null : map.denseView(bi);
          for (let z = z0; z < z1; z++) {
            for (let y = y0; y < y1; y++) {
              const row = ((z - b.z0) * sy + (y - b.y0)) * sx + (x0 - b.x0);
              if (view === null) data.fill(e & 0xff, row, row + (x1 - x0));
              else {
                const src = ((y & 7) << 3) + ((z & 7) << 6);
                data.set(view.subarray(src + (x0 & 7), src + (x0 & 7) + (x1 - x0)), row);
              }
            }
          }
        }
      }
    }
    return new Region(b, data);
  }

  contains(x: number, y: number, z: number): boolean {
    const b = this.box;
    return x >= b.x0 && y >= b.y0 && z >= b.z0 && x < b.x1 && y < b.y1 && z < b.z1;
  }

  /** Flat index of a world-space voxel inside the region. */
  index(x: number, y: number, z: number): number {
    return ((z - this.box.z0) * this.sy + (y - this.box.y0)) * this.sx + (x - this.box.x0);
  }

  get(x: number, y: number, z: number): number {
    return this.contains(x, y, z) ? this.data[this.index(x, y, z)] : 0;
  }

  set(x: number, y: number, z: number, p: number): void {
    if (this.contains(x, y, z)) this.data[this.index(x, y, z)] = p;
  }

  /** Write back the voxels that differ from what was extracted; returns how many. */
  commit(map: BrickMap): number {
    let changed = 0;
    const { x0, y0, z0 } = this.box;
    let i = 0;
    for (let z = 0; z < this.sz; z++) {
      for (let y = 0; y < this.sy; y++) {
        for (let x = 0; x < this.sx; x++, i++) {
          const v = this.data[i];
          if (v === this.original[i]) continue;
          map.set(x0 + x, y0 + y, z0 + z, v);
          this.original[i] = v;
          changed++;
        }
      }
    }
    return changed;
  }
}
