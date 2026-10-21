/**
 * The world plan: every decision generation makes that is not per-voxel.
 *
 * Built once from the parameters and the seed, it is small enough to send to
 * every worker, and complete enough that a worker filling any band needs
 * nothing else. Every random stream derives from the root by label, so adding
 * a feature never shifts the numbers another feature receives.
 */

import { Rng } from '../../core/rng';
import { planCraters, type Crater, type DirectHit } from './craters';
import type { GenParams } from './params';
import { buildTerrain, surfaceAt, type TerrainModel } from './terrain';
import { planProps, propHits, structureFootprints } from './props';
import { planDugout, planLine, type DugoutPlan, type LinePlan } from './trenches';

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
}

export function planWorld(params: GenParams, seed: number): WorldPlan {
  const root = Rng.root(seed);
  const terrain = buildTerrain(params, root);
  const surface = (x: number, z: number) => surfaceAt(terrain, params, x, z);
  // Each line sees the lines before it: a communication trench meets their floors.
  const lines: LinePlan[] = [];
  for (const spec of params.lines) lines.push(planLine(params, spec, surface, root.derive(`trench.${spec.name}`), lines));
  placeDugouts(params, lines);
  const fronts = lines
    .filter((l) => l.spec.firingSteps)
    .map((l) => ({ z: l.spec.crossBase, facing: l.spec.facing }));
  const { open, direct } = planCraters(params, terrain, root.derive('craters'), fronts);
  const plan: WorldPlan = { seed, params, terrain, craters: open, direct, lines, props: [] };
  plan.props = planProps(plan, root);
  // Nothing built stands over an open crater: those that would reach a structure are not dug.
  // This runs before anything asks for the ground, which the crater list shapes.
  const structures = structureFootprints(plan, false);
  plan.craters = open.filter((c) => {
    const reach = Math.ceil(1.4 * c.r) + 1;
    return !structures.some((s) => c.x - reach < s.x1 && s.x0 < c.x + reach && c.z - reach < s.z1 && s.z0 < c.z + reach);
  });
  plan.direct = [...direct, ...propHits(plan)];
  return plan;
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
