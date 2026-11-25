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
 *
 * A catch-up cuts ahead only while the runner can run a job beside the
 * session's (`parallel`, `aheadOn`): in-process, or with no pool, none. A pool
 * worker that fails, or a job that throws in one, ends only the pool: the jobs
 * out on it are handed back, none is cut ahead again until `rest`, and the
 * session's worker runs on. A job sent ahead with nowhere else to go goes to the
 * session's worker, never dropped: its shell's job may take its work over.
 */

import { inProcessRunner, type DetonationRunner } from '../sim/destruction';
import type { DetonationRequest, DetonationResult } from '../world/detonation';
import type { Box } from '../world/region';
import { copyBox } from '../world/region-copy';

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

/** The page's runner: the session's worker, and a pool for the craters a catch-up cuts ahead of their turn. */
export interface PageRunner extends DetonationRunner {
  /**
   * How many workers it runs beside the session's for craters cut ahead of their turn: its pool's,
   * made or still to be made; none in-process, with no pool, or once its pool has failed (until `rest`).
   */
  readonly parallel: number;
  terminate(): void;
  /** The pool let go, a catch-up done with it: the next job cut ahead makes it again. */
  rest(): void;
  readonly stats: RunnerStats;
}

/**
 * How many of a catch-up's next shells to have cut ahead of their turn on `runner`: `most` ([room_battle]
 * catch_up_ahead) if it runs a worker beside the session's, else none. In-process, a job sent ahead
 * would be cut at once, on the page (8 craters of some 200 ms in one task); with no pool, it would
 * queue on the session's one worker in front of the next shell's own job, for nothing.
 */
export function aheadOn(runner: DetonationRunner & { readonly parallel?: number }, most: number): number {
  return (runner.parallel ?? 0) >= 1 ? most : 0;
}

/** The session's worker, and `pool` more for the craters a catch-up cuts ahead of their turn. */
export function workerRunner(pool = 0): PageRunner {
  const done: DetonationResult[] = [];
  /** Each job out with a worker: the region its copy was taken from, the worker it is on, whether that is the pool's, and when it was posted (performance.now). */
  const out = new Map<number, { box: Box; on: Worker; pooled: boolean; at: number }>();
  const stats: RunnerStats = { jobs: 0, jobMs: 0, tripMs: 0 };
  const local = inProcessRunner();
  let worker: Worker | null = null;
  /** The pool, made at the first job sent ahead (none if `pool` is 0, it cannot start, or it failed, until `rest`); and the jobs out with each. */
  let ahead: Worker[] | null = pool > 0 ? null : [];
  const load = new Map<Worker, number>();
  /** Whether `w` is one of this runner's workers still: one let go says nothing more. */
  const ours = (w: Worker) => w === worker || (ahead?.includes(w) ?? false);
  /**
   * Each job out on the pool handed back, never dropped: its copy went with it, so the session copies
   * that region again and posts it again (sim/destruction.ts: a job sent ahead is cut again in its
   * shell's turn, on the copy it was given, or dropped with the catch-up).
   */
  const handBack = (only: (job: { pooled: boolean }) => boolean) => {
    for (const [id, job] of out) {
      if (!only(job)) continue;
      out.delete(id);
      done.push({ id, wider: job.box });
    }
  };
  /** The pool let go, the jobs out on it handed back. */
  const letPoolGo = () => {
    for (const w of ahead ?? []) w.terminate();
    load.clear();
    handBack((job) => job.pooled);
  };
  const rest = () => {
    letPoolGo();
    ahead = pool > 0 ? null : [];
  };
  /** A pool worker failed: the pool goes, and none is made again until `rest`; the session's worker runs on. */
  const poolFailed = (reason: string) => {
    console.warn(`[destruction] no pool for the rest of this catch-up: ${reason}`);
    letPoolGo();
    ahead = [];
  };
  const fallBack = (reason: string) => {
    console.warn(`[destruction] in-process: ${reason}`);
    worker?.terminate();
    worker = null;
    letPoolGo();
    ahead = [];
    // Their copies went to the worker: the session copies those regions again, and posts them in-process.
    handBack(() => true);
  };
  /** `w`'s results taken in, and its failure `fail`'s: the session's worker's falls back, a pool worker's ends the pool. */
  const listen = (w: Worker, fail: (reason: string) => void) => {
    w.onmessage = (event: MessageEvent<FromWorker>) => {
      if (!ours(w)) return;
      const m = event.data;
      if (m.type === 'failed') return fail(`a job failed in the worker: ${m.message}`);
      // A cut comes first; the job is out with its worker until its settled crater, or a wider region, comes back.
      const job = out.get(m.result.id);
      if (!job || job.on !== w) return;
      if (!('stage' in m.result) || m.result.stage === 'settled') {
        out.delete(m.result.id);
        if (job.pooled) load.set(w, load.get(w)! - 1);
        stats.jobs++;
        stats.jobMs += m.ms;
        stats.tripMs += performance.now() - job.at - m.ms;
      }
      done.push(m.result);
    };
    w.onerror = (event) => {
      event.preventDefault();
      if (ours(w)) fail(`the worker failed: ${event.message}`);
    };
    return w;
  };
  try {
    worker = listen(spawn(), fallBack);
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
        while (made.length < pool) made.push(listen(spawn(), poolFailed));
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
      // Only a crater cut ahead goes to the pool; with none (a page of two cores, or one whose pool
      // failed) it goes to the session's worker all the same, never dropped: its shell's job may take
      // its work over, and wait for it.
      const to = req.id < 0 ? pooled() : null;
      const on = to ?? worker;
      out.set(req.id, { box: copyBox(req.copy), on, pooled: to !== null, at: performance.now() });
      if (to) load.set(to, load.get(to)! + 1);
      on.postMessage(req, [req.copy.entries.buffer as ArrayBuffer, req.copy.dense.buffer as ArrayBuffer]);
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
    get parallel() {
      return worker ? (ahead?.length ?? pool) : 0;
    },
  };
}
