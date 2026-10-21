/**
 * A generation worker: fills the bands and far-field rows it is handed and
 * sends them back as transferred buffers. Everything it computes is a pure
 * function of the plan, so which worker draws what never changes the world.
 */

import { emptyFarField, farFieldRows } from '../../world/generation/farfield';
import { fillBand } from '../../world/generation/fill';
import type { WorldPlan } from '../../world/generation/plan';

type Job =
  | { type: 'band'; id: number; plan: WorldPlan; band: number }
  | { type: 'farfield'; id: number; plan: WorldPlan; row0: number; row1: number };

let plan: WorldPlan | null = null;

self.onmessage = (event: MessageEvent<Job | { type: 'plan'; plan: WorldPlan }>) => {
  const job = event.data;
  if (job.type === 'plan') {
    plan = job.plan;
    return;
  }
  const p = job.plan ?? plan!;
  if (job.type === 'band') {
    const result = fillBand(p, job.band);
    (self as unknown as Worker).postMessage({ type: 'band', id: job.id, result }, [result.table.buffer, result.dense.buffer, result.denseBricks.buffer, result.records.buffer, result.formats.buffer]);
    return;
  }
  const ff = emptyFarField(p);
  farFieldRows(p, job.row0, job.row1, ff);
  const n = ff.size;
  const height = ff.height.slice(job.row0 * n, job.row1 * n);
  const material = ff.material.slice(job.row0 * n, job.row1 * n);
  (self as unknown as Worker).postMessage({ type: 'farfield', id: job.id, row0: job.row0, row1: job.row1, height, material }, [height.buffer, material.buffer]);
};
