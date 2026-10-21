/**
 * Blowing holes in things, and what falls in afterwards.
 *
 * Generation and runtime shelling call the same code, so a crater cut at load
 * behaves exactly like one cut at tick 40 000 — the rule the Python game's
 * `world/destruction.py` set, kept here at 10 cm.
 */

import type { Rng } from '../core/rng';
import type { BrickMap } from './bricks';
import { K, P, isGranular, isLoose, isSolid, kindOf } from './materials';
import { Region, clampBox, type Box } from './region';

export interface CarveOptions {
  /** What the cut leaves; air unless stated. */
  material?: number;
  /** Radius wobble as a fraction of the radius, so craters are not billiard balls. */
  roughness?: number;
  /** Indexed by palette id: 1 survives the cut (concrete against a light charge). */
  protect?: Uint8Array;
}

function smooth(f: number): number {
  return f * f * (3 - 2 * f);
}

/** Per-axis lattice coordinates for the wobble field, as Python's `np.linspace(0, n-1, extent)`. */
function lattice(size: number, extent: number, n: number): { i0: Int32Array; i1: Int32Array; f: Float64Array } {
  const i0 = new Int32Array(size);
  const i1 = new Int32Array(size);
  const f = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const t = (i / Math.max(1, extent - 1)) * (n - 1);
    const a = Math.floor(t);
    i0[i] = a;
    i1[i] = Math.min(a + 1, n - 1);
    f[i] = smooth(t - a);
  }
  return { i0, i1, f };
}

/**
 * Carve an irregular sphere centred on voxel-space (cx, cy, cz). Returns the
 * clamped box it touched, or null when it misses the world entirely.
 */
export function carveSphere(
  map: BrickMap,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  rng: Rng,
  opts: CarveOptions = {},
): Box | null {
  const material = opts.material ?? 0;
  const roughness = opts.roughness ?? 0.16;
  const protect = opts.protect;
  const rOut = radius * (1 + roughness) + 1;
  const box = clampBox(
    {
      x0: Math.floor(cx - rOut),
      y0: Math.floor(cy - rOut),
      z0: Math.floor(cz - rOut),
      x1: Math.ceil(cx + rOut) + 1,
      y1: Math.ceil(cy + rOut) + 1,
      z1: Math.ceil(cz + rOut) + 1,
    },
    map.dims,
  );
  if (!box) return null;

  const region = Region.extract(map, box);
  const { sx, sy, sz, data } = region;
  const extent = Math.max(sx, sy, sz);
  const n = Math.max(2, Math.floor(extent / 3));
  const grid = new Float64Array(n * n * n);
  for (let i = 0; i < grid.length; i++) grid[i] = rng.normal();
  const lx = lattice(sx, extent, n);
  const ly = lattice(sy, extent, n);
  const lz = lattice(sz, extent, n);
  const scale = roughness * radius;
  const at = (x: number, y: number, z: number) => grid[(z * n + y) * n + x];

  let i = 0;
  for (let z = 0; z < sz; z++) {
    const dz = box.z0 + z + 0.5 - cz;
    const z0 = lz.i0[z], z1 = lz.i1[z], fz = lz.f[z];
    for (let y = 0; y < sy; y++) {
      const dy = box.y0 + y + 0.5 - cy;
      const y0 = ly.i0[y], y1 = ly.i1[y], fy = ly.f[y];
      for (let x = 0; x < sx; x++, i++) {
        const dx = box.x0 + x + 0.5 - cx;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const x0 = lx.i0[x], x1 = lx.i1[x], fx = lx.f[x];
        const c00 = at(x0, y0, z0) * (1 - fx) + at(x1, y0, z0) * fx;
        const c10 = at(x0, y1, z0) * (1 - fx) + at(x1, y1, z0) * fx;
        const c01 = at(x0, y0, z1) * (1 - fx) + at(x1, y0, z1) * fx;
        const c11 = at(x0, y1, z1) * (1 - fx) + at(x1, y1, z1) * fx;
        const c0 = c00 * (1 - fy) + c10 * fy;
        const c1 = c01 * (1 - fy) + c11 * fy;
        const wobble = (c0 * (1 - fz) + c1 * fz) * scale;
        if (dist >= radius + wobble) continue;
        if (protect && protect[data[i]]) continue;
        data[i] = material;
      }
    }
  }
  region.commit(map);
  return box;
}

export interface CollapseOptions {
  /** Ceiling on vertical-plus-repose passes. */
  maxPasses?: number;
  /** Let loose material slump sideways to its angle of repose. */
  repose?: boolean;
}

// Per-palette-id lookups for the collapse passes.
const GRANULAR = Uint8Array.from({ length: 256 }, (_, p) => (isGranular(p) ? 1 : 0));
const LOOSE = Uint8Array.from({ length: 256 }, (_, p) => (isLoose(p) ? 1 : 0));
const SOLID = Uint8Array.from({ length: 256 }, (_, p) => (isSolid(p) ? 1 : 0));
const WATER = Uint8Array.from({ length: 256 }, (_, p) => (kindOf(p) === K.WATER ? 1 : 0));

/** One vertical pass: in every column, granular voxels sink to the nearest fixed support. */
function fallVertical(r: Region): number {
  const { sx, sy, sz, data } = r;
  const grains: number[] = [];
  const waters: number[] = [];
  let moved = 0;
  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      const column = z * sy * sx + x;
      let start = 0;
      for (let y = 0; y <= sy; y++) {
        const p = y < sy ? data[column + y * sx] : -1;
        const fixed = p >= 0 && SOLID[p] === 1 && GRANULAR[p] === 0;
        if (y < sy && !fixed) {
          if (GRANULAR[p]) grains.push(p);
          else if (WATER[p]) waters.push(p);
          continue;
        }
        // Segment [start, y): grains first, then water, then air.
        let k = start;
        for (const g of grains) {
          const i = column + k * sx;
          if (data[i] !== g) {
            data[i] = g;
            moved++;
          }
          k++;
        }
        for (const w of waters) data[column + k++ * sx] = w;
        while (k < y) data[column + k++ * sx] = P.AIR;
        grains.length = 0;
        waters.length = 0;
        start = y + 1;
      }
    }
  }
  return moved;
}

const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/** One repose pass: a resting loose voxel steps down and sideways into open air. */
function slump(r: Region): number {
  const { sx, sy, sz, data } = r;
  const layer = sx;
  const plane = sy * sx;
  let moved = 0;
  for (let y = 1; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const i = z * plane + y * layer + x;
        const p = data[i];
        if (!LOOSE[p] || !SOLID[data[i - layer]]) continue;
        for (const [dx, dz] of DIRECTIONS) {
          const nx = x + dx;
          const nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= sx || nz >= sz) continue;
          const side = nz * plane + y * layer + nx;
          if (data[side] !== P.AIR || data[side - layer] !== P.AIR) continue;
          data[side - layer] = p;
          data[i] = P.AIR;
          moved++;
          break;
        }
      }
    }
  }
  return moved;
}

/**
 * Settle granular material in and around `box`: soil with nothing under it
 * falls (displacing water upward), and loose spoil slumps to 45°. Works on the
 * columns of the box, extended down to whatever they rest on and up through
 * whatever rests on them, widened sideways so a slumping heap has room.
 * Returns how many voxel moves it took.
 */
export function collapseRegion(map: BrickMap, box: Box, opts: CollapseOptions = {}): number {
  const maxPasses = opts.maxPasses ?? 64;
  const repose = opts.repose ?? true;
  const b = clampBox(box, map.dims);
  if (!b) return 0;

  let low = b.y0;
  let high = b.y1;
  for (let z = b.z0; z < b.z1; z++) {
    for (let x = b.x0; x < b.x1; x++) {
      let y = b.y0;
      while (y > 0 && (map.get(x, y - 1, z) === P.AIR || WATER[map.get(x, y - 1, z)])) y--;
      if (y < low) low = y;
      let top = b.y1;
      while (top < map.dims.y && map.get(x, top, z) !== P.AIR) top++;
      if (top > high) high = top;
    }
  }
  const pad = repose ? Math.min(24, Math.max(4, b.y1 - b.y0)) : 0;
  const work = clampBox({ x0: b.x0 - pad, y0: low, z0: b.z0 - pad, x1: b.x1 + pad, y1: high, z1: b.z1 + pad }, map.dims);
  if (!work) return 0;

  const region = Region.extract(map, work);
  let total = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    const moved = fallVertical(region) + (repose ? slump(region) : 0);
    total += moved;
    if (moved === 0) break;
  }
  region.commit(map);
  return total;
}

/**
 * Standing water as a state the world settles into, not a fluid: every open
 * voxel in `box` at or below the water table fills, then water left hanging
 * over a gap drains. Same rule as the Python game's `water.flood_region`.
 */
export function floodRegion(map: BrickMap, box: Box, waterTable: number): void {
  const b = clampBox(box, map.dims);
  if (!b) return;
  const region = Region.extract(map, { ...b, y0: Math.max(0, b.y0 - 1) });
  const { sx, sy, sz, data } = region;
  const base = region.box.y0;
  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      for (let y = b.y0 - base; y < sy; y++) {
        const i = (z * sy + y) * sx + x;
        if (base + y <= waterTable && data[i] === P.AIR) data[i] = P.WATER;
      }
      for (let y = b.y0 - base; y < sy; y++) {
        const i = (z * sy + y) * sx + x;
        if (!WATER[data[i]]) continue;
        const worldY = base + y;
        const below = worldY === 0 ? -1 : y > 0 ? data[i - sx] : map.get(region.box.x0 + x, worldY - 1, region.box.z0 + z);
        const held = below === -1 || SOLID[below] === 1 || WATER[below] === 1;
        if (!held) data[i] = P.AIR;
      }
    }
  }
  region.commit(map);
}
