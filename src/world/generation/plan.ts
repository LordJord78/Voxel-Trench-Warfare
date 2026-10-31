/**
 * The world plan: every decision generation makes that is not per-voxel.
 *
 * Built once from the parameters and the seed, it is small enough to send to
 * every worker, and complete enough that a worker filling any band needs
 * nothing else. Every random stream derives from the root by label, so adding
 * a feature never shifts the numbers another feature receives.
 */

import { TAU } from '../../core/dmath';
import { Rng } from '../../core/rng';
import { REACH as CRATER_REACH, planCraters, type Crater, type DirectHit } from './craters';
import { vx, type GenParams, type LineSpec } from './params';
import { buildTerrain, surfaceAt, type TerrainModel } from './terrain';
import { planCorridorCraters, planCorridorProps, planCorridorShape, turnLine, type CorridorPlan } from './corridor';
import { planProps, propHits, structureFootprints } from './props';
import { clearOfTrenches, meanderAt, planDugout, planLine, type DugoutPlan, type LinePlan, type PlanLineOptions, type Wave } from './trenches';

export interface PropPlan {
  kind: string;
  x: number;
  z: number;
  seed: number;
  a?: number;
  b?: number;
  c?: number;
}

export interface WorldPlan {
  seed: number;
  params: GenParams;
  terrain: TerrainModel;
  craters: Crater[];
  direct: DirectHit[];
  lines: LinePlan[];
  props: PropPlan[];
  /** The Corridor's wood, on that map. */
  corridor?: CorridorPlan;
}

export function planWorld(params: GenParams, seed: number): WorldPlan {
  if (params.map === 'corridor') return planCorridor(params, seed);
  const root = Rng.root(seed);
  const terrain = buildTerrain(params, root);
  const surface = (x: number, z: number) => surfaceAt(terrain, params, x, z);
  // Each line sees the lines before it: a communication trench meets their floors, and runs from
  // where it meets the line at its back to where it meets the fire trench, wherever their bends put them.
  const lines: LinePlan[] = [];
  const sides = [0, 1].map((side) => sideBend(params, root.derive(`meander.${side}`)));
  for (const planned of params.lines) {
    const rng = root.derive(`trench.${planned.name}`);
    const crossing = lines.some((l) => l.spec.longAxis !== planned.longAxis);
    if (crossing) {
      const { spec, ends } = junctions(params, planned, lines);
      lines.push(planLine(params, spec, surface, rng, lines, { ends }));
    } else {
      const meander = lineBends(params, sides[planned.side], root.derive(`meander.${planned.name}`));
      lines.push(planLine(params, planned, surface, rng, lines, { meander }));
    }
  }
  placeDugouts(params, lines);
  const fronts = lines
    .filter((l) => l.spec.firingSteps)
    .map((l) => ({ z: l.spec.crossBase, facing: l.spec.facing, at: (x: number) => l.spec.crossBase + meanderAt(l.meander ?? [], x) }));
  const { open, direct } = planCraters(params, terrain, root.derive('craters'), fronts);
  const plan: WorldPlan = { seed, params, terrain, craters: open, direct, lines, props: [] };
  plan.props = planProps(plan, root);
  // Nothing built stands over an open crater: those that would reach a structure are not dug.
  // This runs before anything asks for the ground, which the crater list shapes.
  const structures = structureFootprints(plan, false);
  plan.craters = open.filter((c) => {
    const reach = Math.ceil(CRATER_REACH * c.r) + 1;
    return !structures.some((s) => c.x - reach < s.x1 && s.x0 < c.x + reach && c.z - reach < s.z1 && s.z0 < c.z + reach);
  });
  plan.direct = [...direct, ...propHits(plan)];
  return plan;
}

/**
 * The Corridor (corridor.ts): Red's lines planned as the Ravine's are, Blue's turned from them,
 * then the wood, the shell holes and the rest, each half the other's turned.
 */
function planCorridor(params: GenParams, seed: number): WorldPlan {
  const root = Rng.root(seed);
  const terrain = buildTerrain(params, root);
  const surface = (x: number, z: number) => surfaceAt(terrain, params, x, z);
  const red: LinePlan[] = [];
  const bend = sideBend(params, root.derive('meander.0'));
  for (const planned of params.lines) {
    const rng = root.derive(`trench.${planned.name}`);
    if (red.some((l) => l.spec.longAxis !== planned.longAxis)) {
      const { spec, ends } = junctions(params, planned, red);
      red.push(planLine(params, spec, surface, rng, red, { ends }));
    } else {
      red.push(planLine(params, planned, surface, rng, red, { meander: lineBends(params, bend, root.derive(`meander.${planned.name}`)) }));
    }
  }
  placeDugouts(params, red);
  const lines = [...red, ...red.map((l) => turnLine(params, l))];
  const corridor = planCorridorShape(params, root.derive('corridor'));
  const front = red.find((l) => l.spec.firingSteps)!;
  const { open, direct } = planCorridorCraters(params, terrain, root.derive('craters'), front);
  const plan: WorldPlan = { seed, params, terrain, craters: open, direct, lines, props: [], corridor };
  plan.props = planCorridorProps(params, corridor, lines, root, clearOfTrenches(lines, vx(1.5, params.voxel)));
  // As on the Ravine, nothing built stands over an open crater; a crater goes with its twin.
  const structures = structureFootprints(plan, false);
  const clash = (c: Crater) => {
    const reach = Math.ceil(CRATER_REACH * c.r) + 1;
    return structures.some((s) => c.x - reach < s.x1 && s.x0 < c.x + reach && c.z - reach < s.z1 && s.z0 < c.z + reach);
  };
  const n = open.length / 2;
  plan.craters = open.filter((_, i) => !clash(open[i % n]) && !clash(open[(i % n) + n]));
  plan.direct = [...direct, ...propHits(plan)];
  return plan;
}

/**
 * The long bend a side's lines follow together, as trench systems follow the ground they hold:
 * 3.5 to 5.5 m either way, over 90 to 140 m. Their spacing changes only by their own small bends.
 */
function sideBend(p: GenParams, r: Rng): Wave {
  return { amp: vx(r.uniform(3.5, 5.5), p.voxel), wave: vx(r.uniform(90, 140), p.voxel), phase: r.uniform(0, TAU) };
}

/** A line's own bends: its side's, a little shallower or not, and a short one of its own, 0.4 to 1 m either way. */
function lineBends(p: GenParams, side: Wave, r: Rng): Wave[] {
  return [
    { ...side, amp: side.amp * r.uniform(0.85, 1.0) },
    { amp: vx(r.uniform(0.4, 1.0), p.voxel), wave: vx(r.uniform(28, 45), p.voxel), phase: r.uniform(0, TAU) },
  ];
}

/**
 * Where a line across its side's others (a communication trench) starts and ends: from just
 * behind the rearmost line's trench to the fire trench's parapet face, never through it, at the
 * bays and legs it actually meets. Toward +z (facing +1) it starts at the rear; toward -z, the front.
 */
function junctions(p: GenParams, spec: LineSpec, lines: readonly LinePlan[]): { spec: LineSpec; ends: PlanLineOptions['ends'] } {
  const along = lines.filter((l) => l.spec.side === spec.side && l.spec.longAxis !== spec.longAxis);
  const front = along.find((l) => l.spec.firingSteps);
  const rear = along.reduce<LinePlan | undefined>((r, l) => (!r || (l.spec.crossBase - r.spec.crossBase) * spec.facing < 0 ? l : r), undefined);
  if (!front || !rear) return { spec, ends: undefined };
  const met = (line: LinePlan, b0: number, b1: number) => [...line.bays, ...line.legs].filter((f) => f.a0 < b1 && b0 < f.a1);
  const first = [spec.crossBase, spec.crossBase + p.trench.width] as const;
  const margin = vx(10, p.voxel);
  if (spec.facing > 0) {
    const back = met(rear, ...first);
    const aStart = back.length ? Math.min(...back.map((f) => f.b0)) - 1 : spec.aStart;
    const ends = (b0: number, b1: number) => {
      const at = met(front, b0, b1);
      return at.length ? Math.min(...at.map((f) => f.b1)) : spec.aEnd;
    };
    return { spec: { ...spec, aStart, aEnd: spec.aEnd + margin }, ends };
  }
  const meet = met(front, ...first);
  const aStart = meet.length ? Math.max(...meet.map((f) => f.b0)) : spec.aStart;
  const ends = (b0: number, b1: number) => {
    const at = met(rear, b0, b1);
    return at.length ? Math.max(...at.map((f) => f.b1)) + 1 : spec.aEnd;
  };
  return { spec: { ...spec, aStart, aEnd: spec.aEnd + margin }, ends };
}

type Rect = { x0: number; x1: number; z0: number; z1: number };

const touching = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;

/**
 * Keep every dugout clear of every trench but its own: one planned under a
 * communication trench would have its chamber open into that trench and its
 * roof hanging in the air. Try it where it was, then moved along its bay;
 * failing that, it is not dug.
 */
function placeDugouts(p: GenParams, lines: LinePlan[]): void {
  const trenches: { line: number; bay: number; rect: Rect }[] = [];
  lines.forEach((line, li) => {
    line.bays.forEach((b, bi) => trenches.push({ line: li, bay: bi, rect: { x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1 } }));
    for (const l of line.legs) {
      const rect = l.longAxis === 0 ? { x0: l.a0, x1: l.a1, z0: l.b0, z1: l.b1 } : { x0: l.b0, x1: l.b1, z0: l.a0, z1: l.a1 };
      trenches.push({ line: li, bay: -1, rect });
    }
  });
  const body = (d: DugoutPlan): Rect[] => {
    const chamber = { x0: d.lo[0] - 1, x1: d.hi[0] + 1, z0: d.lo[2] - 1, z1: d.hi[2] + 1 };
    const e = d.passage;
    return [chamber, { x0: e.x0 - 1, x1: e.x1 + 1, z0: e.z0 - 1, z1: e.z1 + 1 }];
  };
  const dug: Rect[] = [];
  lines.forEach((line, li) => {
    const kept: DugoutPlan[] = [];
    for (const d of line.dugouts) {
      const bay = line.bays[d.bay];
      for (const shift of [0, 20, -20, 30, -30]) {
        const c = shift === 0 ? d : planDugout(p, line.spec, bay, shift, d.seed);
        if (!c) continue;
        const parts = body(c);
        const clash = trenches.some((t) => !(t.line === li && t.bay === d.bay) && parts.some((r) => touching(r, t.rect)))
          || dug.some((r) => parts.some((q) => touching(q, r)));
        if (clash) continue;
        kept.push(c);
        dug.push(...parts);
        break;
      }
    }
    line.dugouts = kept;
  });
}

export { bayList } from './bays';

export interface BayLookup {
  at(x: number, z: number): { line: number; bay: number } | null;
}

const CELL = 64;

/** Which bay or leg footprint, if any, holds a column. Legs report the bay they follow. */
export function bayIndex(plan: WorldPlan): BayLookup {
  const cells = new Map<number, { line: number; bay: number; x0: number; x1: number; z0: number; z1: number }[]>();
  const add = (line: number, bay: number, x0: number, x1: number, z0: number, z1: number) => {
    for (let cz = Math.floor(z0 / CELL); cz <= Math.floor((z1 - 1) / CELL); cz++) {
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor((x1 - 1) / CELL); cx++) {
        const key = cz * 65536 + cx;
        const entry = { line, bay, x0, x1, z0, z1 };
        const list = cells.get(key);
        if (list) list.push(entry);
        else cells.set(key, [entry]);
      }
    }
  };
  plan.lines.forEach((line, li) => {
    line.bays.forEach((b, bi) => add(li, bi, b.x0, b.x1, b.z0, b.z1));
    line.legs.forEach((leg, gi) => {
      const [x0, x1, z0, z1] = leg.longAxis === 0 ? [leg.a0, leg.a1, leg.b0, leg.b1] : [leg.b0, leg.b1, leg.a0, leg.a1];
      add(li, gi, x0, x1, z0, z1);
    });
  });
  return {
    at(x: number, z: number) {
      for (const e of cells.get(Math.floor(z / CELL) * 65536 + Math.floor(x / CELL)) ?? []) {
        if (x >= e.x0 && x < e.x1 && z >= e.z0 && z < e.z1) return { line: e.line, bay: e.bay };
      }
      return null;
    },
  };
}
