/**
 * The range (the shots spec's §5): solo play's dummies and steel plates out in front of the spawn
 * bay, as rules over the world. The app writes the plates in and poses the dummies (app/range.ts).
 *
 * - **Where things stand** (rangeLayout): each at its [range] distance out from the spawn along the
 *   bay's facing, at its own place across the bay's frontage. The movers walk across its middle.
 *   The rest stand left and right of it in turn, nearest first: the nearest frontage_m − shift_m
 *   out (so a shift keeps it within the frontage), each farther one nearer the middle.
 * - **A blocked spot** moves sideways from there, half a metre at a time and right first, as one
 *   faces out (0, +0.5, −0.5, +1 … ±shift_m). If every try is blocked, it is left out. A spot is
 *   blocked where (rangeGround, then the layout's own rules):
 *   - the map has no ground there: off its edge, or an empty column;
 *   - its top voxel is water, or is not ground at all: a tree, timber, a trench's duckboards or
 *     bench, a ruin's brick, wire;
 *   - anything but the ground stands within 2 m over it, half a metre either way: wire, a picket,
 *     a post, a bush, a trunk;
 *   - the ground is steeper than max_slope_deg over half a metre either way, along x or z;
 *   - the ground is sunk more than bowl_m under the mean of 8 points on a 3 m ring (a crater's
 *     bowl), or more than 1 m (a trench's floor), or the ring runs off the map;
 *   - given the world's plan, it is in a bay's or a leg's footprint. Without the plan the ground
 *     alone tells a trench: its duckboards and bench are not ground, its revetment stands over its
 *     floor, its walls are cliffs, and its floor is sunk under the field;
 *   - (a standing one) it would stand in line behind a nearer one, as seen from the spawn, their
 *     footprints overlapping;
 *   - (a mover) any column its walk crosses is not ground or is in a trench's footprint, or
 *     anything but the ground stands within 2 m over its walk;
 *   - (given the eye: a player's, standing on the spawn bay's firing step) the eye does not see it.
 *     A dummy is sighted at its chest (dummy_chest_m over its feet), a mover at both ends of its walk
 *     and at its middle, a plate at its centre; the line from the eye meets something that hides it
 *     (a parapet, a trunk, rising ground, a tree's leaves, though they stop no round), or a plate
 *     laid nearer, which will stand in the world.
 * - **The dummies** (Range): 100 HP, a match's damage (gunDamage(DAMAGE[zone], gun)), and health back
 *   as a match's comes back (net/match-rules.ts). At 0 HP one lies down_s, taking nothing, then
 *   stands where it lies at full health. A mover walks mover_span_m back and forth across at
 *   mover_speed_mps from its spot (a triangle wave), on the ground along its walk, facing its way.
 *   It lies where it fell, and walks on from there.
 *
 * Pure: the clock is the caller's, in seconds, and never goes back.
 */

import { atan2, radians, tan } from '../core/dmath';
import type { Tunables } from '../core/tunables';
import { gunDamage } from '../net/gear';
import { DAMAGE, HP, REGEN_DELAY_MS, REGEN_PER_S } from '../net/match-rules';
import type { BrickMap } from '../world/bricks';
import { vx } from '../world/generation/params';
import { bayIndex, type WorldPlan } from '../world/generation/plan';
import { blocksSight, isGranular, K, kindOf, P } from '../world/materials';
import { groundTop, raycast } from '../world/raycast';
import type { Zone } from './soldier-rig';

/** The [range] table. */
export interface RangeTunables {
  dummiesM: number[];
  moversM: number[];
  moverSpeedMps: number;
  moverSpanM: number;
  torsoPlatesM: number[];
  headPlatesM: number[];
  /** Across and high. */
  torsoPlateM: [number, number];
  headPlateM: [number, number];
  /** The plates' centres over the ground: torso, head. */
  plateCentreM: [number, number];
  frontageM: number;
  shiftM: number;
  maxSlopeDeg: number;
  bowlM: number;
  downS: number;
  readoutS: number;
  /** A dummy's chest over its feet: the point of it the range is sighted at. */
  dummyChestM: number;
}

function numbers(tun: Tunables, key: string): number[] {
  const value = tun.get(key);
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)) {
    throw new TypeError(`tunable '${key}' is not a list of positive numbers: ${JSON.stringify(value)}`);
  }
  return [...value];
}

function two(tun: Tunables, key: string): [number, number] {
  const list = numbers(tun, key);
  if (list.length !== 2) throw new TypeError(`tunable '${key}' is not two numbers: ${JSON.stringify(list)}`);
  return [list[0], list[1]];
}

export function rangeTunables(tun: Tunables): RangeTunables {
  const f = (k: string) => tun.f(`range.${k}`);
  return {
    dummiesM: numbers(tun, 'range.dummies_m'),
    moversM: numbers(tun, 'range.movers_m'),
    moverSpeedMps: f('mover_speed_mps'),
    moverSpanM: f('mover_span_m'),
    torsoPlatesM: numbers(tun, 'range.torso_plates_m'),
    headPlatesM: numbers(tun, 'range.head_plates_m'),
    torsoPlateM: two(tun, 'range.torso_plate_m'),
    headPlateM: two(tun, 'range.head_plate_m'),
    plateCentreM: two(tun, 'range.plate_centre_m'),
    frontageM: f('frontage_m'),
    shiftM: f('shift_m'),
    maxSlopeDeg: f('max_slope_deg'),
    bowlM: f('bowl_m'),
    downS: f('down_s'),
    readoutS: f('readout_s'),
    dummyChestM: f('dummy_chest_m'),
  };
}

/** The spawn bay, as far as the range needs it: the axis its trench runs along, and the way it faces. */
export interface RangeBay {
  longAxis: 0 | 2;
  facing: 1 | -1;
}

export interface RangeSpot {
  kind: 'dummy' | 'mover' | 'torso' | 'head';
  /** Metres: its voxel column's middle, at the ground's top there. A mover's is the middle of its walk. */
  at: [number, number, number];
  /** How far out along the bay's facing from the spawn it was laid: its [range] distance. */
  distanceM: number;
  /**
   * A mover's: the ground's top (metres) along its walk, at even steps from its left end to its right
   * end as one faces out from the bay. Without one, a mover walks at its spot's height.
   */
  walk?: number[];
}

/** The first dummy's body id: never a match's seat (0–7) or the player's own (−1). */
export const FIRST_DUMMY = 200;
/** A blocked spot's tries step sideways by this. */
const SHIFT_STEP_M = 0.5;
/**
 * A spot's footprint, either way: the slope is taken across it and it is kept clear; in line with
 * another, the two hide each other within their footprints.
 */
const FOOT_M = 0.5;
/** Nothing but the ground may stand this high over a spot's ground in its footprint: the rule's wire, and anything else. */
const CLEAR_M = 2.0;
/** The ring the ground about a spot is measured on, 8 points round it. */
const RING_M = 3.0;
const RING: readonly (readonly [number, number])[] = [
  [1, 0], [Math.SQRT1_2, Math.SQRT1_2], [0, 1], [-Math.SQRT1_2, Math.SQRT1_2],
  [-1, 0], [-Math.SQRT1_2, -Math.SQRT1_2], [0, -1], [Math.SQRT1_2, -Math.SQRT1_2],
];
/** Ground sunk this far under its ring's mean is a trench's floor (bowl_m, less, already says a crater). */
const TRENCH_M = 1.0;
/** A sinking is reckoned in voxels, to within this: a bowl bowl_m deep is not more than bowl_m deep (6 × 0.1 is over 0.6). */
const SUNK_EPS = 1e-6;
/** A mover's walk keeps its ground's height, and is kept clear, every this far along it. */
const WALK_STEP_M = 0.5;

interface Frame {
  /** Out along the bay's facing, and to the right as one faces out: (x, z). */
  out: [number, number];
  right: [number, number];
  /** The yaw one faces out at (degrees; soldier-rig's: 0 faces +z, and the right hand is then +x). */
  yaw: number;
}

function frame(bay: RangeBay): Frame {
  return bay.longAxis === 0
    ? { out: [0, bay.facing], right: [bay.facing, 0], yaw: bay.facing > 0 ? 0 : 180 }
    : { out: [bay.facing, 0], right: [0, -bay.facing], yaw: bay.facing > 0 ? 90 : -90 };
}

/** Degrees, into (−180, 180]. */
function wrap(deg: number): number {
  const d = deg % 360;
  return d > 180 ? d - 360 : d <= -180 ? d + 360 : d;
}

/**
 * The top of the ground in column (x, z), in voxels (the first one over it), if its top voxel is
 * ground: soil, spoil, sandbags or rubble. Null off the map, for an empty column, and under water,
 * a tree, timber, duckboards, a ruin or wire.
 */
function groundAt(map: BrickMap, x: number, z: number): number | null {
  const top = groundTop(map, x + 0.5, z + 0.5);
  if (top === null) return null;
  const p = map.get(x, top - 1, z);
  // Water is not granular either; it is named for the rule's sake.
  return kindOf(p) === K.WATER || !isGranular(p) ? null : top;
}

/**
 * Whether nothing but the ground stands within CLEAR_M over `top`, FOOT_M either way of column
 * (x, z): no wire, picket, post, bush or trunk. The ground rising there is the ground.
 */
function clear(map: BrickMap, voxel: number, x: number, z: number, top: number): boolean {
  const foot = Math.round(FOOT_M / voxel);
  const high = Math.round(CLEAR_M / voxel);
  for (let dx = -foot; dx <= foot; dx++) {
    for (let dz = -foot; dz <= foot; dz++) {
      for (let y = top; y < top + high; y++) {
        const p = map.get(x + dx, y, z + dz);
        if (p !== P.AIR && !isGranular(p)) return false;
      }
    }
  }
  return true;
}

/** Whether the ground's top `top` in column (x, z) is no steeper than max_slope_deg over FOOT_M either way, along x and z. */
function level(map: BrickMap, voxel: number, x: number, z: number, top: number, t: RangeTunables): boolean {
  const run = Math.round(FOOT_M / voxel);
  const rise = run * tan(radians(t.maxSlopeDeg));
  const around: readonly (readonly [number, number])[] = [[run, 0], [-run, 0], [0, run], [0, -run]];
  for (const [dx, dz] of around) {
    const h = groundTop(map, x + dx + 0.5, z + dz + 0.5);
    if (h === null || Math.abs(h - top) > rise) return false;
  }
  return true;
}

/**
 * Whether the ground's top `top` in column (x, z) is sunk under the mean of its ring by more than
 * bowl_m (a crater's bowl) or TRENCH_M (a trench's floor); or the ring runs off the map.
 */
function sunk(map: BrickMap, voxel: number, x: number, z: number, top: number, t: RangeTunables): boolean {
  const r = RING_M / voxel;
  let sum = 0;
  for (const [cx, cz] of RING) {
    const h = groundTop(map, x + 0.5 + cx * r, z + 0.5 + cz * r);
    if (h === null) return true;
    sum += h;
  }
  return sum / RING.length - top > Math.min(t.bowlM, TRENCH_M) / voxel + SUNK_EPS;
}

/**
 * The ground a range spot may stand on in column (x, z): its top in voxels (the first one over it),
 * or null where a spot there is blocked. Blocked: no ground, or water or anything but ground on
 * top; anything but the ground within 2 m over it, half a metre either way; steeper than
 * max_slope_deg over half a metre; or sunk in a crater's bowl or a trench's floor. It needs no
 * plan to tell a trench (the module's header says how).
 */
export function rangeGround(map: BrickMap, voxel: number, x: number, z: number, t: RangeTunables): number | null {
  const top = groundAt(map, x, z);
  if (top === null || !level(map, voxel, x, z, top, t) || sunk(map, voxel, x, z, top, t) || !clear(map, voxel, x, z, top)) return null;
  return top;
}

/** Whether a column is in a trench's footprint, from the world's plan. */
type Dug = (x: number, z: number) => boolean;

/**
 * A mover's walk centred on `at`, `span` across: the ground's top (metres) every WALK_STEP_M from its
 * left end to its right end, as one faces out. Null if any column it crosses is not ground or is
 * dug, or if anything but the ground stands within 2 m over it.
 */
function walkOf(map: BrickMap, voxel: number, at: readonly [number, number, number], right: readonly [number, number], span: number, dug: Dug | null): number[] | null {
  const column = (o: number): [number, number] => [Math.floor((at[0] + right[0] * o) / voxel), Math.floor((at[2] + right[1] * o) / voxel)];
  // Every column it crosses: a puddle, a stump or a trench narrower than a step is still in its way.
  const n = Math.max(1, Math.round(span / voxel));
  for (let i = 0; i <= n; i++) {
    const [x, z] = column(-span / 2 + (span * i) / n);
    if (groundAt(map, x, z) === null || dug?.(x, z)) return null;
  }
  // Every step's footprint overlaps the next: all along, nothing stands over it.
  const steps = Math.max(1, Math.ceil(span / WALK_STEP_M));
  const heights: number[] = [];
  for (let k = 0; k <= steps; k++) {
    const [x, z] = column(-span / 2 + (span * k) / steps);
    const top = groundAt(map, x, z);
    if (top === null || !clear(map, voxel, x, z, top)) return null;
    heights.push(top * voxel);
  }
  return heights;
}

type V3 = readonly [number, number, number];

/** The middle of the box `cells` fill (voxels), in metres. */
function middleOf(cells: readonly (readonly number[])[], voxel: number): [number, number, number] {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const c of cells) {
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], c[a]);
      hi[a] = Math.max(hi[a], c[a] + 1);
    }
  }
  return [((lo[0] + hi[0]) / 2) * voxel, ((lo[1] + hi[1]) / 2) * voxel, ((lo[2] + hi[2]) / 2) * voxel];
}

/**
 * Where a spot is sighted from the step (metres): a dummy's chest, dummy_chest_m over its feet; a
 * mover's at both ends of its walk and at its middle; a plate's centre, its steel's middle (`plate`,
 * its voxels).
 */
function sightPoints(spot: RangeSpot, plate: readonly (readonly number[])[] | null, right: readonly [number, number], voxel: number, t: RangeTunables): V3[] {
  const chest = t.dummyChestM;
  if (plate) return [middleOf(plate.filter((q) => q[3] === P.TARGET_STEEL), voxel)];
  if (spot.kind !== 'mover') return [[spot.at[0], spot.at[1] + chest, spot.at[2]]];
  const half = t.moverSpanM / 2;
  const walk = spot.walk ?? [spot.at[1]];
  return [
    [spot.at[0] - right[0] * half, walk[0] + chest, spot.at[2] - right[1] * half],
    [spot.at[0], spot.at[1] + chest, spot.at[2]],
    [spot.at[0] + right[0] * half, walk[walk.length - 1] + chest, spot.at[2] + right[1] * half],
  ];
}

/** Whether the segment from `o` to `o + d` (voxels) passes through the cube of cell `c`. */
function crosses(o: V3, d: V3, c: V3): boolean {
  let enter = 0;
  let exit = 1;
  for (let k = 0; k < 3; k++) {
    if (d[k] === 0) {
      if (o[k] < c[k] || o[k] >= c[k] + 1) return false;
      continue;
    }
    const a = (c[k] - o[k]) / d[k];
    const b = (c[k] + 1 - o[k]) / d[k];
    enter = Math.max(enter, Math.min(a, b));
    exit = Math.min(exit, Math.max(a, b));
    if (enter > exit) return false;
  }
  return true;
}

/**
 * What hides a target from the eye (raycast's stops): anything that blocks sight. Everything solid
 * does, and so do a tree's leaves, which stop no round.
 */
const HIDES = Uint8Array.from({ length: 256 }, (_, p) => (p !== P.AIR && blocksSight(p) ? 1 : 0));

/**
 * Whether `point` is in sight from `eye` (metres): the line between them meets nothing in the map
 * that hides it (world/raycast's walk), solid or leaves, nor any cell of `screens`: the plates laid
 * in front of it, which stand in the world once the range is up.
 */
function inSight(map: BrickMap, voxel: number, eye: V3, point: V3, screens: readonly V3[]): boolean {
  const o: V3 = [eye[0] / voxel, eye[1] / voxel, eye[2] / voxel];
  const d: V3 = [point[0] / voxel - o[0], point[1] / voxel - o[1], point[2] / voxel - o[2]];
  const length = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
  if (length === 0) return true;
  if (raycast(map, o, [d[0] / length, d[1] / length, d[2] / length], length, undefined, HIDES) !== null) return false;
  for (const c of screens) if (crosses(o, d, c)) return false;
  return true;
}

/** A spot as the spawn sees it: its bearing (radians, right of out) and how wide its footprint looks. */
interface Sighted {
  bearing: number;
  half: number;
}

function sighted(spawn: readonly [number, number, number], f: Frame, at: readonly [number, number, number]): Sighted {
  const dx = at[0] - spawn[0];
  const dz = at[2] - spawn[2];
  const out = dx * f.out[0] + dz * f.out[1];
  const right = dx * f.right[0] + dz * f.right[1];
  return { bearing: atan2(right, out), half: atan2(FOOT_M, Math.sqrt(out * out + right * right)) };
}

/**
 * Spots out along the bay's facing from `spawn`, on dry, level ground; a blocked one moved sideways
 * (0, +0.5, −0.5, +1 … ±shift_m); none if every try is blocked. Listed as [range] lists them: the
 * dummies, the movers, the torso plates, then the head plates, each in its list's order. Given the
 * world's plan, a spot in a bay's or a leg's footprint is blocked whatever its ground looks like.
 * Given the eye it is sighted from (metres: a player's standing on the spawn bay's firing step), a
 * spot is laid only where the eye sees it (sightPoints, inSight): the line from the eye meets nothing
 * that hides it, solid or leaves, nor a plate laid nearer; one it does not see is blocked, and moves
 * on as one is.
 */
export function rangeLayout(
  map: BrickMap,
  voxel: number,
  spawn: { position: readonly [number, number, number]; bay: RangeBay },
  t: RangeTunables,
  plan?: WorldPlan | null,
  eye?: V3 | null,
): RangeSpot[] {
  const f = frame(spawn.bay);
  const trenches = plan ? bayIndex(plan) : null;
  const dug: Dug | null = trenches ? (x, z) => trenches.at(x, z) !== null : null;
  /** The plates laid so far, nearest first: each hides what stands behind it from the eye. */
  const screens: V3[] = [];
  const kinds: [RangeSpot['kind'], number[]][] = [['dummy', t.dummiesM], ['mover', t.moversM], ['torso', t.torsoPlatesM], ['head', t.headPlatesM]];
  const listed: { kind: RangeSpot['kind']; d: number; order: number }[] = kinds.flatMap(([kind, ds]) => ds.map((d) => ({ kind, d }))).map((w, order) => ({ ...w, order }));
  // Nearest first: each has its place before a farther one, which moves aside for it.
  const nearest = [...listed].sort((a, b) => a.d - b.d || a.order - b.order);
  const standing = nearest.filter((w) => w.kind !== 'mover');
  const reach = Math.max(0, t.frontageM - t.shiftM);
  const tries = [0];
  for (let k = 1; k * SHIFT_STEP_M <= t.shiftM + 1e-9; k++) tries.push(k * SHIFT_STEP_M, -k * SHIFT_STEP_M);
  const laid: { spot: RangeSpot; order: number; seen: Sighted | null }[] = [];
  for (const w of nearest) {
    const mover = w.kind === 'mover';
    const k = standing.indexOf(w);
    const home = mover ? 0 : (k % 2 === 0 ? -1 : 1) * reach * (1 - k / standing.length);
    for (const shift of tries) {
      const across = home + shift;
      if (Math.abs(across) + (mover ? t.moverSpanM / 2 : 0) > t.frontageM + 1e-9) continue;
      const x = Math.floor((spawn.position[0] + f.out[0] * w.d + f.right[0] * across) / voxel);
      const z = Math.floor((spawn.position[2] + f.out[1] * w.d + f.right[1] * across) / voxel);
      const top = dug?.(x, z) ? null : rangeGround(map, voxel, x, z, t);
      if (top === null) continue;
      const spot: RangeSpot = { kind: w.kind, at: [(x + 0.5) * voxel, top * voxel, (z + 0.5) * voxel], distanceM: w.d };
      let seen: Sighted | null = null;
      if (mover) {
        const walk = walkOf(map, voxel, spot.at, f.right, t.moverSpanM, dug);
        if (!walk) continue;
        spot.walk = walk;
      } else {
        const s = sighted(spawn.position, f, spot.at);
        if (laid.some((o) => o.seen && Math.abs(o.seen.bearing - s.bearing) < o.seen.half + s.half)) continue;
        seen = s;
      }
      if (eye) {
        const plate = w.kind === 'torso' || w.kind === 'head' ? plateVoxels(spot, voxel, t, spawn.bay) : null;
        if (!sightPoints(spot, plate, f.right, voxel, t).every((p) => inSight(map, voxel, eye, p, screens))) continue;
        if (plate) for (const [x, y, z] of plate) screens.push([x, y, z]);
      }
      laid.push({ spot, order: w.order, seen });
      break;
    }
  }
  return laid.sort((a, b) => a.order - b.order).map((l) => l.spot);
}

/**
 * The voxels a plate and its post are: [x, y, z, palette] in voxels. The plate is TARGET_STEEL, one
 * voxel thick and square to the bay's facing, across the bay's long axis, centred on its spot's
 * column and at its centre's height (the middle row from it, if its rows are odd); under it a post
 * of TIMBER from the ground. None for a dummy.
 */
export function plateVoxels(spot: RangeSpot, voxel: number, t: RangeTunables, facing: RangeBay): [number, number, number, number][] {
  if (spot.kind !== 'torso' && spot.kind !== 'head') return [];
  const torso = spot.kind === 'torso';
  const [acrossM, highM] = torso ? t.torsoPlateM : t.headPlateM;
  const across = Math.max(1, vx(acrossM, voxel));
  const high = Math.max(1, vx(highM, voxel));
  const x = Math.floor(spot.at[0] / voxel);
  const z = Math.floor(spot.at[2] / voxel);
  const ground = Math.round(spot.at[1] / voxel);
  const bottom = ground + Math.round((torso ? t.plateCentreM[0] : t.plateCentreM[1]) / voxel) - (high >> 1);
  const out: [number, number, number, number][] = [];
  for (let y = ground; y < bottom; y++) out.push([x, y, z, P.TIMBER]);
  const first = -(across >> 1);
  for (let j = 0; j < high; j++) {
    for (let i = first; i < first + across; i++) {
      out.push(facing.longAxis === 0 ? [x + i, bottom + j, z, P.TARGET_STEEL] : [x, bottom + j, z + i, P.TARGET_STEEL]);
    }
  }
  return out;
}

export type RangeEvent =
  | { kind: 'hit'; id: number; zone: Zone; damage: number; distanceM: number }
  | { kind: 'kill'; id: number; zone: Zone; damage: number; distanceM: number; shots: number }
  | { kind: 'plate'; index: number; distanceM: number };

/** A dummy as a figure: its body id, where it stands (foot centre, metres), how fast and which way it walks, the way it faces (degrees), and seconds down (null standing). */
export interface RangeFigure {
  id: number;
  position: [number, number, number];
  velocity: [number, number, number];
  yaw: number;
  deadFor: number | null;
}

interface Dummy {
  id: number;
  spot: RangeSpot;
  /** A mover's: +1 if it sets off to the right of its spot, −1 to the left; 0 standing still. */
  sets: number;
  /** Its health at its last hit, and when (s): it comes back from REGEN_DELAY_MS after. */
  hp: number;
  hitAt: number;
  /** The shots that have struck it since it was last at full health. */
  shots: number[];
  /** When it went down, or null standing. */
  downAt: number | null;
  /** Seconds it has lain down, all told: a mover's walk stops for them. */
  lainS: number;
}

export class Range {
  private readonly frame: Frame;
  private readonly dummies: Dummy[];

  constructor(
    spots: readonly RangeSpot[],
    private readonly t: RangeTunables,
    bay: RangeBay,
  ) {
    this.frame = frame(bay);
    const standing = spots.filter((s) => s.kind === 'dummy');
    const movers = spots.filter((s) => s.kind === 'mover');
    // Two movers set off opposite ways.
    this.dummies = [...standing, ...movers].map((spot, i) => ({
      id: FIRST_DUMMY + i,
      spot,
      sets: i < standing.length ? 0 : (i - standing.length) % 2 === 0 ? 1 : -1,
      hp: HP,
      hitAt: 0,
      shots: [],
      downAt: null,
      lainS: 0,
    }));
  }

  /** The dummies (static first, then movers) as figures at `nowS`: id 200 + i, where, how fast, facing, seconds down (null standing). */
  figures(nowS: number): RangeFigure[] {
    this.step(nowS);
    const face = wrap(this.frame.yaw + 180);
    return this.dummies.map((d) => {
      const deadFor = d.downAt === null ? null : nowS - d.downAt;
      if (d.sets === 0) return { id: d.id, position: [d.spot.at[0], d.spot.at[1], d.spot.at[2]], velocity: [0, 0, 0], yaw: face, deadFor };
      const walk = this.walking(d, nowS);
      return { id: d.id, position: walk.position, velocity: d.downAt === null ? walk.velocity : [0, 0, 0], yaw: walk.yaw, deadFor };
    });
  }

  /** Dummy `id`'s health at `nowS`: 0 down, and 0 for no dummy. */
  health(id: number, nowS: number): number {
    this.step(nowS);
    const d = this.dummy(id);
    return d ? this.hpOf(d, nowS) : 0;
  }

  /** A round of the player's into dummy `id`; `shot` counts the trigger's shots, so a shotgun's pellets are one shot. */
  hit(id: number, zone: Zone, gun: number | undefined, distanceM: number, shot: number, nowS: number): RangeEvent | null {
    this.step(nowS);
    const d = this.dummy(id);
    if (!d || d.downAt !== null) return null;
    const hp = this.hpOf(d, nowS);
    if (hp >= HP) d.shots = [];
    if (!d.shots.includes(shot)) d.shots.push(shot);
    const damage = gunDamage(DAMAGE[zone], gun);
    d.hp = hp - damage;
    d.hitAt = nowS;
    if (d.hp > 0) return { kind: 'hit', id, zone, damage, distanceM };
    d.hp = 0;
    d.downAt = nowS;
    return { kind: 'kill', id, zone, damage, distanceM, shots: d.shots.length };
  }

  /** A round of the player's into plate `index` (of the spots' plates, as the caller numbers them). */
  plate(index: number, distanceM: number): RangeEvent {
    return { kind: 'plate', index, distanceM };
  }

  /** Brings the dummies to `nowS`: those down down_s stand again where they lie, at full health. */
  step(nowS: number): void {
    for (const d of this.dummies) {
      if (d.downAt === null || nowS < d.downAt + this.t.downS) continue;
      d.lainS += this.t.downS;
      d.downAt = null;
      d.hp = HP;
      d.hitAt = nowS;
      d.shots = [];
    }
  }

  private dummy(id: number): Dummy | undefined {
    return Number.isInteger(id) ? this.dummies[id - FIRST_DUMMY] : undefined;
  }

  private hpOf(d: Dummy, nowS: number): number {
    if (d.downAt !== null) return 0;
    return Math.min(HP, d.hp + REGEN_PER_S * Math.max(0, nowS - d.hitAt - REGEN_DELAY_MS / 1000));
  }

  /** Where a mover is along its walk at `nowS` (where it fell, if down), how fast it goes, and the way it faces. */
  private walking(d: Dummy, nowS: number): { position: [number, number, number]; velocity: [number, number, number]; yaw: number } {
    const { moverSpanM: span, moverSpeedMps: speed } = this.t;
    const travelled = speed * ((d.downAt ?? nowS) - d.lainS);
    // A triangle wave from the middle: out to one end, back past the middle to the other, and on.
    const q = (((travelled + span / 2) % (2 * span)) + 2 * span) % (2 * span);
    const outward = q < span;
    const o = d.sets * (outward ? q - span / 2 : (3 * span) / 2 - q);
    const way = d.sets * (outward ? 1 : -1);
    const { right } = this.frame;
    let y = d.spot.at[1];
    let climb = 0;
    const walk = d.spot.walk;
    if (walk && walk.length > 1) {
      const step = span / (walk.length - 1);
      const u = (o + span / 2) / step;
      const i = Math.min(walk.length - 2, Math.max(0, Math.floor(u)));
      y = walk[i] + (walk[i + 1] - walk[i]) * (u - i);
      climb = ((walk[i + 1] - walk[i]) / step) * speed * way;
    }
    return {
      position: [d.spot.at[0] + right[0] * o, y, d.spot.at[2] + right[1] * o],
      // + 0: a still axis is 0, not −0.
      velocity: [right[0] * speed * way + 0, climb + 0, right[1] * speed * way + 0],
      yaw: wrap(this.frame.yaw + (way > 0 ? 90 : -90)),
    };
  }
}
