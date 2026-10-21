/**
 * The event phase: what happens to the world at load that is honestly three-
 * dimensional. Direct hits on the trench lines go through the same detonation
 * a shell uses in battle, so a breach cut at load behaves like one cut later.
 */

import { Rng } from '../../core/rng';
import type { BrickMap } from '../bricks';
import { detonate } from '../destruction';
import type { WorldPlan } from './plan';

/** Detonate every planned direct hit, in plan order; returns how many landed. */
export function applyEvents(map: BrickMap, plan: WorldPlan): number {
  const p = plan.params;
  let landed = 0;
  for (const hit of plan.direct) {
    const box = detonate(map, hit.x, hit.y, hit.z, hit.r, Rng.root(hit.seed), {
      hardLimit: p.destruction.hardLimit,
      core: p.destruction.core,
      loosen: p.destruction.loosen,
      waterTable: p.waterTable,
    });
    if (box) landed++;
  }
  return landed;
}
