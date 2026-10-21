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
import { planLine, type BayPlan, type LinePlan } from './trenches';

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
  const lines = params.lines.map((spec) => planLine(params, spec, surface, root.derive(`trench.${spec.name}`)));
  const fronts = lines
    .filter((l) => l.spec.firingSteps)
    .map((l) => ({ z: l.spec.crossBase, facing: l.spec.facing }));
  const { open, direct } = planCraters(params, terrain, root.derive('craters'), fronts);
  return { seed, params, terrain, craters: open, direct, lines, props: [] };
}

/** Every bay of every line, in plan order; a bay's index here is its global id. */
export function bayList(plan: WorldPlan): BayPlan[] {
  return plan.lines.flatMap((line) => line.bays);
}

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
