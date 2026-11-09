/**
 * A map's shell field (net/shelling.ts ShellField): what the room's shelling needs of a world it
 * cannot generate. Each map's is pinned in net/shell-fields.ts, and the whole-world tests hold the
 * pin to this, as the worlds' fingerprints are held.
 *
 * - The lines: both sides' front and support lines, each across x at its planned z (as
 *   combat/artillery.ts planShellSource takes it, the bays' meander ignored), over its extent.
 * - No man's land: between the two fronts, `nmlInsetM` in from each.
 * - The starts: Red's, then Blue's, as (x, z).
 *
 * Everything in metres, to the centimetre.
 */

import { SHELLING, type ShellField } from '../../net/shelling';
import type { WorldPlan } from './plan';
import type { Spawn } from './spawn';

const cm = (m: number) => Math.round(m * 100) / 100;

export function shellField(plan: WorldPlan, starts: { red: readonly Spawn[]; blue: readonly Spawn[] }): ShellField {
  const v = plan.params.voxel;
  const lines = plan.lines
    .filter((l) => l.spec.longAxis === 0 && /(^|_)(front|support)$/.test(l.spec.name))
    .map((l) => ({ z: cm(l.spec.crossBase * v), x0: cm(l.spec.aStart * v), x1: cm(l.spec.aEnd * v) }));
  const front = (name: string) => {
    const line = plan.lines.find((l) => l.spec.name === name);
    if (!line) throw new Error(`the plan has no '${name}' line, so no no man's land`);
    return line.spec.crossBase * v;
  };
  const [ours, theirs] = [front('front'), front('enemy_front')];
  return {
    size: [cm(plan.params.dims.x * v), cm(plan.params.dims.z * v)],
    lines,
    nml: [cm(Math.min(ours, theirs) + SHELLING.nmlInsetM), cm(Math.max(ours, theirs) - SHELLING.nmlInsetM)],
    spawns: [...starts.red, ...starts.blue].map((s): [number, number] => [cm(s.position[0]), cm(s.position[2])]),
  };
}
