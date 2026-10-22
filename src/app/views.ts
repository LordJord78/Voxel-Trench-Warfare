/**
 * The six standard views the spec names, from the plan: where the perf runs
 * and the screenshot set stand. Metres and degrees; `hours`, the clock's hour
 * each is seen at (dusk, but no man's land at night).
 */

import { CLOCK_KEYS } from '../core/sky-clock';
import type { CameraPose } from '../render/camera';
import { columnTopAt } from '../world/generation/columns';
import type { WorldPlan } from '../world/generation/plan';
import type { Spawn } from '../world/generation/spawn';

export const VIEW_NAMES = ['bay', 'step', 'nml-night', 'overview', 'dugout', 'hamlet'] as const;
export type ViewName = (typeof VIEW_NAMES)[number];

export interface View extends CameraPose {
  hours: number;
}

const DEG = 180 / Math.PI;

export function standardViews(plan: WorldPlan, spawn: Pick<Spawn, 'position' | 'bay'>): Record<ViewName, View> {
  const p = plan.params;
  const v = p.voxel;
  const eye = p.eye.standing * v;
  const bay = spawn.bay;
  const xz = (a: number, b: number): [number, number] => (bay.longAxis === 0 ? [a, b] : [b, a]);
  const ground = (x: number, z: number) => columnTopAt(plan, x / v, z / v) * v;
  const facing = (fromX: number, fromZ: number, toX: number, toZ: number) => Math.atan2(toX - fromX, toZ - fromZ) * DEG;

  const [sx, sz] = xz((bay.a0 + bay.a1) / 2, bay.stepLo + bay.stepSpan / 2);
  const front = plan.lines.find((l) => l.spec.firingSteps && l.spec.side === 0) ?? plan.lines[0];
  const dugout = front.dugouts[0] ?? plan.lines.flatMap((l) => l.dugouts)[0];
  const dcx = ((dugout.lo[0] + dugout.hi[0]) / 2) * v;
  const dcz = ((dugout.lo[2] + dugout.hi[2]) / 2) * v;
  const ex = dugout.entrance[0] * v;
  const ez = dugout.entrance[2] * v;
  const nmlZ = ((p.layout.front + p.layout.enemyFront) / 2) * v;
  const mid = (p.dims.x / 2) * v;
  const hamletZ = ((p.layout.hamlet[0] + p.layout.hamlet[1]) / 2) * v;
  const church = plan.props.find((q) => q.kind === 'church');

  return {
    bay: { position: [spawn.position[0], spawn.position[1] + eye, spawn.position[2]], yaw: bay.longAxis === 0 ? 90 : 0, pitch: -4, hours: CLOCK_KEYS.dusk },
    step: { position: [sx * v, bay.stepTopY * v + eye, sz * v], yaw: bay.facing > 0 ? 0 : 180, pitch: 0, hours: CLOCK_KEYS.dusk },
    'nml-night': { position: [mid, ground(mid, nmlZ) + eye, nmlZ], yaw: 0, pitch: 0, hours: CLOCK_KEYS.night },
    overview: { position: [mid, 48, p.layout.reserve * v - 30], yaw: 0, pitch: -22, hours: CLOCK_KEYS.dusk },
    // Just inside the curtain, looking across the chamber at the lantern on the back wall.
    dugout: {
      position: [dcx + (ex - dcx) * 0.6, (dugout.dugFloor + 1) * v + eye, dcz + (ez - dcz) * 0.6],
      yaw: facing(ex, ez, dcx, dcz),
      pitch: -8,
      hours: CLOCK_KEYS.dusk,
    },
    hamlet: {
      position: [mid, ground(mid, hamletZ) + eye, hamletZ],
      yaw: church ? facing(mid, hamletZ, church.x * v, church.z * v) : 0,
      pitch: 4,
      hours: CLOCK_KEYS.dusk,
    },
  };
}
