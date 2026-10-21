/**
 * The landscape around the trenches, re-detailed at 10 cm.
 *
 * Python authored these as voxel counts on a 0.5 m grid: a tree was a stack of
 * cubes. Here they are planned once — position, size and a seed in the plan —
 * and drawn by any band that touches them, every random choice coming from the
 * prop's own seed or from a hash of coordinates, so a hull split across two
 * workers is the same hull. Props stand on `columnTopAt`, the real ground.
 *
 * Built settled: everything here is fixed timber, brick, steel or packed mud,
 * except rubble, which is only ever laid flat or in 45° heaps.
 */

import { hash32x4 } from '../../core/hash';
import { Rng } from '../../core/rng';
import { carveWith } from '../destruction';
import { P } from '../materials';
import { firmRing, type Clip, type VoxelSink } from '../sink';
import { columnTopAt } from './columns';
import type { DirectHit } from './craters';
import { vx } from './params';
import type { PropPlan, WorldPlan } from './plan';

const WIDE = 1e9;

function h8(x: number, y: number, z: number, salt: number): number {
  return hash32x4(x, y, z, salt) & 255;
}

function put(sink: VoxelSink, clip: Clip, x: number, y: number, z: number, v: number): void {
  if (x >= clip.x0 && x < clip.x1) sink.set(x, y, z, v);
}

function putAir(sink: VoxelSink, clip: Clip, x: number, y: number, z: number, v: number): void {
  if (x >= clip.x0 && x < clip.x1 && sink.get(x, y, z) === P.AIR) sink.set(x, y, z, v);
}

/** A straight run of voxels between two points, written only into air. */
function line(sink: VoxelSink, clip: Clip, a: [number, number, number], b: [number, number, number], v: number): void {
  const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), Math.abs(b[2] - a[2]), 1);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    putAir(sink, clip, Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t), v);
  }
}

/** A strand that sags one voxel at its middle. */
function strand(sink: VoxelSink, clip: Clip, a: [number, number, number], b: [number, number, number], v: number): void {
  const mid: [number, number, number] = [Math.round((a[0] + b[0]) / 2), Math.round((a[1] + b[1]) / 2) - 1, Math.round((a[2] + b[2]) / 2)];
  line(sink, clip, a, mid, v);
  line(sink, clip, mid, b, v);
}

function medianTop(plan: WorldPlan, x0: number, z0: number, w: number, d: number): number {
  const tops: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) tops.push(columnTopAt(plan, x0 + Math.floor((w * (2 * i + 1)) / 6), z0 + Math.floor((d * (2 * j + 1)) / 6)));
  tops.sort((a, b) => a - b);
  return tops[4];
}

/** Rubble laid flat: only where the column's neighbours stand at least as high, so it can never slump. */
function flatRubble(sink: VoxelSink, clip: Clip, plan: WorldPlan, x: number, z: number, v: number): void {
  const top = columnTopAt(plan, x, z);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) if (columnTopAt(plan, x + dx, z + dz) < top) return;
  putAir(sink, clip, x, top, z, v);
}

/** A rubble heap with 45° sides: each layer one voxel narrower all round. */
function heap(sink: VoxelSink, clip: Clip, cx: number, base: number, cz: number, radius: number, v: number, alt: number): void {
  for (let layer = 0; layer < radius; layer++) {
    const r = radius - layer;
    for (let x = cx - r; x <= cx + r; x++) for (let z = cz - r; z <= cz + r; z++) {
      if (sink.get(x, base + layer - 1, z) === P.AIR) continue;
      putAir(sink, clip, x, base + layer, z, h8(x, base + layer, z, 41) < 90 ? alt : v);
    }
  }
}

// --- planning --------------------------------------------------------------------

/** Every landscape prop, and the collapses some of them cause (the culvert's dropped span). */
export function planProps(plan: WorldPlan, root: Rng): { props: PropPlan[]; hits: DirectHit[] } {
  const p = plan.params;
  const m = (metres: number) => vx(metres, p.voxel);
  const L = p.layout;
  const props: PropPlan[] = [];
  const hits: DirectHit[] = [];

  // Shelterbelts: the shattered windbreaks between fields, Python's spacing in metres.
  const belts = root.derive('props.tree');
  for (const zc of L.shelterbelts) {
    let x = m(1);
    for (;;) {
      x += belts.randint(m(1), m(3) + 1);
      if (x >= p.dims.x - m(1)) break;
      const z = zc + (belts.chance(0.5) ? -m(1) : m(1)) + belts.randint(-m(0.5), m(0.5) + 1);
      const stump = belts.chance(0.62);
      const a = stump ? belts.randint(m(1.0), m(2.5) + 1) : belts.randint(m(3.5), m(7.5) + 1);
      const b = (belts.chance(0.55) ? 1 : 0) | (belts.chance(0.22) ? 2 : 0);
      props.push({ kind: 'tree', x, z, seed: belts.nextU32(), a, b });
    }
  }

  // The wood behind their lines: a tree every ~3 m, most of them shot to stumps.
  const wood = root.derive('props.wood');
  for (let z0 = L.wood[0] + m(1.5); z0 < L.wood[1] - m(1); z0 += m(3)) {
    for (let x0 = m(2); x0 < p.dims.x - m(2); x0 += m(3)) {
      const x = x0 + wood.randint(-m(1), m(1) + 1);
      const z = z0 + wood.randint(-m(1), m(1) + 1);
      const stump = wood.chance(0.45);
      const a = stump ? wood.randint(m(1.0), m(3.0) + 1) : wood.randint(m(4), m(9) + 1);
      const b = (wood.chance(0.4) ? 1 : 0) | (wood.chance(0.15) ? 2 : 0);
      props.push({ kind: 'tree', x, z, seed: wood.nextU32(), a, b });
    }
  }

  // Wire belts out in front of both fire trenches.
  const wire = root.derive('props.wire');
  for (const line of plan.lines) {
    if (!line.spec.firingSteps) continue;
    props.push({ kind: 'wire', x: p.dims.x / 2, z: line.spec.crossBase + line.spec.facing * m(12), seed: wire.nextU32() });
  }

  // Telegraph poles and fence lines in no man's land: things that break the horizon.
  const poles = root.derive('props.pole');
  for (let i = 0; i < p.clutter.poles; i++) {
    const x = poles.randint(m(4), p.dims.x - m(4));
    const z = poles.randint(L.front + m(14), L.enemyFront - m(14));
    props.push({ kind: 'pole', x, z, seed: poles.nextU32(), a: poles.randint(m(4), m(7.5) + 1), b: poles.chance(0.5) ? 1 : 0 });
  }
  const fences = root.derive('props.fence');
  for (let i = 0; i < p.clutter.fenceLines; i++) {
    const z = fences.randint(L.front + m(16), L.enemyFront - m(16));
    const drift = Math.round(fences.uniform(-0.05, 0.05) * 1000);
    props.push({ kind: 'fence', x: p.dims.x / 2, z, seed: fences.nextU32(), a: drift, b: fences.randint(m(2), m(4) + 1) });
  }

  // Landmarks.
  const land = root.derive('props.landmarks');
  props.push({ kind: 'hull', x: L.hull[0], z: L.hull[1], seed: land.nextU32() });
  props.push({ kind: 'farm', x: L.farm[0], z: L.farm[1], seed: land.nextU32() });
  const culvert: PropPlan = { kind: 'culvert', x: L.culvert[0], z: L.culvert[1], seed: land.nextU32() };
  props.push(culvert);
  const top = columnTopAt(plan, culvert.x, culvert.z);
  hits.push({ x: culvert.x, y: top - m(2.0) + m(2.5), z: culvert.z, r: m(2.0), seed: land.nextU32() });

  // The hamlet behind our lines: a road, six wrecked buildings, a church tower.
  const hamlet = root.derive('props.hamlet');
  const mid = Math.floor((L.hamlet[0] + L.hamlet[1]) / 2);
  props.push({ kind: 'road', x: p.dims.x / 2, z: mid, seed: hamlet.nextU32(), a: Math.round(hamlet.uniform(-0.04, 0.04) * 1000) });
  for (let i = 0; i < 6; i++) {
    const x = m(20) + i * m(38) + hamlet.randint(-m(6), m(6) + 1);
    const side = i % 2 === 0 ? -1 : 1;
    const z = mid + side * hamlet.randint(m(7), m(11) + 1);
    props.push({
      kind: 'hamlet', x, z, seed: hamlet.nextU32(),
      a: hamlet.randint(m(5), m(9) + 1), b: hamlet.randint(m(4), m(7) + 1), c: hamlet.randint(m(3.5), m(6) + 1),
    });
  }
  props.push({ kind: 'church', x: m(115), z: mid - m(14), seed: hamlet.nextU32(), a: hamlet.randint(m(9), m(12) + 1) });

  return { props, hits };
}

/** How far from its anchor x a prop can reach, for culling bands. */
export function propReach(prop: PropPlan): number {
  switch (prop.kind) {
    case 'wire':
    case 'fence':
    case 'road':
      return WIDE;
    case 'tree':
      return 60;
    case 'pole':
    case 'church':
      return 30;
    case 'culvert':
      return 160;
    default:
      return 80;
  }
}

// --- drawing -----------------------------------------------------------------------

export function stampProp(sink: VoxelSink, clip: Clip, plan: WorldPlan, prop: PropPlan): void {
  switch (prop.kind) {
    case 'tree': return stampTree(sink, clip, plan, prop);
    case 'wire': return stampWire(sink, clip, plan, prop);
    case 'pole': return stampPole(sink, clip, plan, prop);
    case 'fence': return stampFence(sink, clip, plan, prop);
    case 'hull': return stampHull(sink, clip, plan, prop);
    case 'farm': return stampBuilding(sink, clip, plan, prop, vx(8.0, plan.params.voxel), vx(5.5, plan.params.voxel), vx(4.5, plan.params.voxel));
    case 'hamlet': return stampBuilding(sink, clip, plan, prop, prop.a!, prop.b!, prop.c!);
    case 'church': return stampChurch(sink, clip, plan, prop);
    case 'culvert': return stampCulvert(sink, clip, plan, prop);
    case 'road': return stampRoad(sink, clip, plan, prop);
  }
}

const COMPASS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]] as const;

function trunk(sink: VoxelSink, clip: Clip, plan: WorldPlan, x: number, z: number, height: number, big: boolean, seed: number): void {
  const base = columnTopAt(plan, x, z);
  const offsets = big ? [-1, 0, 1] : [0, 1];
  const jag = Math.max(2, Math.min(6, height >> 2));
  for (const dx of offsets) {
    for (const dz of offsets) {
      const outer = big && (dx !== 0 || dz !== 0);
      const top = base + height - (hash32x4(x + dx, z + dz, seed, 51) % jag);
      for (let y = base; y < top; y++) {
        const v = y === top - 1 ? P.TRUNK_SPLINTER : outer && h8(x + dx, y, z + dz, 52) < 150 ? P.TRUNK_BARK : P.TRUNK;
        putAir(sink, clip, x + dx, y, z + dz, v);
      }
    }
  }
}

function stampTree(sink: VoxelSink, clip: Clip, plan: WorldPlan, q: PropPlan): void {
  const r = Rng.root(q.seed);
  const h = q.a ?? 30;
  const big = h >= vx(3.5, plan.params.voxel);
  trunk(sink, clip, plan, q.x, q.z, h, big, q.seed);
  const base = columnTopAt(plan, q.x, q.z);
  if (big) {
    const branches = r.randint(1, 4);
    for (let i = 0; i < branches; i++) {
      const [dx, dz] = COMPASS[r.randint(0, 8)];
      const y = base + Math.floor(h * r.uniform(0.5, 0.9));
      const len = r.randint(8, 21);
      const rise = r.randint(2, 9);
      line(sink, clip, [q.x + dx, y, q.z + dz], [q.x + dx * len, y + rise, q.z + dz * len], P.BRANCH);
    }
  }
  if ((q.b ?? 0) & 1) {
    const [dx, dz] = COMPASS[r.randint(0, 8)];
    const gap = r.randint(3, 6);
    trunk(sink, clip, plan, q.x + dx * gap, q.z + dz * gap, Math.max(4, Math.floor(h * r.uniform(0.4, 0.8))), false, q.seed ^ 0x5a5a);
  }
  if ((q.b ?? 0) & 2) {
    const [dx, dz] = COMPASS[r.randint(0, 4) * 2];
    const len = r.randint(20, 46);
    for (let i = 3; i < len; i++) {
      const x = q.x + dx * i;
      const z = q.z + dz * i;
      const y = columnTopAt(plan, x, z);
      for (const [ox, oz] of [[0, 0], [dz, dx]] as const) for (let k = 0; k < 2; k++) putAir(sink, clip, x + ox, y + k, z + oz, k === 1 && h8(x, y, z, 53) < 120 ? P.TRUNK_BARK : P.TRUNK);
    }
  }
  const debris = r.randint(1, 5);
  for (let i = 0; i < debris; i++) {
    const x = q.x + r.randint(-12, 13);
    const z = q.z + r.randint(-8, 9);
    const len = r.randint(3, 9);
    const [dx, dz] = COMPASS[r.randint(0, 8)];
    for (let k = 0; k < len; k++) putAir(sink, clip, x + dx * k, columnTopAt(plan, x + dx * k, z + dz * k), z + dz * k, P.BRANCH);
  }
}

function stampWire(sink: VoxelSink, clip: Clip, plan: WorldPlan, q: PropPlan): void {
  const p = plan.params;
  const spacing = vx(3.0, p.voxel);
  const row = vx(0.5, p.voxel);
  const heights = [0.3, 0.7, 1.1].map((m) => vx(m, p.voxel));
  const picket = (side: number, i: number) => {
    const x = i * spacing + (side ? spacing >> 1 : 0) + (hash32x4(q.seed, side, i, 61) % 5) - 2;
    const z = q.z + (side ? row : -row) + (hash32x4(q.seed, side, i, 62) % 3) - 1;
    const present = (hash32x4(q.seed, side, i, 63) & 255) < 220 && x >= 0 && x < p.dims.x;
    const tall = vx(1.2, p.voxel) + (hash32x4(q.seed, side, i, 64) % vx(0.3, p.voxel));
    return { x, z, present, tall, base: present ? columnTopAt(plan, x, z) : 0 };
  };
  const i0 = Math.floor((clip.x0 - 2 * spacing) / spacing);
  const i1 = Math.ceil((clip.x1 + 2 * spacing) / spacing);
  for (let i = Math.max(0, i0); i <= i1; i++) {
    for (const side of [0, 1]) {
      const a = picket(side, i);
      if (!a.present) continue;
      for (let y = a.base; y < a.base + a.tall; y++) putAir(sink, clip, a.x, y, a.z, h8(a.x, y, a.z, 65) < 80 ? P.PICKET_RUST : P.PICKET);
      const b = picket(side, i + 1);
      if (b.present) {
        for (const k of heights) strand(sink, clip, [a.x, a.base + k, a.z], [b.x, b.base + k, b.z], h8(a.x, k, side, 66) < 100 ? P.WIRE_RUST : P.WIRE);
      }
      const c = picket(1 - side, side ? i + 1 : i);
      if (c.present) strand(sink, clip, [a.x, a.base + heights[1], a.z], [c.x, c.base + heights[2], c.z], P.WIRE);
    }
  }
}

function stampPole(sink: VoxelSink, clip: Clip, plan: WorldPlan, q: PropPlan): void {
  const r = Rng.root(q.seed);
  const base = columnTopAt(plan, q.x, q.z);
  const lean = r.randint(-1, 2);
  const h = q.a ?? 50;
  let x = q.x;
  for (let k = 0; k < h; k++) {
    if (k > 0 && k % 12 === 0) x += lean;
    for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) put(sink, clip, x + dx, base + k, q.z + dz, h8(x + dx, base + k, q.z + dz, 71) < 60 ? P.TRUNK_BARK : P.TRUNK);
  }
  if (q.b) {
    const y = base + h - 3;
    for (let dx = -6; dx <= 7; dx++) putAir(sink, clip, x + dx, y, q.z, P.BRANCH);
    for (const end of [-6, 7]) {
      const drop = r.randint(3, 12);
      for (let k = 1; k <= drop; k++) putAir(sink, clip, x + end, y - k, q.z + (k >> 2), P.WIRE);
    }
  }
}

function stampFence(sink: VoxelSink, clip: Clip, plan: WorldPlan, q: PropPlan): void {
  const p = plan.params;
  const spacing = q.b ?? 30;
  const drift = (q.a ?? 0) / 1000;
  const post = (i: number) => {
    const x = i * spacing + (hash32x4(q.seed, i, 0, 81) % 5);
    const z = Math.round(q.z + drift * (x - p.dims.x / 2));
    const standing = (hash32x4(q.seed, i, 0, 82) & 255) < 184 && x >= 0 && x < p.dims.x;
    const tall = vx(1.0, p.voxel) + (hash32x4(q.seed, i, 0, 83) % vx(1.5, p.voxel));
    const lean = (hash32x4(q.seed, i, 0, 84) % 3) - 1;
    return { x, z, standing, tall, lean, base: standing ? columnTopAt(plan, x, z) : 0 };
  };
  const i0 = Math.floor((clip.x0 - 2 * spacing) / spacing);
  const i1 = Math.ceil((clip.x1 + 2 * spacing) / spacing);
  for (let i = Math.max(0, i0); i <= i1; i++) {
    const a = post(i);
    if (!a.standing) continue;
    for (let k = 0; k < a.tall; k++) put(sink, clip, a.x + Math.trunc((k * a.lean) / a.tall), a.base + k, a.z, k === a.tall - 1 ? P.TRUNK_SPLINTER : P.TRUNK);
    const b = post(i + 1);
    if (!b.standing) continue;
    for (const k of [vx(0.5, p.voxel), vx(0.9, p.voxel)]) {
      if (k < a.tall && k < b.tall) strand(sink, clip, [a.x, a.base + k, a.z], [b.x, b.base + k, b.z], P.WIRE_RUST);
    }
  }
}

/** Only these survive a building's or hull's holes: everything else is protected. */
function onlyCarve(...ids: number[]): Uint8Array {
  const protect = new Uint8Array(256).fill(1);
  for (const id of ids) protect[id] = 0;
  return protect;
}

function stampHull(sink: VoxelSink, clip: Clip, plan: WorldPlan, q: PropPlan): void {
  const p = plan.params;
  const r = Rng.root(q.seed);
  const len = vx(7.0, p.voxel);
  const wide = vx(3.5, p.voxel);
  const high = vx(2.5, p.voxel);
  const x0 = q.x - (len >> 1);
  const z0 = q.z - (wide >> 1);
  const base = medianTop(plan, x0, z0, len, wide) - 1;
  const plate = (x: number, y: number, z: number) => (h8(x, y, z, 91) < 64 ? P.HULL_RUST : P.HULL);
  for (let x = x0; x < x0 + len; x++) {
    const glacis = x - (x0 + len - 10);
    const top = base + high - Math.max(0, glacis);
    for (let y = base; y < top; y++) for (let z = z0; z < z0 + wide; z++) put(sink, clip, x, y, z, plate(x, y, z));
  }
  const tx = x0 + r.randint(vx(1.5, p.voxel), vx(3.5, p.voxel));
  for (let x = tx; x < tx + 25; x++) for (let y = base + high; y < base + high + 15; y++) for (let z = z0 + 5; z < z0 + wide - 5; z++) put(sink, clip, x, y, z, plate(x, y, z));
  const zb = q.z;
  for (let k = 0; k < 30; k++) {
    const y = base + high + 7 - (k >> 3);
    for (const [dy, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) put(sink, clip, tx + 25 + k, y + dy, zb + dz, P.HULL);
  }
  const protect = onlyCarve(P.HULL, P.HULL_RUST);
  for (let i = 0; i < 4; i++) {
    const cx = x0 + r.uniform(4, len - 4);
    const cy = base + r.uniform(4, high + 10);
    const cz = z0 + r.uniform(4, wide - 4);
    carveWith(sink, clip, cx, cy, cz, r.uniform(vx(0.6, p.voxel), vx(1.2, p.voxel)), r.derive(`hole${i}`), { protect });
  }
  for (let x = x0 - 3; x < x0 + len + 3; x++) {
    for (let z = z0 - 3; z < z0 + wide + 3; z++) {
      if (x >= x0 && x < x0 + len && z >= z0 && z < z0 + wide) continue;
      if (h8(x, 0, z, 92) < 140) flatRubble(sink, clip, plan, x, z, P.RUBBLE);
    }
  }
}

function brickVoxel(x: number, y: number, z: number, base: number): number {
  if ((y - base) % 3 === 2) return P.MORTAR;
  return h8(x, y, z, 101) < 50 ? P.BRICK_DARK : P.BRICK;
}

/** A wrecked brick building: Python's farm outbuilding, and the hamlet's houses. */
function stampBuilding(sink: VoxelSink, clip: Clip, plan: WorldPlan, q: PropPlan, w: number, d: number, high: number): void {
  const p = plan.params;
  const r = Rng.root(q.seed);
  const x0 = q.x - (w >> 1);
  const z0 = q.z - (d >> 1);
  const base = medianTop(plan, x0, z0, w, d);
  const t = 3;
  // The site is levelled: a concrete slab, open air above it.
  for (let x = x0; x < x0 + w; x++) {
    for (let z = z0; z < z0 + d; z++) {
      put(sink, clip, x, base - 1, z, h8(x, 0, z, 102) < 60 ? P.CONCRETE_STAINED : P.CONCRETE);
      for (let y = base; y < base + high + 20; y++) put(sink, clip, x, y, z, P.AIR);
    }
  }
  firmRing(sink, clip, x0, x0 + w, z0, z0 + d, base - 1, base + high + 20);
  const down = [r.randint(0, 4)];
  down.push((down[0] + 1 + r.randint(0, 3)) % 4);
  const wallTop = [0, 1, 2, 3].map((side) => (down.includes(side) ? base + r.randint(vx(1.0, p.voxel), vx(2.5, p.voxel) + 1) : base + high));
  const door = x0 + r.randint(t + 2, Math.max(t + 3, w - t - 12));
  for (let x = x0; x < x0 + w; x++) {
    for (let z = z0; z < z0 + d; z++) {
      const side = z < z0 + t ? 0 : z >= z0 + d - t ? 1 : x < x0 + t ? 2 : x >= x0 + w - t ? 3 : -1;
      if (side < 0) continue;
      for (let y = base; y < wallTop[side]; y++) {
        if (side === 0 && x >= door && x < door + 10 && y < base + vx(2.0, p.voxel)) continue;
        put(sink, clip, x, y, z, brickVoxel(x, y, z, base));
      }
    }
  }
  if (r.chance(0.4)) {
    for (const f of [1 / 3, 2 / 3]) {
      const bx = x0 + Math.floor(w * f);
      const y = Math.min(wallTop[0], wallTop[1]) - 1;
      if (y < base + 10) continue;
      for (let z = z0; z < z0 + d; z++) for (const [dx, dy] of [[0, 0], [1, 0], [0, -1], [1, -1]] as const) put(sink, clip, bx + dx, y + dy, z, P.TIMBER_DARK);
    }
  }
  const protect = onlyCarve(P.BRICK, P.BRICK_DARK, P.MORTAR);
  for (let i = 0; i < 6; i++) {
    const cx = x0 + r.uniform(0, w);
    const cz = r.chance(0.5) ? z0 + r.uniform(0, d) : r.chance(0.5) ? z0 + 1 : z0 + d - 2;
    const cy = base + r.uniform(5, high - 5);
    carveWith(sink, clip, cx, cy, cz, r.uniform(vx(0.75, p.voxel), vx(1.6, p.voxel)), r.derive(`hole${i}`), { protect });
  }
  for (let x = x0 + t; x < x0 + w - t; x++) for (let z = z0 + t; z < z0 + d - t; z++) putAir(sink, clip, x, base, z, h8(x, base, z, 103) < 100 ? P.RUBBLE_BRICK : P.RUBBLE);
  const heaps = r.randint(1, 3);
  for (let i = 0; i < heaps; i++) {
    const radius = r.randint(4, 9);
    const hx = x0 + t + radius + r.randint(0, Math.max(1, w - 2 * t - 2 * radius));
    const hz = z0 + t + radius + r.randint(0, Math.max(1, d - 2 * t - 2 * radius));
    heap(sink, clip, hx, base + 1, hz, radius, P.RUBBLE_BRICK, P.RUBBLE);
  }
}

function stampChurch(sink: VoxelSink, clip: Clip, plan: WorldPlan, q: PropPlan): void {
  const p = plan.params;
  const r = Rng.root(q.seed);
  const s = vx(3.0, p.voxel);
  const t = 4;
  const x0 = q.x - (s >> 1);
  const z0 = q.z - (s >> 1);
  const base = medianTop(plan, x0, z0, s, s);
  const high = q.a ?? 100;
  const ragged = vx(3.0, p.voxel);
  for (let x = x0; x < x0 + s; x++) {
    for (let z = z0; z < z0 + s; z++) {
      put(sink, clip, x, base - 1, z, P.CONCRETE);
      const wall = x < x0 + t || x >= x0 + s - t || z < z0 + t || z >= z0 + s - t;
      const top = base + high - (hash32x4(x, z, q.seed, 111) % ragged);
      for (let y = base; y < base + high; y++) {
        if (!wall || y >= top) {
          put(sink, clip, x, y, z, P.AIR);
          continue;
        }
        const door = z < z0 + t && x >= q.x - 5 && x < q.x + 5 && y < base + vx(2.4, p.voxel);
        const belfry = (y >= base + high - vx(3.2, p.voxel) && y < base + high - vx(1.6, p.voxel))
          && ((x >= q.x - 5 && x < q.x + 5) || (z >= q.z - 5 && z < q.z + 5));
        put(sink, clip, x, y, z, door || belfry ? P.AIR : brickVoxel(x, y, z, base));
      }
    }
  }
  const protect = onlyCarve(P.BRICK, P.BRICK_DARK, P.MORTAR);
  for (let i = 0; i < 2; i++) {
    carveWith(sink, clip, x0 + r.uniform(0, s), base + r.uniform(vx(2, p.voxel), high - vx(2, p.voxel)), r.chance(0.5) ? z0 + 1 : z0 + s - 2, r.uniform(vx(0.6, p.voxel), vx(1.2, p.voxel)), r.derive(`hole${i}`), { protect });
  }
  firmRing(sink, clip, x0, x0 + s, z0, z0 + s, base - 1, base + high);
  heap(sink, clip, q.x, base, q.z, 6, P.RUBBLE_BRICK, P.RUBBLE);
}

function stampCulvert(sink: VoxelSink, clip: Clip, plan: WorldPlan, q: PropPlan): void {
  const p = plan.params;
  const len = vx(9.0, p.voxel);
  const box = vx(2.5, p.voxel);
  const bore = vx(1.5, p.voxel);
  const x0 = q.x - (len >> 1);
  const half = box >> 1;
  const base = columnTopAt(plan, q.x, q.z) - vx(2.0, p.voxel);
  // The track's embankment: packed earth, flat-topped, falling away at 45°.
  const flat = { x0: x0 - vx(6, p.voxel), x1: x0 + len + vx(6, p.voxel), z0: q.z - vx(1.5, p.voxel), z1: q.z + vx(1.5, p.voxel) };
  const rise = vx(1.0, p.voxel);
  for (let x = Math.max(clip.x0, flat.x0 - rise); x < Math.min(clip.x1, flat.x1 + rise); x++) {
    for (let z = flat.z0 - rise; z < flat.z1 + rise; z++) {
      const dx = x < flat.x0 ? flat.x0 - x : x >= flat.x1 ? x - flat.x1 + 1 : 0;
      const dz = z < flat.z0 ? flat.z0 - z : z >= flat.z1 ? z - flat.z1 + 1 : 0;
      const h = rise - Math.max(dx, dz);
      const top = columnTopAt(plan, x, z);
      for (let k = 0; k < h; k++) putAir(sink, clip, x, top + k, z, h8(x, top + k, z, 121) < 80 ? P.MUD_TURNED : P.MUD_DARK);
    }
  }
  // The box section and its bore; the middle span is dropped by a planned collapse.
  for (let x = x0; x < x0 + len; x++) {
    for (let z = q.z - half; z < q.z - half + box; z++) {
      for (let y = base; y < base + box; y++) {
        const inBore = Math.abs(z - q.z) < bore >> 1 && y >= base + ((box - bore) >> 1) && y < base + ((box + bore) >> 1);
        put(sink, clip, x, y, z, inBore ? P.AIR : h8(x, y, z, 122) < 70 ? P.CONCRETE_STAINED : P.CONCRETE);
      }
    }
  }
}

function stampRoad(sink: VoxelSink, clip: Clip, plan: WorldPlan, q: PropPlan): void {
  const p = plan.params;
  const half = vx(2.0, p.voxel);
  const rut = vx(0.9, p.voxel);
  const drift = (q.a ?? 0) / 1000;
  for (let x = clip.x0; x < clip.x1; x++) {
    const zc = Math.round(q.z + drift * (x - p.dims.x / 2));
    for (let z = zc - half; z <= zc + half; z++) {
      const top = columnTopAt(plan, x, z);
      const here = sink.get(x, top - 1, z);
      if (here !== P.SOD && here !== P.SOD_DRY && here !== P.SOD_TUFT && here !== P.MUD_TURNED) continue;
      const inRut = Math.abs(Math.abs(z - zc) - rut) <= 1;
      sink.set(x, top - 1, z, inRut ? (h8(x, 0, z, 131) < 120 ? P.MUD_WET : P.MUD_DARK) : h8(x, 0, z, 132) < 160 ? P.MUD_TURNED : P.MUD);
    }
  }
}
