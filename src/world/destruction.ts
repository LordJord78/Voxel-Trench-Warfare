/**
 * Blowing holes in things, and what falls in afterwards.
 *
 * Generation and runtime shelling call the same code, so a crater cut at load
 * behaves exactly like one cut at tick 40 000 — the rule the Python game's
 * `world/destruction.py` set, kept here at 10 cm.
 */

import type { Rng } from '../core/rng';
import type { BrickMap } from './bricks';
import { K, P, PALETTE, hardness, isGranular, isLoose, isSolid, kindOf, spoilOf } from './materials';
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

/**
 * A round's mark, ported from Python's `chip`: struck with at least
 * `chipEnergyJ` × its hardness, a voxel becomes its spoil — soil to spoil,
 * timber to rubble, a branch to air. Spoil and rubble are their own spoil, so
 * a second round in the same place does nothing, and air and water have no
 * hardness to mark. A glowing voxel (a lantern's glass, an ember) is left: its
 * light is the plan's, and nothing can put it out yet. True if the voxel
 * changed.
 */
export function chip(map: BrickMap, x: number, y: number, z: number, energyJ: number, chipEnergyJ: number): boolean {
  const p = map.get(x, y, z);
  if (PALETTE[p]?.emission > 0) return false;
  const h = hardness(p);
  if (!(h > 0) || energyJ < chipEnergyJ * h) return false;
  const q = spoilOf(p);
  if (kindOf(q) === kindOf(p)) return false;
  map.set(x, y, z, q);
  return true;
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
 * The cut (cutCrater) is tens of milliseconds; the settling (settleCrater)
 * can be seconds, so a job off the main thread lands the cut first.
 */
export function detonate(map: BrickMap, cx: number, cy: number, cz: number, radius: number, rng: Rng, o: DetonateOptions): Box | null {
  const box = cutCrater(map, cx, cy, cz, radius, rng, o);
  return box && settleCrater(map, box, o);
}

/** detonate's cut: the crater carved and its rind shaken loose. The box its settling starts from, or null if it missed the world. */
export function cutCrater(map: BrickMap, cx: number, cy: number, cz: number, radius: number, rng: Rng, o: DetonateOptions): Box | null {
  if (!(radius > 0)) return null;
  const protect = Uint8Array.from({ length: 256 }, (_, p) => (hardness(p) > o.hardLimit ? 1 : 0));
  if (!carveSphere(map, cx, cy, cz, radius, rng, { protect })) return null;
  carveSphere(map, cx, cy, cz, radius * o.core, rng);
  loosenRim(map, cx, cy, cz, radius * o.loosen, radius);
  const reach = radius * Math.max(o.loosen, 1) + 2;
  const fall = radius * 2 + 4;
  return {
    x0: Math.floor(cx - reach), y0: Math.floor(cy - fall), z0: Math.floor(cz - reach),
    x1: Math.ceil(cx + reach) + 1, y1: Math.ceil(cy + reach) + 1, z1: Math.ceil(cz + reach) + 1,
  };
}

/** detonate's settling: everything in and around `box` (cutCrater's) comes to rest, and it floods. The box it worked over. */
export function settleCrater(map: BrickMap, box: Box, o: DetonateOptions): Box | null {
  return settleRegion(map, box, o.waterTable);
}

/** Everything in and around `box` comes to rest (collapseRegion), and, given the water table, floods. The box it worked over. */
export function settleRegion(map: BrickMap, box: Box, waterTable?: number): Box | null {
  // Flood over everything the collapse touched: slumps displace water out past the blast box.
  const worked = { ...box };
  collapseRegion(map, box, {
    onWork: (w) => {
      worked.x0 = Math.min(worked.x0, w.x0);
      worked.y0 = Math.min(worked.y0, w.y0);
      worked.z0 = Math.min(worked.z0, w.z0);
      worked.x1 = Math.max(worked.x1, w.x1);
      worked.y1 = Math.max(worked.y1, w.y1);
      worked.z1 = Math.max(worked.z1, w.z1);
    },
  });
  if (waterTable !== undefined) floodRegion(map, worked, waterTable);
  return clampBox(worked, map.dims);
}

export interface CollapseOptions {
  /** Safety cap on vertical-plus-repose passes; defaults to 64 or 24 per voxel of region height. */
  maxPasses?: number;
  /** Let loose material slump sideways to its angle of repose. */
  repose?: boolean;
  /** Told each work region collapse settled, so a caller can flood or track exactly that. */
  onWork?: (work: Box) => void;
}

// Per-palette-id lookups for the collapse passes.
const GRANULAR = Uint8Array.from({ length: 256 }, (_, p) => (isGranular(p) ? 1 : 0));
const LOOSE = Uint8Array.from({ length: 256 }, (_, p) => (isLoose(p) ? 1 : 0));
const SOLID = Uint8Array.from({ length: 256 }, (_, p) => (isSolid(p) ? 1 : 0));
const WATER = Uint8Array.from({ length: 256 }, (_, p) => (kindOf(p) === K.WATER ? 1 : 0));
/** Air or water: where a slumping voxel can go (water is displaced, as it is by a falling one). */
const OPEN = Uint8Array.from({ length: 256 }, (_, p) => (p === 0 || kindOf(p) === K.WATER ? 1 : 0));
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
  while (lo < sy && !OPEN[data[base + lo * sx]]) lo++;
  let hi = sy;
  while (hi > 0 && data[base + (hi - 1) * sx] === 0) hi--;
  floor[col] = lo;
  top[col] = hi;
}

/**
 * One repose pass over the candidate columns, column by column (z, then x) and
 * bottom-up within each: a loose voxel resting on something solid steps down
 * and sideways into open cells (air or water) beside and beneath, displacing
 * any water into the cell it left, so draining a puddle afterwards can never
 * leave spoil standing past its angle of repose. Bounds may go
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
        if (!OPEN[data[side]] || !OPEN[data[side - sx]]) continue;
        const displaced = data[side - sx];
        data[side - sx] = p;
        data[i] = displaced;
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

/** Does a resting loose voxel on the work region's outer columns face open air past the region? */
function steepAtEdge(map: BrickMap, work: Box): boolean {
  const outward = (x: number, z: number): [number, number][] => {
    const out: [number, number][] = [];
    if (x === work.x0) out.push([x - 1, z]);
    if (x === work.x1 - 1) out.push([x + 1, z]);
    if (z === work.z0) out.push([x, z - 1]);
    if (z === work.z1 - 1) out.push([x, z + 1]);
    return out;
  };
  const check = (x: number, z: number): boolean => {
    const dirs = outward(x, z).filter(([nx, nz]) => map.inBounds(nx, 0, nz));
    if (dirs.length === 0) return false;
    for (let y = Math.max(1, work.y0); y < work.y1; y++) {
      const v = map.get(x, y, z);
      if (!LOOSE[v] || !SOLID[map.get(x, y - 1, z)]) continue;
      for (const [nx, nz] of dirs) if (OPEN[map.get(nx, y, nz)] && OPEN[map.get(nx, y - 1, nz)]) return true;
    }
    return false;
  };
  for (let x = work.x0; x < work.x1; x++) if (check(x, work.z0) || check(x, work.z1 - 1)) return true;
  for (let z = work.z0; z < work.z1; z++) if (check(work.x0, z) || check(work.x1 - 1, z)) return true;
  return false;
}

/**
 * Settle granular material in and around `box`: soil with nothing solid under
 * it falls (sinking through water, crushing wire), and loose spoil slumps to
 * 45°. The work region is the box widened sideways so a heap has room to
 * spread, extended down through every non-solid gap under any of its columns
 * and up through whatever rests on them; if a heap still reaches the region's
 * edge with open air beyond, the region widens and settles again. After the
 * first pass only columns that moved, and their neighbours, are revisited, so
 * the cost follows the material that moves rather than the volume. A last
 * vertical pass means a run stopped by the cap can leave slopes steep but
 * never leaves soil hanging. Returns how many column updates and slumps it took.
 */
export function collapseRegion(map: BrickMap, box: Box, opts: CollapseOptions = {}): number {
  let total = 0;
  for (let widen = 0, round = 0; round < 6; round++, widen += 24) {
    const { moved, work } = settleOnce(map, box, opts, widen);
    total += moved;
    if (work) opts.onWork?.(work);
    if (!work || !(opts.repose ?? true) || !steepAtEdge(map, work)) break;
  }
  return total;
}

function settleOnce(map: BrickMap, box: Box, opts: CollapseOptions, widen: number): { moved: number; work: Box | null } {
  const repose = opts.repose ?? true;
  const b = clampBox(box, map.dims);
  if (!b) return { moved: 0, work: null };
  const pad = (repose ? Math.min(24, Math.max(4, b.y1 - b.y0)) : 0) + widen;
  const foot = clampBox({ x0: b.x0 - pad, y0: b.y0, z0: b.z0 - pad, x1: b.x1 + pad, y1: b.y1, z1: b.z1 + pad }, map.dims);
  if (!foot) return { moved: 0, work: null };

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
  const work = { ...foot, y0: low, y1: high };
  const region = Region.extract(map, work);
  const columns = region.sx * region.sz;
  // A safety net, not a budget: passes revisit only moving columns, and a parapet
  // sliding into a trench needs hundreds of one-step slumps to come to rest.
  const maxPasses = opts.maxPasses ?? Math.max(64, 24 * region.sy);
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
  return { moved: total, work };
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
