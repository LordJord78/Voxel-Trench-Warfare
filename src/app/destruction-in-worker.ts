/**
 * The session's craters cut in a worker (the spec's §3): each request goes with
 * its region copy's buffers transferred, and each result comes back with its
 * bricks' bytes, to be taken at the next tick. A worker that cannot start runs
 * every job in-process instead; one that fails, or a job that throws in it,
 * hands the session back the job's region to copy and post again, in-process
 * from then on. Either way it warns once, and shells still land: a frame pays
 * for each crater.
 */

import { inProcessRunner, type DetonationRunner } from '../sim/destruction';
import { BRICK } from '../world/bricks';
import type { DetonationRequest, DetonationResult } from '../world/detonation';
import type { Box } from '../world/region';

export function workerRunner(): DetonationRunner & { terminate(): void } {
  const done: DetonationResult[] = [];
  /** Each job out with the worker: the region its copy was taken from. */
  const out = new Map<number, Box>();
  const local = inProcessRunner();
  let worker: Worker | null = null;
  const fallBack = (reason: string) => {
    console.warn(`[destruction] in-process: ${reason}`);
    worker?.terminate();
    worker = null;
    // Their copies went to the worker: the session copies those regions again.
    for (const [id, wider] of out) done.push({ id, wider });
    out.clear();
  };
  try {
    worker = new Worker(new URL('./workers/destruction-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ type: 'result'; result: DetonationResult } | { type: 'failed'; id: number; message: string }>) => {
      const m = event.data;
      if (m.type === 'result') {
        out.delete(m.result.id);
        done.push(m.result);
      } else fallBack(`a job failed in the worker: ${m.message}`);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fallBack(`the worker failed: ${event.message}`);
    };
  } catch (e) {
    worker = null;
    console.warn(`[destruction] in-process: no worker (${e instanceof Error ? e.message : String(e)})`);
  }
  return {
    post(req: DetonationRequest) {
      if (!worker) {
        local.post(req);
        return;
      }
      const { origin, size } = req.copy;
      out.set(req.id, { x0: origin[0] * BRICK, y0: 0, z0: origin[2] * BRICK, x1: (origin[0] + size[0]) * BRICK, y1: size[1] * BRICK, z1: (origin[2] + size[2]) * BRICK });
      worker.postMessage(req, [req.copy.entries.buffer as ArrayBuffer, req.copy.dense.buffer as ArrayBuffer]);
    },
    take() {
      return [...done.splice(0), ...local.take()];
    },
    terminate() {
      worker?.terminate();
      worker = null;
    },
  };
}
