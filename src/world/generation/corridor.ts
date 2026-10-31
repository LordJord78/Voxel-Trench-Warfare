/**
 * The Corridor (the multiplayer spec's §5): one wood down the middle of the map, end to end, and a
 * side dug in at each end of it, Red to the south and Blue to the north, each starting where the
 * trees start. Open shelled fields either side of the wood, with a few ruins, are the flanks.
 *
 * Fair by construction: the map is the same turned half a turn about its centre. Red's half is
 * planned (its lines, its shell holes, its half of the wood) and Blue's is Red's turned, so every
 * trench, crater and tree of one side has its twin at (W - x, W - z) on the other; the field is
 * made the same way (terrain.ts). A continuous coordinate c turns to W - c; voxel index i, to W - 1 - i.
 */

import { TAU, sin } from '../../core/dmath';
import type { Rng } from '../../core/rng';
import { radius, REACH, type Crater, type DirectHit } from './craters';
import { vx, type GenParams, type LineSpec } from './params';
import type { PropPlan } from './plan';
import { surfaceAt, type TerrainModel } from './terrain';
import { meanderAt, type BayPlan, type DugoutPlan, type LegPlan, type LinePlan, type Wave } from './trenches';

/** Blue's name for one of Red's lines: front → enemy_front, comm_0 → enemy_comm_0. */
export function turnedName(name: string): string {
  return `enemy_${name}`;
}

/** One of Red's lines turned half a turn about the map's centre: Blue's. */
export function turnLine(p: GenParams, line: LinePlan): LinePlan {
  const W = p.dims;
  const s = line.spec;
  const [A, B] = s.longAxis === 0 ? [W.x, W.z] : [W.z, W.x];
  const name = turnedName(s.name);
  const spec: LineSpec = {
    ...s, name, side: 1, crossBase: B - s.crossBase - p.trench.width, aStart: A - s.aEnd, aEnd: A - s.aStart, facing: s.facing > 0 ? -1 : 1,
  };
  const n = line.bays.length;
  const bays = line.bays
    .map((b): BayPlan => ({
      ...b, line: name, index: n - 1 - b.index,
      a0: A - b.a1, a1: A - b.a0, b0: B - b.b1, b1: B - b.b0,
      x0: W.x - b.x1, x1: W.x - b.x0, z0: W.z - b.z1, z1: W.z - b.z0,
      stepLo: B - b.stepLo - b.stepSpan, walkX: W.x - b.walkX, walkZ: W.z - b.walkZ,
      facing: b.facing > 0 ? -1 : 1, turned: A,
    }))
    .reverse();
  const legs = line.legs.map((g): LegPlan => ({ ...g, a0: A - g.a1, a1: A - g.a0, b0: B - g.b1, b1: B - g.b0 })).reverse();
  const dugouts = line.dugouts.map((d): DugoutPlan => {
    const passage = { x0: W.x - d.passage.x1, x1: W.x - d.passage.x0, z0: W.z - d.passage.z1, z1: W.z - d.passage.z0 };
    return {
      ...d, line: name, bay: n - 1 - d.bay,
      lo: [W.x - d.hi[0], d.lo[1], W.z - d.hi[2]],
      hi: [W.x - d.lo[0], d.hi[1], W.z - d.lo[2]],
      entrance: [(passage.x0 + passage.x1) >> 1, d.entrance[1], (passage.z0 + passage.z1) >> 1],
      passage,
      away: d.away > 0 ? -1 : 1,
    };
  });
  const out: LinePlan = { spec, bays, legs, dugouts };
  // -sin(TAU (A - a) / w + phase) = sin(TAU a / w - TAU A / w - phase): the same wave, turned.
  if (line.meander) out.meander = line.meander.map((w) => ({ amp: w.amp, wave: w.wave, phase: -(TAU * A) / w.wave - w.phase }));
  if (line.profile) {
    const len = line.profile.floors.length;
    out.profile = { a0: A - (line.profile.a0 + len), floors: line.profile.floors.slice().reverse() };
  }
  return out;
}

/** The wood: its middle line's bends (odd about the map's centre, so the line is its own turn), its dense core and its ragged edge either side (voxels), and where it runs along z. */
export interface CorridorPlan {
  bends: Wave[];
  core: number;
  edge: number;
  z0: number;
  z1: number;
}

export function planCorridorShape(p: GenParams, r: Rng): CorridorPlan {
  const m = (metres: number) => vx(metres, p.voxel);
  const sign = () => (r.chance(0.5) ? 1 : -1);
  return {
    // About 6 m either way over the wood's length, and a shorter wander on that.
    bends: [
      { amp: sign() * m(r.uniform(3.5, 5.0)), wave: m(r.uniform(150, 200)), phase: 0 },
      { amp: sign() * m(r.uniform(1.0, 2.0)), wave: m(r.uniform(45, 70)), phase: 0 },
    ],
    core: m(6),
    edge: m(10),
    z0: p.layout.wood[0],
    z1: p.layout.wood[1],
  };
}

/** The wood's middle at z (voxels, continuous). */
export function corridorX(p: GenParams, c: CorridorPlan, z: number): number {
  return p.dims.x / 2 + meanderAt(c.bends, z - p.dims.z / 2);
}

/** A prop turned half a turn about the map's centre. */
function turnProp(p: GenParams, q: PropPlan): PropPlan {
  return { ...q, x: p.dims.x - 1 - q.x, z: p.dims.z - 1 - q.z };
}

/**
 * The Corridor's props: its half of the wood (trees thick in the core, thinning to its edge, a third
 * of them in leaf; brush under them), ruins and poles out on the flanks, all turned for Blue's half;
 * and a wire belt before each fire trench. `open` says where a tree may stand (not in a trench).
 */
export function planCorridorProps(p: GenParams, c: CorridorPlan, lines: readonly LinePlan[], root: Rng, open: (x: number, z: number) => boolean): PropPlan[] {
  const m = (metres: number) => vx(metres, p.voxel);
  const half = p.dims.z / 2;
  const mine: PropPlan[] = [];

  const trees = root.derive('corridor.trees');
  const step = m(2.3);
  for (let z0 = c.z0; z0 < half; z0 += step) {
    const mid = corridorX(p, c, z0);
    for (let x0 = mid - c.edge; x0 <= mid + c.edge; x0 += step) {
      // Every draw made whether or not the tree is planted, so one kept or not never moves the next.
      const x = Math.round(x0 + trees.uniform(-m(0.8), m(0.8)));
      const z = Math.min(half - 1, Math.round(z0 + trees.uniform(-m(0.8), m(0.8))));
      const roll = trees.float();
      const kind = trees.float();
      const tall = trees.float();
      const b = (trees.chance(0.25) ? 1 : 0) | (trees.chance(0.1) ? 2 : 0);
      const seed = trees.nextU32();
      const d = Math.abs(x + 0.5 - corridorX(p, c, z + 0.5));
      const keep = d < c.core ? 0.8 : d < c.edge ? 0.45 * (1 - (d - c.core) / (c.edge - c.core)) + 0.1 : 0;
      if (roll >= keep || !open(x, z)) continue;
      // Stumps, shattered trunks, and trees still in leaf.
      const a = kind < 0.15 ? m(1.0 + 1.5 * tall) : kind < 0.45 ? m(4 + 5 * tall) : m(7 + 5 * tall);
      mine.push({ kind: 'tree', x, z, seed, a, b: kind >= 0.45 ? b | 4 : b });
    }
  }

  const brush = root.derive('corridor.brush');
  const brushes = Math.round(((half - c.z0) * 2 * c.core) / (m(3.5) * m(3.5)));
  for (let i = 0; i < brushes; i++) {
    const z = brush.randint(c.z0, half);
    const x = Math.round(corridorX(p, c, z) + brush.uniform(-c.edge, c.edge));
    const a = brush.randint(m(0.5), m(1.1) + 1);
    const seed = brush.nextU32();
    if (open(x, z)) mine.push({ kind: 'brush', x, z, seed, a });
  }

  // The flanks: a farm's ruins out on each side, and the poles of the line that ran past them.
  const flank = root.derive('corridor.flanks');
  for (const side of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      const x = side < 0 ? flank.randint(m(22), m(58)) : flank.randint(p.dims.x - m(58), p.dims.x - m(22));
      const z = flank.randint(m(62), half - m(14));
      mine.push({
        kind: 'hamlet', x, z, seed: flank.nextU32(),
        a: flank.randint(m(5), m(8) + 1), b: flank.randint(m(4), m(6) + 1), c: flank.randint(m(2.5), m(4.5) + 1),
      });
    }
  }
  for (let i = 0; i < p.clutter.poles / 2; i++) {
    const side = i % 2 ? 1 : -1;
    const x = side < 0 ? flank.randint(m(10), m(80)) : flank.randint(p.dims.x - m(80), p.dims.x - m(10));
    const z = flank.randint(m(50), half);
    mine.push({ kind: 'pole', x, z, seed: flank.nextU32(), a: flank.randint(m(4), m(7.5) + 1), b: flank.chance(0.5) ? 1 : 0 });
  }

  const props = [...mine, ...mine.map((q) => turnProp(p, q))];
  // Wire before both fire trenches, along their bends.
  const wire = root.derive('props.wire');
  lines.forEach((line, index) => {
    if (!line.spec.firingSteps) return;
    props.push({ kind: 'wire', x: p.dims.x / 2, z: line.spec.crossBase + line.spec.facing * m(12), seed: wire.nextU32(), c: index });
  });
  return props;
}

/**
 * The Corridor's shell holes: Red's half of the field between the fire trenches (as many in the
 * wood as out of it), a few behind Red's lines, and direct hits on Red's fire trench; then all of
 * them turned for Blue's half, each crater's outline turned with it.
 */
export function planCorridorCraters(p: GenParams, t: TerrainModel, rng: Rng, front: LinePlan): { open: Crater[]; direct: DirectHit[] } {
  const m = (metres: number) => vx(metres, p.voxel);
  const edge = m(1.5);
  const half = p.dims.z / 2;
  const inside = (v: number, r: number, size: number) => {
    const keep = Math.ceil(REACH * r) + 2;
    return Math.max(keep, Math.min(size - keep, v));
  };
  const frontAt = (x: number) => front.spec.crossBase + meanderAt(front.meander ?? [], x);
  const open: Crater[] = [];

  const field = rng.derive('craters.field');
  for (let i = 0; i < p.craters.nml / 2; i++) {
    const x = field.randint(edge, p.dims.x - edge);
    const lo = frontAt(x) + p.trench.width + m(6);
    const z = lo + field.float() * (half - lo);
    const r = radius(p, field, p.craters.radiusCap);
    const shape = field.nextU32();
    open.push({ x: inside(x, r, p.dims.x), z, r, ragged: 1, shape });
  }
  const rear = rng.derive('craters.rear');
  for (let i = 0; i < p.craters.rear / 2; i++) {
    const x = rear.randint(edge, p.dims.x - edge);
    const r = radius(p, rear, p.craters.radiusCap);
    const z = rear.randint(edge, Math.max(edge + 1, Math.floor(frontAt(x)) - m(4)));
    const shape = rear.nextU32();
    open.push({ x: inside(x, r, p.dims.x), z: inside(z, r, p.dims.z), r, ragged: 1, shape });
  }

  const direct: DirectHit[] = [];
  const hits = rng.derive('craters.direct.0');
  for (let i = 0; i < p.craters.directPerLine; i++) {
    const x = front.spec.aStart + hits.float() * (front.spec.aEnd - front.spec.aStart);
    const z = frontAt(x) - m(1.0) + hits.float() * m(7.5);
    const r = radius(p, hits, p.craters.directCap);
    const y = surfaceAt(t, p, Math.floor(x), Math.floor(z)) - Math.trunc(r * 0.55);
    direct.push({ x, y, z, r, seed: hits.nextU32() });
  }

  const W = p.dims;
  return {
    open: [...open, ...open.map((c) => ({ ...c, x: W.x - c.x, z: W.z - c.z, turned: true }))],
    direct: [...direct, ...direct.map((d) => ({ ...d, x: W.x - d.x, z: W.z - d.z }))],
  };
}
