/**
 * Blowing holes in things, and what falls in afterwards.
 *
 * Generation and runtime shelling call the same code, so a crater cut at load
 * behaves exactly like one cut at tick 40 000 — the rule the Python game's
 * `world/destruction.py` set, kept here at 10 cm.
 */

import type { Rng } from '../core/rng';
import type { BrickMap } from './bricks';
import { K, P, hardness, isGranular, isLoose, isSolid, kindOf, spoilOf } from './materials';
import { Region, clampBox, type Box } from './region';
import type { Clip, VoxelSink } from './sink';

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
 * The irregular sphere itself: its unclamped box and an inside test. The wobble
 * lattice spans the unclamped box, so a carve cut short by the world's edge, or
 * drawn piecewise by several bands, cuts exactly the voxels the whole one does.
 */
function wobbleSphere(cx: number, cy: number, cz: number, radius: number, rng: Rng, roughness: number) {
  const rOut = radius * (1 + roughness) + 1;
  const box: Box = {
    x0: Math.floor(cx - rOut),
    y0: Math.floor(cy - rOut),
    z0: Math.floor(cz - rOut),
    x1: Math.ceil(cx + rOut) + 1,
    y1: Math.ceil(cy + rOut) + 1,
    z1: Math.ceil(cz + rOut) + 1,
  };
  const sx = box.x1 - box.x0;
  const sy = box.y1 - box.y0;
  const sz = box.z1 - box.z0;
  const extent = Math.max(sx, sy, sz);
  const n = Math.max(2, Math.floor(extent / 3));
  const grid = new Float64Array(n * n * n);
  for (let i = 0; i < grid.length; i++) grid[i] = rng.normal();
  const lx = lattice(sx, extent, n);
  const ly = lattice(sy, extent, n);
  const lz = lattice(sz, extent, n);
  const scale = roughness * radius;
  const at = (x: number, y: number, z: number) => grid[(z * n + y) * n + x];
  const inside = (x: number, y: number, z: number): boolean => {
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - cy;
    const dz = z + 0.5 - cz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const ix = x - box.x0;
    const iy = y - box.y0;
    const iz = z - box.z0;
    const fx = lx.f[ix], fy = ly.f[iy], fz = lz.f[iz];
    const x0 = lx.i0[ix], x1 = lx.i1[ix], y0 = ly.i0[iy], y1 = ly.i1[iy], z0 = lz.i0[iz], z1 = lz.i1[iz];
    const c00 = at(x0, y0, z0) * (1 - fx) + at(x1, y0, z0) * fx;
    const c10 = at(x0, y1, z0) * (1 - fx) + at(x1, y1, z0) * fx;
    const c01 = at(x0, y0, z1) * (1 - fx) + at(x1, y0, z1) * fx;
    const c11 = at(x0, y1, z1) * (1 - fx) + at(x1, y1, z1) * fx;
    const c0 = c00 * (1 - fy) + c10 * fy;
    const c1 = c01 * (1 - fy) + c11 * fy;
    return dist < radius + (c0 * (1 - fz) + c1 * fz) * scale;
  };
  return { box, inside };
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
  const protect = opts.protect;
  const sphere = wobbleSphere(cx, cy, cz, radius, rng, opts.roughness ?? 0.16);
  const box = clampBox(sphere.box, map.dims);
  if (!box) return null;
  const region = Region.extract(map, box);
  let i = 0;
  for (let z = box.z0; z < box.z1; z++) {
    for (let y = box.y0; y < box.y1; y++) {
      for (let x = box.x0; x < box.x1; x++, i++) {
        if (!sphere.inside(x, y, z)) continue;
        if (protect && protect[region.data[i]]) continue;
        region.data[i] = material;
      }
    }
  }
  region.commit(map);
  return box;
}

/** The same cut through a sink in world coordinates, writing only inside `clip`. */
export function carveWith(
  sink: VoxelSink,
  clip: Clip,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  rng: Rng,
  opts: CarveOptions = {},
): void {
  const material = opts.material ?? 0;
  const protect = opts.protect;
  const sphere = wobbleSphere(cx, cy, cz, radius, rng, opts.roughness ?? 0.16);
  const b = sphere.box;
  for (let z = b.z0; z < b.z1; z++) {
    for (let y = Math.max(0, b.y0); y < b.y1; y++) {
      for (let x = Math.max(b.x0, clip.x0); x < Math.min(b.x1, clip.x1); x++) {
        if (!sphere.inside(x, y, z)) continue;
        if (protect && protect[sink.get(x, y, z)]) continue;
        sink.set(x, y, z, material);
      }
    }
  }
}

/** Python's `_loosen_rim`: intact ground just outside the crater is shaken into whatever it spoils to. */
export function loosenRim(map: BrickMap, cx: number, cy: number, cz: number, outer: number, inner: number): Box | null {
  const box = clampBox(
    {
      x0: Math.floor(cx - outer), y0: Math.floor(cy - outer), z0: Math.floor(cz - outer),
      x1: Math.ceil(cx + outer) + 1, y1: Math.ceil(cy + outer) + 1, z1: Math.ceil(cz + outer) + 1,
    },
    map.dims,
  );
  if (!box) return null;
  const region = Region.extract(map, box);
  let i = 0;
  for (let z = box.z0; z < box.z1; z++) {
    for (let y = box.y0; y < box.y1; y++) {
      for (let x = box.x0; x < box.x1; x++, i++) {
        const v = region.data[i];
        if (v === 0) continue;
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const dz = z + 0.5 - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= inner * inner && d2 < outer * outer) region.data[i] = spoilOf(v);
      }
    }
  }
  region.commit(map);
  return box;
}

export interface DetonateOptions {
  /** Materials harder than this survive outside the core. */
  hardLimit: number;
  /** Core radius as a fraction of the crater's: inside it nothing survives. */
  core: number;
  /** Loosened rind's outer radius as a fraction of the crater's. */
  loosen: number;
  waterTable: number;
}

/**
 * A shell landing, ported from Python's `detonate`: cut the crater (concrete
 * and masonry give way only in the core), shake the rind around it loose,
 * let everything settle, and let it flood. Returns the box it worked over.
 */
export function detonate(map: BrickMap, cx: number, cy: number, cz: number, radius: number, rng: Rng, o: DetonateOptions): Box | null {
  if (!(radius > 0)) return null;
  const protect = Uint8Array.from({ length: 256 }, (_, p) => (hardness(p) > o.hardLimit ? 1 : 0));
  if (!carveSphere(map, cx, cy, cz, radius, rng, { protect })) return null;
  carveSphere(map, cx, cy, cz, radius * o.core, rng);
  loosenRim(map, cx, cy, cz, radius * o.loosen, radius);
  const reach = radius * Math.max(o.loosen, 1) + 2;
  const fall = radius * 2 + 4;
  const box: Box = {
    x0: Math.floor(cx - reach), y0: Math.floor(cy - fall), z0: Math.floor(cz - reach),
    x1: Math.ceil(cx + reach) + 1, y1: Math.ceil(cy + reach) + 1, z1: Math.ceil(cz + reach) + 1,
  };
  collapseRegion(map, box);
  floodRegion(map, box, o.waterTable);
  return clampBox(box, map.dims);
}

export interface CollapseOptions {
  /** Safety cap on vertical-plus-repose passes; defaults to 64 or four per voxel of region height. */
  maxPasses?: number;
  /** Let loose material slump sideways to its angle of repose. */
  repose?: boolean;
}

// Per-palette-id lookups for the collapse passes.
const GRANULAR = Uint8Array.from({ length: 256 }, (_, p) => (isGranular(p) ? 1 : 0));
const LOOSE = Uint8Array.from({ length: 256 }, (_, p) => (isLoose(p) ? 1 : 0));
const SOLID = Uint8Array.from({ length: 256 }, (_, p) => (isSolid(p) ? 1 : 0));
const WATER = Uint8Array.from({ length: 256 }, (_, p) => (kindOf(p) === K.WATER ? 1 : 0));
/** Solid and not granular: timber, brick, steel. They hold, and soil rests on them. */
const FIXED = Uint8Array.from({ length: 256 }, (_, p) => (SOLID[p] && !GRANULAR[p] ? 1 : 0));

/**
 * Settle one column segment between fixed solids, as Python's repeated
 * one-voxel falls would leave it: grains end stacked from the bottom in their
 * original order, water they sank through sits on top of them, and anything
 * non-solid a grain fell through — wire, a curtain — is crushed. Cells above
 * the highest grain are untouched, so a picket nothing fell on keeps standing.
 */
function settleSegment(data: Uint8Array, base: number, step: number, start: number, end: number, grains: number[], waters: number[]): boolean {
  let top = -1;
  for (let y = end - 1; y >= start; y--) {
    if (GRANULAR[data[base + y * step]]) {
      top = y;
      break;
    }
  }
  if (top < 0) return false;
  grains.length = 0;
  waters.length = 0;
  for (let y = start; y <= top; y++) {
    const v = data[base + y * step];
    if (GRANULAR[v]) grains.push(v);
    else if (WATER[v]) waters.push(v);
  }
  let changed = false;
  let k = start;
  for (let n = 0; n < grains.length + waters.length; n++, k++) {
    const v = n < grains.length ? grains[n] : waters[n - grains.length];
    const i = base + k * step;
    if (data[i] !== v) {
      data[i] = v;
      changed = true;
    }
  }
  for (; k <= top; k++) {
    const i = base + k * step;
    if (data[i] !== 0) {
      data[i] = 0;
      changed = true;
    }
  }
  return changed;
}

/** One vertical pass over the listed columns, marking the ones that changed. */
function fallColumns(r: Region, columns: Iterable<number>, changed: Uint8Array): number {
  const { sx, sy, data } = r;
  const grains: number[] = [];
  const waters: number[] = [];
  let moved = 0;
  for (const col of columns) {
    const x = col % sx;
    const z = (col - x) / sx;
    const base = z * sy * sx + x;
    let start = 0;
    while (start < sy) {
      let end = start;
      while (end < sy && !FIXED[data[base + end * sx]]) end++;
      if (settleSegment(data, base, sx, start, end, grains, waters)) {
        changed[col] = 1;
        moved++;
      }
      start = end + 1;
    }
  }
  return moved;
}

const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/**
 * Per column: the lowest air cell (`floor`, or sy if none) and one past the
 * highest non-air cell (`top`). A resting loose voxel can only slump into a
 * neighbour's air with air beneath it, so it lies above some neighbour's
 * lowest air and below its own top: the repose pass scans that band only.
 */
function columnBounds(r: Region, col: number, floor: Int16Array, top: Int16Array): void {
  const { sx, sy, data } = r;
  const x = col % sx;
  const z = (col - x) / sx;
  const base = z * sy * sx + x;
  let lo = 0;
  while (lo < sy && data[base + lo * sx] !== 0) lo++;
  let hi = sy;
  while (hi > 0 && data[base + (hi - 1) * sx] === 0) hi--;
  floor[col] = lo;
  top[col] = hi;
}

/**
 * One repose pass over the candidate columns, column by column (z, then x) and
 * bottom-up within each: a loose voxel resting on something solid steps down
 * and sideways into a cell that is air with air beneath it. Bounds may go
 * stale within a pass; a column that moved is revisited next pass with fresh
 * ones, so a stale bound only ever delays a slump, never loses one.
 */
function slumpColumns(r: Region, candidates: number[], changed: Uint8Array, floor: Int16Array, top: Int16Array): number {
  const { sx, sy, sz, data } = r;
  let moved = 0;
  for (const col of candidates) {
    const x = col % sx;
    const z = (col - x) / sx;
    let lo = sy;
    if (x > 0) lo = Math.min(lo, floor[col - 1] + 1);
    if (x + 1 < sx) lo = Math.min(lo, floor[col + 1] + 1);
    if (z > 0) lo = Math.min(lo, floor[col - sx] + 1);
    if (z + 1 < sz) lo = Math.min(lo, floor[col + sx] + 1);
    const hi = top[col];
    for (let y = Math.max(1, lo); y < hi; y++) {
      const i = (z * sy + y) * sx + x;
      const p = data[i];
      if (!LOOSE[p] || !SOLID[data[i - sx]]) continue;
      for (const [dx, dz] of DIRECTIONS) {
        const nx = x + dx;
        const nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= sx || nz >= sz) continue;
        const side = (nz * sy + y) * sx + nx;
        if (data[side] !== 0 || data[side - sx] !== 0) continue;
        data[side - sx] = p;
        data[i] = 0;
        changed[col] = 1;
        changed[nz * sx + nx] = 1;
        moved++;
        break;
      }
    }
  }
  return moved;
}

/** The columns that changed plus their four neighbours: the only places the next pass can move anything. */
function nextActive(r: Region, changed: Uint8Array): number[] {
  const { sx, sz } = r;
  const mark = new Uint8Array(changed.length);
  for (let col = 0; col < changed.length; col++) {
    if (!changed[col]) continue;
    const x = col % sx;
    const z = (col - x) / sx;
    mark[col] = 1;
    if (x > 0) mark[col - 1] = 1;
    if (x + 1 < sx) mark[col + 1] = 1;
    if (z > 0) mark[col - sx] = 1;
    if (z + 1 < sz) mark[col + sx] = 1;
  }
  const out: number[] = [];
  for (let col = 0; col < mark.length; col++) if (mark[col]) out.push(col);
  return out;
}

/**
 * Settle granular material in and around `box`: soil with nothing solid under
 * it falls (sinking through water, crushing wire), and loose spoil slumps to
 * 45°. The work region is the box widened sideways so a heap has room to
 * spread, extended down through every non-solid gap under any of its columns
 * and up through whatever rests on them. After the first pass only columns
 * that moved, and their neighbours, are revisited, so the cost follows the
 * material that moves rather than the volume. A last vertical pass means a run
 * stopped by the cap can leave slopes steep but never leaves soil hanging.
 * Returns how many column updates and slumps it took.
 */
export function collapseRegion(map: BrickMap, box: Box, opts: CollapseOptions = {}): number {
  const repose = opts.repose ?? true;
  const b = clampBox(box, map.dims);
  if (!b) return 0;
  const pad = repose ? Math.min(24, Math.max(4, b.y1 - b.y0)) : 0;
  const foot = clampBox({ x0: b.x0 - pad, y0: b.y0, z0: b.z0 - pad, x1: b.x1 + pad, y1: b.y1, z1: b.z1 + pad }, map.dims);
  if (!foot) return 0;

  let low = b.y0;
  let high = b.y1;
  for (let z = foot.z0; z < foot.z1; z++) {
    for (let x = foot.x0; x < foot.x1; x++) {
      let y = b.y0;
      while (y > 0 && !isSolid(map.get(x, y - 1, z))) y--;
      if (y < low) low = y;
      let top = b.y1;
      while (top < map.dims.y && map.get(x, top, z) !== 0) top++;
      if (top > high) high = top;
    }
  }
  const region = Region.extract(map, { ...foot, y0: low, y1: high });
  const columns = region.sx * region.sz;
  const maxPasses = opts.maxPasses ?? Math.max(64, 4 * region.sy);
  const changed = new Uint8Array(columns);
  const floor = new Int16Array(columns);
  const top = new Int16Array(columns);
  let active: number[] = Array.from({ length: columns }, (_, i) => i);
  let total = 0;
  for (let pass = 0; pass < maxPasses && active.length > 0; pass++) {
    changed.fill(0);
    let moved = fallColumns(region, active, changed);
    if (repose) {
      for (const col of active) columnBounds(region, col, floor, top);
      moved += slumpColumns(region, active, changed, floor, top);
    }
    total += moved;
    if (moved === 0) break;
    active = nextActive(region, changed);
  }
  total += fallColumns(region, Array.from({ length: columns }, (_, i) => i), changed);
  region.commit(map);
  return total;
}

/**
 * Standing water as a state the world settles into, not a fluid: every open
 * voxel in `box` at or below the water table fills, water left hanging over a
 * gap drains, and water pushed above the table (dirt sinking into a pool
 * displaces it) runs off. The Python game kept displaced water; the spec's
 * world has water only at or below the table.
 */
export function floodRegion(map: BrickMap, box: Box, waterTable: number): void {
  const b = clampBox(box, map.dims);
  if (!b) return;
  const region = Region.extract(map, { ...b, y0: Math.max(0, b.y0 - 1) });
  const { sx, sy, sz, data } = region;
  const base: number = region.box.y0;
  const start: number = b.y0 - base;
  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      for (let y = start; y < sy; y++) {
        const i = (z * sy + y) * sx + x;
        if (base + y <= waterTable && data[i] === P.AIR) data[i] = P.WATER;
      }
      for (let y = start; y < sy; y++) {
        const i = (z * sy + y) * sx + x;
        if (!WATER[data[i]]) continue;
        const worldY: number = base + y;
        const below: number = worldY === 0 ? -1 : y > 0 ? data[i - sx] : map.get(region.box.x0 + x, worldY - 1, region.box.z0 + z);
        const held = below === -1 || SOLID[below] === 1 || WATER[below] === 1;
        if (!held || worldY > waterTable) data[i] = P.AIR;
      }
    }
  }
  region.commit(map);
}
