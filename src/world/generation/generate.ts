/**
 * The whole pipeline: fill every band (in workers, or in-process for tests),
 * assemble, mirror the bands' GPU records, run the load-time events and
 * re-encode what they touched, pick the spawn, build the far field. Each phase
 * is timed, because load time is a budget.
 */

import type { BrickMap } from '../bricks';
import { HeapMirror } from '../encode';
import { assemble } from './assemble';
import { applyEvents } from './events';
import { buildFarField, type FarField } from './farfield';
import { BAND, type BandResult } from './fill';
import type { WorldPlan } from './plan';
import { pickSpawn, type Spawn } from './spawn';

export interface GeneratedWorld {
  plan: WorldPlan;
  map: BrickMap;
  /** The GPU's view of `map`, settled: no edits pending. */
  mirror: HeapMirror;
  spawn: Spawn;
  farField: FarField;
  timings: Record<string, number>;
}

export async function generateWorld(
  plan: WorldPlan,
  runBands: (bands: number[]) => Promise<BandResult[]>,
  farField?: () => Promise<FarField>,
): Promise<GeneratedWorld> {
  const timings: Record<string, number> = {};
  const time = async <T>(name: string, work: () => T | Promise<T>): Promise<T> => {
    const t0 = performance.now();
    const out = await work();
    timings[name] = Math.round(performance.now() - t0);
    return out;
  };
  const bandCount = plan.params.dims.x / BAND;
  const all = Array.from({ length: bandCount }, (_, i) => i);
  const farPromise = farField ? time('farField', farField) : null;
  // It is awaited last; a failure before then is reported there, not as unhandled.
  farPromise?.catch(() => {});
  const bands = await time('fill', () => runBands(all));
  bands.sort((a, b) => a.band - b.band);
  const map = await time('assemble', () => assemble(plan, bands));
  const mirror = await time('encode', () => HeapMirror.fromBands(map, bands));
  await time('events', () => {
    applyEvents(map, plan);
    mirror.update(map.takeDirty());
    for (const edit of mirror.takeEdits()) mirror.release(edit.retire);
  });
  const spawn = await time('spawn', () => pickSpawn(map, plan));
  const far = farPromise ? await farPromise : await time('farField', () => buildFarField(plan));
  return { plan, map, mirror, spawn, farField: far, timings };
}
