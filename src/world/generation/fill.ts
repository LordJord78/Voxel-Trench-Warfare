/**
 * Filling a band: column heights to voxels.
 *
 * A band is 32 voxels of x, every y and z. Each column's materials follow from
 * its heights alone — strata against the undisturbed ground, the trench's
 * duckboards and timber, spoil, revetment by the bay's style, water to the
 * table — with per-voxel variety from a hash of the voxel's coordinates, never
 * from a random stream, so any worker produces the same bytes.
 *
 * Built settled: loose material that would sit past 45° beside a lower column
 * is laid as packed mud instead, so nothing needs to fall.
 */

import { hash32x4 } from '../../core/hash';
import { BrickMap, UNIFORM } from '../bricks';
import { P, isLoose, isSolid, kindOf, K } from '../materials';
import { FLAG, columnModel, type ColumnModel } from './columns';
import { vx } from './params';
import { bayList, type WorldPlan } from './plan';
import type { BayPlan } from './trenches';

export const BAND = 32;

export interface BandResult {
  band: number;
  table: Uint32Array;
  /** 512 bytes per dense brick, in `denseBricks` order. */
  dense: Uint8Array;
  /** Band-local brick indices of the dense bricks, ascending. */
  denseBricks: Uint32Array;
}

const LOOSE = Uint8Array.from({ length: 256 }, (_, p) => (isLoose(p) ? 1 : 0));
const SOLID = Uint8Array.from({ length: 256 }, (_, p) => (isSolid(p) ? 1 : 0));
const WATERY = Uint8Array.from({ length: 256 }, (_, p) => (kindOf(p) === K.WATER ? 1 : 0));

/** A byte of per-voxel variety, the same in every worker. */
function shade(x: number, y: number, z: number, salt: number): number {
  return hash32x4(x, y, z, salt) & 255;
}

interface Context {
  plan: WorldPlan;
  bays: BayPlan[];
  sod: number;
  mud: number;
  clay: number;
  ploughPeriod: number;
  ploughPhase: number;
  nmlLo: number;
  nmlHi: number;
  post: number;
}

function context(plan: WorldPlan): Context {
  const p = plan.params;
  const period = vx(3.5, p.voxel);
  return {
    plan,
    bays: bayList(plan),
    sod: 1,
    mud: vx(1.5, p.voxel),
    clay: vx(4.0, p.voxel),
    ploughPeriod: period,
    ploughPhase: plan.terrain.salt % period,
    nmlLo: p.layout.front,
    nmlHi: p.layout.enemyFront,
    post: vx(1.2, p.voxel),
  };
}

function strata(ctx: Context, ground: number, x: number, y: number, z: number): number {
  const depth = ground - y;
  if (depth <= ctx.sod) {
    const ploughed = (z < ctx.nmlLo || z > ctx.nmlHi) && Math.floor((z + ctx.ploughPhase) / ctx.ploughPeriod) % 2 === 0;
    if (ploughed) return P.MUD_TURNED;
    const h = shade(x, y, z, 1);
    return h < 180 ? P.SOD : h < 230 ? P.SOD_DRY : P.SOD_TUFT;
  }
  if (depth <= ctx.mud) return P.MUD;
  if (depth <= ctx.clay) return P.CLAY;
  return P.SUBSOIL;
}

function revetment(ctx: Context, bay: BayPlan | undefined, x: number, y: number, z: number, from: number): number {
  const a = bay && bay.longAxis === 2 ? z : x;
  if (a % ctx.post === 0) return P.TIMBER_DARK;
  switch (bay?.revet ?? 'planks') {
    case 'corrugated':
      return shade(x, y, z, 3) < 50 ? P.CORRUGATE_RUST : P.CORRUGATE;
    case 'hurdles':
      return ((a >> 1) + (y >> 1)) % 2 === 0 ? P.BRANCH : P.TRUNK_BARK;
    default:
      return ((y - from) >> 1) % 2 === 0 ? P.TIMBER : P.TIMBER_WEATHERED;
  }
}

/**
 * Material of column `c` (world x, z) for y in [y0, y1), written to out[0..).
 * `below` is the voxel under y0, for the water rule.
 */
function writeColumn(ctx: Context, m: ColumnModel, c: number, x: number, z: number, y0: number, y1: number, below: number, out: Uint8Array): void {
  const p = ctx.plan.params;
  const ground = m.ground[c];
  const surface = m.surface[c];
  const floor = m.floor[c];
  const solidTop = m.solidTop[c];
  const spoilTop = m.spoilTop[c];
  const revetTop = m.revetTop[c];
  const revetFrom = m.revetFrom[c];
  const flags = m.flags[c];
  const bay = m.bay[c] >= 0 ? ctx.bays[m.bay[c]] : undefined;
  const trench = (flags & FLAG.TRENCH) !== 0;
  const along = bay && bay.longAxis === 2 ? z : x;
  // Neighbour tops for the repose rule; outside the world counts as solid.
  const zTop = (dz: number) => (z + dz < 0 || z + dz >= m.nz ? 32767 : m.top[c + dz]);
  const nTop = Math.min(m.top[c - m.nz], m.top[c + m.nz], zTop(-1), zTop(1));
  let prev = below;
  for (let y = y0; y < y1; y++) {
    let v: number;
    if (trench) {
      if (y < floor) v = strata(ctx, ground, x, y, z);
      else if (y === floor) v = along % 3 === 2 ? P.AIR : shade(x, y, z, 4) < 64 ? P.DUCKBOARD_WORN : P.DUCKBOARD;
      else if (y < solidTop) v = y === solidTop - 1 ? P.TIMBER_DARK : ((y - floor) >> 1) % 2 === 0 ? P.TIMBER : P.TIMBER_WEATHERED;
      else v = P.AIR;
    } else if (revetTop >= 0 && y >= revetFrom && y < revetTop) {
      v = revetment(ctx, bay, x, y, z, revetFrom);
    } else if (y < surface) {
      v = y === surface - 1 && flags & (FLAG.CRATER | FLAG.DITCH) ? (y <= p.waterTable + 1 ? P.MUD_WET : P.MUD_DARK) : strata(ctx, ground, x, y, z);
    } else if (y < spoilTop) {
      v = shade(x, y, z, 5) < 70 ? P.SPOIL_DRY : P.SPOIL;
    } else if (y === surface && flags & FLAG.DITCH && spoilTop < 0) {
      v = P.WATER;
    } else {
      v = P.AIR;
    }
    if (v === P.AIR && y <= p.waterTable && (SOLID[prev] || WATERY[prev])) v = P.WATER;
    if (LOOSE[v] && nTop <= y - 1) v = P.MUD_DARK;
    out[y - y0] = v;
    prev = v;
  }
}

/** One band as a 32-wide brick map, in band-local x. */
export function bandMap(plan: WorldPlan, band: number): BrickMap {
  const p = plan.params;
  const x0 = band * BAND;
  const m = columnModel(plan, x0, x0 + BAND);
  const map = new BrickMap({ x: BAND, y: p.dims.y, z: p.dims.z });
  const ctx = context(plan);
  const deep = ctx.clay + 1;
  const columns = new Uint8Array(64 * p.dims.y);
  const raw = new Uint8Array(512);
  const bricksY = p.dims.y / 8;

  for (let bz = 0; bz < p.dims.z / 8; bz++) {
    for (let bx = 0; bx < BAND / 8; bx++) {
      // The y range where these 64 columns differ from plain subsoil below and air above.
      let lo = p.dims.y;
      let hi = 0;
      for (let lz = 0; lz < 8; lz++) {
        for (let lx = 0; lx < 8; lx++) {
          const c = (x0 + bx * 8 + lx - m.x0) * m.nz + bz * 8 + lz;
          const floor = m.floor[c] >= 0 ? m.floor[c] - 1 : p.dims.y;
          lo = Math.min(lo, m.ground[c] - deep, m.surface[c] - 2, floor);
          hi = Math.max(hi, m.top[c] + 1, p.waterTable + 2, m.surface[c] + 2);
        }
      }
      const by0 = Math.max(0, Math.floor(lo / 8));
      const by1 = Math.min(bricksY, Math.ceil(hi / 8));
      for (let by = 0; by < by0; by++) map.setUniform(map.brickIndex(bx, by, bz), P.SUBSOIL);
      if (by1 <= by0) continue;
      const y0 = by0 * 8;
      const y1 = by1 * 8;
      for (let lz = 0; lz < 8; lz++) {
        for (let lx = 0; lx < 8; lx++) {
          const x = x0 + bx * 8 + lx;
          const z = bz * 8 + lz;
          const c = (x - m.x0) * m.nz + z;
          writeColumn(ctx, m, c, x, z, y0, y1, P.SUBSOIL, columns.subarray((lz * 8 + lx) * p.dims.y));
        }
      }
      for (let by = by0; by < by1; by++) {
        for (let ly = 0; ly < 8; ly++) {
          for (let lz = 0; lz < 8; lz++) {
            for (let lx = 0; lx < 8; lx++) raw[lx + ly * 8 + lz * 64] = columns[(lz * 8 + lx) * p.dims.y + (by - by0) * 8 + ly];
          }
        }
        map.writeBrick(map.brickIndex(bx, by, bz), raw);
      }
    }
  }
  map.takeDirty();
  return map;
}

/** One band as transferable bricks: the table, and the dense bricks' bytes in table order. */
export function fillBand(plan: WorldPlan, band: number): BandResult {
  const map = bandMap(plan, band);
  const dense: number[] = [];
  for (let bi = 0; bi < map.table.length; bi++) {
    const e = map.table[bi];
    if (e !== 0 && !(e & UNIFORM)) dense.push(bi);
  }
  const bytes = new Uint8Array(dense.length * 512);
  dense.forEach((bi, i) => bytes.set(map.denseView(bi)!, i * 512));
  return { band, table: map.table.slice(), dense: bytes, denseBricks: Uint32Array.from(dense) };
}

/** The voxel the fill lays at world (x, y, z): for tests and spot checks. */
export function columnMaterial(m: ColumnModel, plan: WorldPlan, x: number, y: number, z: number): number {
  const out = new Uint8Array(y + 1);
  writeColumn(context(plan), m, (x - m.x0) * m.nz + z, x, z, 0, y + 1, P.SUBSOIL, out);
  return out[y];
}
