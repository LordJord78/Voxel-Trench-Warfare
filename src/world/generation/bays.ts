import type { WorldPlan } from './plan';
import type { BayPlan } from './trenches';

/** Every bay of every line, in plan order; a bay's index here is its global id. */
export function bayList(plan: WorldPlan): BayPlan[] {
  return plan.lines.flatMap((line) => line.bays);
}
