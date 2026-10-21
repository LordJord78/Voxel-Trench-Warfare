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
        if (v === P.TIMBER || v === P.TIMBER_WEATHERED || v === P.TIMBER_DARK) timber++;
      }
    }
  }
  return total === 0 ? 0 : timber / total;
}

export function pickSpawn(map: BrickMap, plan: WorldPlan): Spawn {
  const p = plan.params;
  const front = plan.lines.find((l) => l.spec.name === 'front') ?? plan.lines[0];
  const bays = front.bays;
  const middle = bays.length >> 1;
  const order = bays.map((_, i) => i).sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle) || a - b);
  const headroom = vx(2.0, p.voxel);
  const at = (bay: BayPlan, x: number, z: number): Spawn => ({
    position: [(x + 0.5) * p.voxel, (bay.floorY + 1) * p.voxel + 0.05, (z + 0.5) * p.voxel],
    bay,
  });
  for (const i of order) {
    const bay = bays[i];
    const z = Math.floor(bay.walkZ);
    for (const x of [Math.floor(bay.walkX), Math.floor(bay.walkX) + 1, Math.floor(bay.walkX) - 1]) {
      const deck = map.get(x, bay.floorY, z);
      if (deck !== P.DUCKBOARD && deck !== P.DUCKBOARD_WORN) continue;
      let clear = true;
      for (let k = 1; k <= headroom && clear; k++) clear = map.get(x, bay.floorY + k, z) === P.AIR;
      if (!clear) continue;
      if (bay.firingSteps && benchIntact(map, bay, p.trench.bench) < 0.5) break;
      return at(bay, x, z);
    }
  }
  const bay = bays[middle];
  return at(bay, Math.floor(bay.walkX), Math.floor(bay.walkZ));
}
