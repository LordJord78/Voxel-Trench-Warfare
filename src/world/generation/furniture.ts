/**
 * Trench furniture: what a 10 cm grid can finally show. Sandbag courses on
 * the crests, laid in stretcher bond with darker seams, and dugouts with a
 * stair down, a gas curtain at the inner end and a lantern on the back wall.
 */

import { hash32x4 } from '../../core/hash';
import { P } from '../materials';
import { firmRing, type Clip, type VoxelSink } from '../sink';
import { vx, type GenParams } from './params';
import type { BayPlan, DugoutPlan } from './trenches';

const BAG_LONG = 6;
const BAG_WIDE = 3;
const BAG_HIGH = 2;
const COVER = 0.28;

/**
 * Runs of sandbags along a fire bay's crest, replacing the parapet's top two
 * courses of spoil so the crest — and the sightline it guarantees — stays put.
 * A bag only replaces spoil the fill already laid at rest, so it rests too.
 */
export function stampSandbags(sink: VoxelSink, clip: Clip, bay: BayPlan, p: GenParams): void {
  if (!bay.firingSteps) return;
  const face = bay.facing > 0 ? bay.b1 : bay.b0 - 1;
  const across = Array.from({ length: BAG_WIDE }, (_, k) => face + bay.facing * (k + 1));
  const aEnd = bay.a1 + p.trench.leg;
  for (let course = 0; course < BAG_HIGH; course++) {
    const y = bay.crestY - BAG_HIGH + course;
    const offset = course === 1 ? BAG_LONG / 2 : 0;
    for (let a = bay.a0 - offset; a < aEnd; a += BAG_LONG) {
      const slot = Math.floor((a - bay.a0 + BAG_LONG) / BAG_LONG) * 2 + course;
      if (hash32x4(bay.seed, slot, 17, 0) / 4294967296 >= COVER) continue;
      for (let i = 0; i < BAG_LONG; i++) {
        const along = a + i;
        if (along < bay.a0 || along >= aEnd) continue;
        across.forEach((b, j) => {
          const [x, z] = bay.longAxis === 0 ? [along, b] : [b, along];
          if (x < clip.x0 || x >= clip.x1) return;
          const here = sink.get(x, y, z);
          if (here !== P.SPOIL && here !== P.SPOIL_DRY) return;
          const seam = i === 0 || i === BAG_LONG - 1 || j === 0 || j === BAG_WIDE - 1;
          const worn = (hash32x4(x, y, z, 23) & 255) < 70;
          sink.set(x, y, z, seam ? P.SANDBAG_SEAM : worn ? P.SANDBAG_WORN : P.SANDBAG);
        });
      }
    }
  }
}

function box(sink: VoxelSink, clip: Clip, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, v: number): void {
  for (let x = Math.max(x0, clip.x0); x < Math.min(x1, clip.x1); x++) {
    for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) sink.set(x, y, z, v);
  }
}

/**
 * Python's `_carve_dugout` at 10 cm: a chamber dug off the sheltered side,
 * duckboard floor, timber and corrugated roof, a passage stepping down from
 * the trench under a timber lintel (so the earth above it rests on something),
 * a gas curtain across its inner end, and a lantern on the back wall.
 */
export function stampDugout(sink: VoxelSink, clip: Clip, d: DugoutPlan, p: GenParams): void {
  const [cx0, airY0, cz0] = d.lo;
  const [cx1, airY1, cz1] = d.hi;
  const e = d.passage;
  const headroom = d.floorY + vx(2.0, p.voxel);
  const rise = p.trench.treadRise;
  const depth = p.trench.treadDepth;

  box(sink, clip, cx0, cx1, airY0, airY1, cz0, cz1, P.AIR);
  firmRing(sink, clip, cx0, cx1, cz0, cz1, d.dugFloor, airY1 + 2);
  box(sink, clip, cx0, cx1, d.dugFloor, d.dugFloor + 1, cz0, cz1, P.DUCKBOARD);
  box(sink, clip, cx0, cx1, airY1, airY1 + 1, cz0, cz1, P.TIMBER);
  box(sink, clip, cx0, cx1, airY1 + 1, airY1 + 2, cz0, cz1, P.CORRUGATE);

  box(sink, clip, e.x0, e.x1, airY0, headroom, e.z0, e.z1, P.AIR);
  firmRing(sink, clip, e.x0, e.x1, e.z0, e.z1, d.dugFloor, headroom + 1);
  box(sink, clip, e.x0, e.x1, d.dugFloor, d.dugFloor + 1, e.z0, e.z1, P.DUCKBOARD);
  box(sink, clip, e.x0, e.x1, headroom, headroom + 1, e.z0, e.z1, P.TIMBER);

  // Steps down from the trench: distance t counts passage cells from the trench wall.
  const along = d.longAxis === 0 ? e.z1 - e.z0 : e.x1 - e.x0;
  const cell = (t: number): [number, number, number, number] => {
    if (d.longAxis === 0) {
      const z = d.away < 0 ? e.z1 - 1 - t : e.z0 + t;
      return [e.x0, e.x1, z, z + 1];
    }
    const x = e.x1 - 1 - t;
    return [x, x + 1, e.z0, e.z1];
  };
  const drop = d.floorY - d.dugFloor;
  const steps = Math.ceil(drop / rise);
  for (let k = 1; k < steps; k++) {
    const top = d.floorY + 1 - k * rise;
    for (let t = (k - 1) * depth; t < Math.min(k * depth, along); t++) {
      const [x0, x1, z0, z1] = cell(t);
      box(sink, clip, x0, x1, d.dugFloor + 1, top, z0, z1, P.TIMBER);
    }
  }

  // The gas curtain hangs across the passage's chamber end, from the floor up to
  // the chamber roof or the passage lintel, whichever is lower: cloth holds
  // nothing up, so it must never replace the timber the earth rests on.
  const [gx0, gx1, gz0, gz1] = cell(along - 1);
  box(sink, clip, gx0, gx1, d.dugFloor + 1, Math.min(airY1, headroom), gz0, gz1, P.CLOTH);

  // A lantern on the back wall at 1.6 m, centred.
  const [lx, ly, lz] = lanternVoxel(d, p);
  if (lx >= clip.x0 && lx < clip.x1) sink.set(lx, ly, lz, P.LANTERN_GLOW);
}

/** The voxel of a dugout's lantern glass: on the back wall, centred, 1.6 m up. */
export function lanternVoxel(d: DugoutPlan, p: GenParams): [number, number, number] {
  const [cx0, , cz0] = d.lo;
  const [cx1, , cz1] = d.hi;
  const y = d.dugFloor + 1 + vx(1.6, p.voxel);
  if (d.longAxis === 0) return [(cx0 + cx1) >> 1, y, d.away < 0 ? cz0 : cz1 - 1];
  return [cx0, y, (cz0 + cz1) >> 1];
}

/** The way a dugout's lantern faces: off the back wall it hangs on, into the chamber. */
export function lanternFacing(d: DugoutPlan): [number, number, number] {
  if (d.longAxis === 0) return [0, 0, d.away < 0 ? 1 : -1];
  return [1, 0, 0];
}
