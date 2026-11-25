/**
 * The session's craters cut in a worker (the spec's §3): each request goes with
 * its region copy's buffers transferred, and each result comes back with its
 * bricks' bytes, to be taken at the next tick. A worker that cannot start runs
 * every job in-process instead; one that fails, or a job that throws in it,
 * hands the session back the job's region to copy and post again, in-process
 * from then on. Either way it warns once, and shells still land: a frame pays
 * for each crater.
 *
 * A catch-up's craters cut ahead of their turn (sim/destruction.ts `ahead`, a
 * request with a negative id) go to a pool of `pool` more workers, made at the
 * first, each to the one with the fewest out, and `rest` lets the pool go once
 * the catch-up is done with it. Every worker runs the same job
 * (world/detonation.ts), so a crater is the same whichever cut it. The
 * session's own jobs keep the one worker, in the order they are posted, as
 * before: a page at play cuts and lands its craters as it did.
 */

import { inProcessRunner, type DetonationRunner } from '../sim/destruction';
import { BRICK } from '../world/bricks';
import type { DetonationRequest, DetonationResult } from '../world/detonation';
import type { Box } from '../world/region';

/**
 * What the workers have handed back, for the page's profile of a catch-up: their jobs done (a settled
 * crater, or a wider region asked for), the ms they ran in a worker, and the ms beyond that from each
 * post to its result taken in here (the copy's transfer, the queue in the worker, the page busy).
 */
export interface RunnerStats {
  jobs: number;
  jobMs: number;
  tripMs: number;
}

type FromWorker = { type: 'result'; result: DetonationResult; ms: number } | { type: 'failed'; id: number; message: string };

const spawn = () => new Worker(new URL('./workers/destruction-worker.ts', import.meta.url), { type: 'module' });

/** The session's worker, and `pool` more for the craters a catch-up cuts ahead of their turn. */
export function workerRunner(pool = 0): DetonationRunner & { terminate(): void; rest(): void; readonly stats: RunnerStats } {
  const done: DetonationResult[] = [];
  /** Each job out with a worker: the region its copy was taken from, the worker (null: the session's), and when it was posted (performance.now). */
  const out = new Map<number, { box: Box; worker: Worker | null; at: number }>();
  const stats: RunnerStats = { jobs: 0, jobMs: 0, tripMs: 0 };
  const local = inProcessRunner();
  let worker: Worker | null = null;
  /** The pool, made at the first job sent ahead (none if `pool` is 0, or it cannot start); and the jobs out with each. */
  let ahead: Worker[] | null = pool > 0 ? null : [];
  const load = new Map<Worker, number>();
  const rest = () => {
    for (const w of ahead ?? []) w.terminate();
    for (const [id, job] of out) if (job.worker) out.delete(id);
    ahead = pool > 0 ? null : [];
    load.clear();
  };
  const fallBack = (reason: string) => {
    console.warn(`[destruction] in-process: ${reason}`);
    worker?.terminate();
    worker = null;
    for (const w of ahead ?? []) w.terminate();
    ahead = [];
    load.clear();
    // Their copies went to the workers: the session copies those regions again (one sent ahead, once its shell's job takes it up).
    for (const [id, { box }] of out) done.push({ id, wider: box });
    out.clear();
  };
  const listen = (w: Worker) => {
    w.onmessage = (event: MessageEvent<FromWorker>) => {
      const m = event.data;
      if (m.type === 'failed') return fallBack(`a job failed in the worker: ${m.message}`);
      // A cut comes first; the job is out with its worker until its settled crater, or a wider region, comes back.
      const job = out.get(m.result.id);
      if (!job) return;
      if (!('stage' in m.result) || m.result.stage === 'settled') {
        out.delete(m.result.id);
        if (job.worker) load.set(job.worker, load.get(job.worker)! - 1);
        stats.jobs++;
        stats.jobMs += m.ms;
        stats.tripMs += performance.now() - job.at - m.ms;
      }
      done.push(m.result);
    };
    w.onerror = (event) => {
      event.preventDefault();
      fallBack(`the worker failed: ${event.message}`);
    };
    return w;
  };
  try {
    worker = listen(spawn());
  } catch (e) {
    worker = null;
    ahead = [];
    console.warn(`[destruction] in-process: no worker (${e instanceof Error ? e.message : String(e)})`);
  }
  /** The pool worker with the fewest jobs out, the pool made first if it is not yet; null with none. */
  const pooled = (): Worker | null => {
    if (!ahead) {
      const made: Worker[] = [];
      try {
        while (made.length < pool) made.push(listen(spawn()));
      } catch (e) {
        for (const w of made.splice(0)) w.terminate();
        console.warn(`[destruction] no pool for a catch-up (${e instanceof Error ? e.message : String(e)})`);
      }
      ahead = made;
      for (const w of ahead) load.set(w, 0);
    }
    let best: Worker | null = null;
    for (const w of ahead) if (!best || load.get(w)! < load.get(best)!) best = w;
    return best;
  };
  return {
    post(req: DetonationRequest) {
      if (!worker) {
        local.post(req);
        return;
      }
      const to = req.id < 0 ? pooled() : null;
      const { origin, size } = req.copy;
      out.set(req.id, { box: { x0: origin[0] * BRICK, y0: 0, z0: origin[2] * BRICK, x1: (origin[0] + size[0]) * BRICK, y1: size[1] * BRICK, z1: (origin[2] + size[2]) * BRICK }, worker: to, at: performance.now() });
      if (to) load.set(to, load.get(to)! + 1);
      (to ?? worker).postMessage(req, [req.copy.entries.buffer as ArrayBuffer, req.copy.dense.buffer as ArrayBuffer]);
    },
    take() {
      return [...done.splice(0), ...local.take()];
    },
    terminate() {
      worker?.terminate();
      worker = null;
      rest();
      ahead = [];
    },
    rest,
    stats,
  };
}
