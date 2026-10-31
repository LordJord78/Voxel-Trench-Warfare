/**
 * Where the player starts: Python's `_pick_spawn`. Direct hits are aimed at
 * the front line on purpose, so the middle bay is sometimes a hole with its
 * firing step shot away — a fine bay to fight over and a poor one to start
 * in. Search outward from the middle for a bay that still works.
 */

import type { BrickMap } from '../bricks';
import { P } from '../materials';
import { vx } from './params';
import type { WorldPlan } from './plan';
import type { BayPlan } from './trenches';

export interface Spawn {
  /** Foot centre, in metres. */
  position: [number, number, number];
  bay: BayPlan;
}

function benchIntact(map: BrickMap, bay: BayPlan, bench: number): number {
  let timber = 0;
  let total = 0;
  for (let a = bay.a0; a < bay.a1; a++) {
    for (let b = bay.stepLo; b < bay.stepLo + bench; b++) {
      for (let y = bay.floorY + 1; y < bay.stepTopY; y++) {
        const [x, z] = bay.longAxis === 0 ? [a, b] : [b, a];
        const v = map.get(x, y, z);
        total++;
        if (v === P.TIMBER || v === P.TIMBER_WEATHERED || v === P.TIMBER_DARK || v === P.BENCH) timber++;
      }
    }
  }
  return total === 0 ? 0 : timber / total;
}

/** Where to start in a bay: duckboard underfoot, 2 m of air over it, and its firing step (if it has one) mostly standing; or null. */
function inBay(map: BrickMap, plan: WorldPlan, bay: BayPlan): Spawn | null {
  const p = plan.params;
  const headroom = vx(2.0, p.voxel);
  const z = Math.floor(bay.walkZ);
  for (const x of [Math.floor(bay.walkX), Math.floor(bay.walkX) + 1, Math.floor(bay.walkX) - 1]) {
    const deck = map.get(x, bay.floorY, z);
    if (deck !== P.DUCKBOARD && deck !== P.DUCKBOARD_WORN) continue;
    let clear = true;
    for (let k = 1; k <= headroom && clear; k++) clear = map.get(x, bay.floorY + k, z) === P.AIR;
    if (!clear) continue;
    if (bay.firingSteps && benchIntact(map, bay, p.trench.bench) < 0.5) return null;
    return at(plan, bay, x, z);
  }
  return null;
}

function at(plan: WorldPlan, bay: BayPlan, x: number, z: number): Spawn {
  const v = plan.params.voxel;
  return { position: [(x + 0.5) * v, (bay.floorY + 1) * v + 0.05, (z + 0.5) * v], bay };
}

/** A line's bays, the middle one first and then outward, the nearer to the start first on a tie. */
function outward(plan: WorldPlan, line: string): BayPlan[] {
  const found = plan.lines.find((l) => l.spec.name === line) ?? plan.lines[0];
  const middle = found.bays.length >> 1;
  return found.bays.map((_, i) => i).sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle) || a - b).map((i) => found.bays[i]);
}

export function pickSpawn(map: BrickMap, plan: WorldPlan): Spawn {
  const bays = outward(plan, 'front');
  for (const bay of bays) {
    const s = inBay(map, plan, bay);
    if (s) return s;
  }
  const bay = bays[0];
  return at(plan, bay, Math.floor(bay.walkX), Math.floor(bay.walkZ));
}

/**
 * Up to `count` places a team starts from (the multiplayer spec's §4), in line `line`'s bays that
 * still work, the middle bay's first and a bay apiece; fewer only if the line has fewer.
 */
export function pickSpawns(map: BrickMap, plan: WorldPlan, line: string, count: number): Spawn[] {
  const out: Spawn[] = [];
  for (const bay of outward(plan, line)) {
    if (out.length >= count) break;
    const s = inBay(map, plan, bay);
    if (s) out.push(s);
  }
  if (out.length === 0) {
    const bay = outward(plan, line)[0];
    out.push(at(plan, bay, Math.floor(bay.walkX), Math.floor(bay.walkZ)));
  }
  return out;
}

/** The way a bay's soldiers face: toward the enemy, over their parapet (degrees, as the views'). */
export function facingYaw(bay: BayPlan): number {
  return bay.longAxis === 0 ? (bay.facing > 0 ? 0 : 180) : bay.facing > 0 ? 90 : -90;
}
