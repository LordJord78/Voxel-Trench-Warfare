/**
 * Generate the world across a pool of workers: bands and far-field rows go
 * into one queue, and each worker takes the next job as it finishes, so the
 * load spreads evenly however fast each core is. The result does not depend
 * on any of that: every job is a pure function of the plan.
 */

import { loadTunables } from '../core/tunables';
import { emptyFarField, type FarField } from '../world/generation/farfield';
import type { BandResult } from '../world/generation/fill';
import { generateWorld, type GeneratedWorld } from '../world/generation/generate';
import { genParams } from '../world/generation/params';
import { planWorld, type WorldPlan } from '../world/generation/plan';

export type Progress = (phase: string, done: number, total: number) => void;

type Job = { type: 'band'; band: number } | { type: 'farfield'; row0: number; row1: number };

export async function generateInWorkers(seed: number, onProgress?: Progress): Promise<GeneratedWorld> {
  const t0 = performance.now();
  const plan: WorldPlan = planWorld(genParams(loadTunables()), seed);
  const planMs = Math.round(performance.now() - t0);
  const count = Math.min(8, Math.max(1, (navigator.hardwareConcurrency || 4) - 1));
  const workers = Array.from({ length: count }, () => new Worker(new URL('./workers/gen-worker.ts', import.meta.url), { type: 'module' }));
  for (const w of workers) w.postMessage({ type: 'plan', plan });

  const far = emptyFarField(plan);
  const rowsPerJob = 128;
  let farDone!: (ff: FarField) => void;
  let farFail!: (error: Error) => void;
  const farReady = new Promise<FarField>((resolve, reject) => {
    farDone = resolve;
    farFail = reject;
  });

  const run = (jobs: Job[], onResult: (data: any) => void, phase: string): Promise<void> =>
    new Promise((resolve, reject) => {
      let next = 0;
      let done = 0;
      const feed = (w: Worker) => {
        if (next >= jobs.length) return;
        const job = jobs[next];
        w.postMessage({ ...job, id: next });
        next++;
      };
      for (const w of workers) {
        w.onmessage = (event) => {
          onResult(event.data);
          done++;
          onProgress?.(phase, done, jobs.length);
          if (done === jobs.length) resolve();
          else feed(w);
        };
        w.onerror = (event) => reject(new Error(`generation worker failed: ${event.message}`));
        w.onmessageerror = () => reject(new Error('a generation worker sent a message that could not be read'));
        feed(w);
      }
    });

  try {
    const world = await generateWorld(
      plan,
      async (bands) => {
        const results: BandResult[] = [];
        await run(bands.map((band) => ({ type: 'band', band }) as Job), (data) => results.push(data.result), 'fill');
        const rows: Job[] = [];
        for (let row = 0; row < far.size; row += rowsPerJob) rows.push({ type: 'farfield', row0: row, row1: Math.min(far.size, row + rowsPerJob) });
        void run(rows, (data) => {
          far.height.set(data.height, data.row0 * far.size);
          far.material.set(data.material, data.row0 * far.size);
        }, 'farfield').then(() => farDone(far), farFail);
        return results;
      },
      () => farReady,
    );
    world.timings.plan = planMs;
    return world;
  } finally {
    for (const w of workers) w.terminate();
  }
}
