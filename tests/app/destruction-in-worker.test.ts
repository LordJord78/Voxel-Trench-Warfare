import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aheadOn, workerRunner } from '../../src/app/destruction-in-worker';
import { packCell } from '../../src/combat/entrenching';
import { loadTunables } from '../../src/core/tunables';
import type { Dig, MatchLog, RoomShell } from '../../src/net/protocol';
import { inProcessRunner, type Destruction, type DetonationRunner } from '../../src/sim/destruction';
import { BrickMap } from '../../src/world/bricks';
import { detonationRegion, runDetonation, type DetonationRequest, type DetonationResult } from '../../src/world/detonation';
import { P } from '../../src/world/materials';
import { copyRegion } from '../../src/world/region-copy';
import { roomClient, sameWorld, shellOptions, trenchArena, type RoomClient } from '../support/worlds';

// The page's destruction runner (app/destruction-in-worker.ts), with a stand-in for the destruction
// worker: the session's craters stay on its one worker, in the order they are posted, so a live page
// cuts and lands them as it always did; craters a catch-up cuts ahead of their turn go to a pool of
// more, and only where the pool can run them beside the session's worker; and a pool worker that fails
// takes only the pool with it.

const tun = loadTunables();
const V = 0.1;

type Fate = 'run' | 'error' | 'throws' | 'error after its cut';

/**
 * A stand-in for the destruction worker (app/workers/destruction-worker.ts). It keeps what it is
 * posted and moves one message a `step()`: its job's next (the cut, then the settled crater, as the
 * worker sends them), or else it takes up its next job. Each job's fate is `FakeWorker.fate`'s: it
 * runs; the worker errors as it takes it up (onerror); the job throws (a 'failed' message); or the
 * worker errors once it has sent the job's cut. A pool's worker (any but the first made, the
 * session's) steps only while `FakeWorker.poolMay()`.
 */
class FakeWorker {
  static all: FakeWorker[] = [];
  /** Every post, in order: [the worker's index in `all`, the job's id]. */
  static posts: [number, number][] = [];
  static fate: (w: FakeWorker, req: DetonationRequest) => Fate = () => 'run';
  static poolMay: () => boolean = () => true;
  /** The number of posts made when a worker failed. */
  static failedAt: number | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault(): void }) => void) | null = null;
  terminated = false;
  private readonly jobs: DetonationRequest[] = [];
  private readonly outbox: (() => void)[] = [];

  constructor() {
    FakeWorker.all.push(this);
  }

  get index(): number {
    return FakeWorker.all.indexOf(this);
  }

  postMessage(req: DetonationRequest): void {
    if (this.terminated) throw new Error(`job ${req.id} posted to a worker let go`);
    FakeWorker.posts.push([this.index, req.id]);
    this.jobs.push(req);
  }

  terminate(): void {
    this.terminated = true;
    this.jobs.length = 0;
    this.outbox.length = 0;
  }

  step(): void {
    if (this.terminated || (this.index > 0 && !FakeWorker.poolMay())) return;
    if (this.outbox.length === 0) {
      const req = this.jobs.shift();
      if (!req) return;
      const fail = (message: string) => () => {
        FakeWorker.failedAt ??= FakeWorker.posts.length;
        this.onerror?.({ message, preventDefault: () => {} });
      };
      const send = (result: DetonationResult) => () => this.onmessage?.({ data: { type: 'result', result, ms: 1 } });
      const fate = FakeWorker.fate(this, req);
      if (fate === 'error') this.outbox.push(fail('out of memory'));
      else if (fate === 'throws') {
        this.outbox.push(() => {
          FakeWorker.failedAt ??= FakeWorker.posts.length;
          this.onmessage?.({ data: { type: 'failed', id: req.id, message: 'it threw' } });
        });
      } else {
        const sent: DetonationResult[] = [];
        sent.push(runDetonation(req, (cut) => sent.push(cut)));
        if (fate === 'error after its cut') this.outbox.push(send(sent[0]), fail('lost'));
        else this.outbox.push(...sent.map(send));
      }
    }
    this.outbox.shift()!();
  }
}

/** The catch-up's breath: every worker moves a message. */
const breathe = async () => {
  for (const w of [...FakeWorker.all]) w.step();
};

let warned: string[] = [];
beforeEach(() => {
  vi.stubGlobal('Worker', FakeWorker);
  warned = [];
  vi.spyOn(console, 'warn').mockImplementation((m: unknown) => void warned.push(String(m)));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeWorker.all = [];
  FakeWorker.posts = [];
  FakeWorker.fate = () => 'run';
  FakeWorker.poolMay = () => true;
  FakeWorker.failedAt = null;
});

/** A crater's job `id` on the trench arena: its region copied as the world is. */
function job(id: number): DetonationRequest {
  const map = trenchArena();
  const centre: [number, number, number] = [128, 64, 60];
  const box = detonationRegion(map.dims, centre, 8, tun.f('destruction.loosen_radius_scale'))!;
  return { id, centre, radius: 8, seed: 40 + Math.abs(id), options: shellOptions(), copy: copyRegion(map, box), world: map.dims };
}

describe("the destruction runner: which worker cuts what", () => {
  it("keeps the session's craters on its one worker, in the order posted; sends those cut ahead to the pool once it is made; and rest() lets only the pool go", () => {
    const runner = workerRunner(2);
    expect(FakeWorker.all.length).toBe(1);
    runner.post(job(1));
    runner.post(job(2));
    // No pool until the first job cut ahead.
    expect(FakeWorker.all.length).toBe(1);
    runner.post(job(-1));
    expect(FakeWorker.all.length).toBe(3);
    // The session's worker has the most out, and still takes every one of the session's.
    for (const id of [3, -2, 4, -3, 5, -4]) runner.post(job(id));
    const to = (sign: number) => FakeWorker.posts.filter(([, id]) => Math.sign(id) === sign);
    expect(to(1)).toEqual([1, 2, 3, 4, 5].map((id) => [0, id]));
    expect(to(-1).map(([, id]) => id)).toEqual([-1, -2, -3, -4]);
    expect(to(-1).every(([w]) => w === 1 || w === 2)).toBe(true);
    expect(new Set(to(-1).map(([w]) => w)).size).toBe(2);
    runner.rest();
    expect(FakeWorker.all.map((w) => w.terminated)).toEqual([false, true, true]);
    // A later catch-up's pool is made again; the session's worker is the one it was.
    runner.post(job(-5));
    runner.post(job(6));
    expect(FakeWorker.all.length).toBe(5);
    const [[pool, id], last] = FakeWorker.posts.slice(-2);
    expect([pool === 3 || pool === 4, id, last]).toEqual([true, -5, [0, 6]]);
    expect(warned).toEqual([]);
  });

  it("says how many workers it runs beside the session's, so a catch-up cuts ahead only on a pool: none in-process, with no pool, with no Worker, or once its worker has failed", () => {
    expect(aheadOn(inProcessRunner(), 8)).toBe(0);
    const none = workerRunner(0);
    expect([none.parallel, aheadOn(none, 8)]).toEqual([0, 0]);
    const three = workerRunner(3);
    expect(three.parallel).toBe(3);
    expect([aheadOn(three, 8), aheadOn(three, 0)]).toEqual([8, 0]);
    // Its worker fails: every job from then on in-process, and none beside it.
    FakeWorker.fate = () => 'error';
    three.post(job(1));
    FakeWorker.all[FakeWorker.posts.at(-1)![0]].step();
    expect(three.parallel).toBe(0);
    // No Worker at all.
    vi.unstubAllGlobals();
    const noWorker = workerRunner(3);
    expect([noWorker.parallel, aheadOn(noWorker, 8)]).toEqual([0, 0]);
  });

  it('never drops a job cut ahead: with no pool it goes to the session\'s worker, with no worker it is cut in-process, and either way it comes back', () => {
    const results = (r: DetonationRunner) => r.take().map((x) => [x.id, 'stage' in x ? x.stage : 'wider']);
    const noPool = workerRunner(0);
    noPool.post(job(-1));
    expect(FakeWorker.posts).toEqual([[0, -1]]);
    FakeWorker.all[0].step();
    FakeWorker.all[0].step();
    expect(results(noPool)).toEqual([[-1, 'cut'], [-1, 'settled']]);
    vi.unstubAllGlobals();
    const noWorker = workerRunner(2);
    noWorker.post(job(-2));
    expect(results(noWorker)).toEqual([[-2, 'cut'], [-2, 'settled']]);
  });
});

/**
 * A field 76.8 m across, clay to 6.4 m: three columns of ground whose shells' regions are apart (whole
 * sectors, x 0–22.4, 28.8–51.2 and 57.6–76.8 m). A plate of spoil a voxel thick beyond S1's rim, where
 * a scoop is dug after S2 lands, before S3; and a tree's trunk in S2's rim, 3.6–3.8 m west of it,
 * beyond S5's reach (S2's cut makes the rim's trunk branch, and a cut again over that ground would make
 * it air). As tests/sim/room-battle.test.ts's catch-up cut ahead: S3 lands over S1's ground, S5 over S2's.
 */
function field(): BrickMap {
  const map = new BrickMap({ x: 768, y: 128, z: 256 });
  map.fillBox(0, 0, 0, 768, 64, 256, P.CLAY);
  map.fillBox(146, 64, 136, 156, 65, 146, P.SPOIL);
  map.fillBox(362, 64, 127, 364, 72, 129, P.TRUNK);
  map.takeDirty();
  return map;
}
const shell = (id: number, landAt: number, x: number, z: number): RoomShell => ({ id, landAt, at: [x, z], radius: 3, seed: 100 + id });
const SHELLS = [shell(1, 1_000, 10, 12.8), shell(2, 2_000, 40, 12.8), shell(3, 3_000, 12, 12.8), shell(4, 4_000, 70, 12.8), shell(5, 5_000, 42, 12.8)];
const CELLS = [[150, 64, 140], [151, 64, 140], [150, 64, 141]] as const;
const LOG: MatchLog = (() => {
  const dims = field().dims;
  const scoop: Dig = { seat: 1, at: 2_500, cells: CELLS.map(([x, y, z]) => packCell(dims, x, y, z)) };
  return {
    shells: SHELLS.map((s) => [s.id, s.landAt, Math.round(s.at[0] * 1000), Math.round(s.at[1] * 1000), Math.round(s.radius * 1000), s.seed]),
    digs: [[scoop.seat, scoop.at, ...scoop.cells]],
  };
})();

/**
 * A page joining once the field's log is due, caught up as main.ts catches it up: its craters cut by
 * `runner` (in-process if none), the log's next shells cut ahead as `aheadOn` says of it, asked at each
 * send; its breath the workers' messages. The page, and the shells it asked to have cut ahead.
 */
async function caughtUp(runner?: DetonationRunner & { readonly parallel?: number }, ahead?: number, made?: (j: RoomClient) => void) {
  const j = roomClient(field(), [70, 6.4, 24], 0, 1 / 60, runner);
  made?.(j);
  const sent: number[] = [];
  const send = j.session.ahead.bind(j.session);
  j.session.ahead = (x, z, r, seed) => {
    sent.push(SHELLS.find((s) => s.seed === seed)!.id);
    send(x, z, r, seed);
  };
  const page = {
    get ahead() {
      return ahead ?? aheadOn(runner ?? inProcessRunner(), 8);
    },
  };
  await j.battle.catchUp(LOG, 0, () => 6_000, null, breathe, page);
  expect(j.battle.landed.map((s) => s.id)).toEqual([1, 2, 3, 4, 5]);
  expect([j.session.destruction.pending, j.battle.held]).toEqual([0, []]);
  return { j, sent, map: j.session.map };
}

describe("a catch-up's craters cut ahead only where a pool runs them", () => {
  it('a catch-up on the in-process runner, or on workers with no pool, cuts nothing ahead and lands the world of one that cuts none; on a pool, its next shells, and the same world', async () => {
    const without = await caughtUp(undefined, 0);
    expect(without.sent).toEqual([]);
    expect(without.map.get(362, 64, 128)).toBe(P.BRANCH);
    // In-process: every job sent ahead would be cut at once, on the page.
    const local = await caughtUp(inProcessRunner());
    expect(local.sent).toEqual([]);
    expect(sameWorld(without.map, local.map)).toBe(true);
    // No pool (a page with two cores): every job sent ahead would queue on the session's worker, before the next shell's own.
    const noPool = await caughtUp(workerRunner(0));
    expect(noPool.sent).toEqual([]);
    expect(FakeWorker.posts.every(([w, id]) => w === 0 && id > 0)).toBe(true);
    expect(sameWorld(without.map, noPool.map)).toBe(true);
    // A pool of two: S2 and S4 at the start, S3 once S1 is in, S5 once S2 is; on the pool.
    FakeWorker.all = [];
    FakeWorker.posts = [];
    const pooled = await caughtUp(workerRunner(2));
    expect(pooled.sent).toEqual([2, 4, 3, 5]);
    expect(FakeWorker.posts.filter(([, id]) => id < 0).every(([w]) => w > 0)).toBe(true);
    expect(pooled.j.session.destruction.aheadTaken).toBeGreaterThanOrEqual(2);
    expect(sameWorld(without.map, pooled.map)).toBe(true);
    expect(warned).toEqual([]);
  });

  for (const fate of ['error', 'throws', 'error after its cut'] as const) {
    it(`a pool worker that fails (${fate}) as it cuts a crater taken over lets only the pool go: the session's worker runs on, nothing more is cut ahead in this catch-up, and the world is the same`, async () => {
      const without = await caughtUp(undefined, 0);
      // The pool runs nothing until S2's own job has taken its work over; then the first job it takes up fails.
      let failing = true;
      FakeWorker.fate = (w) => {
        if (w.index === 0 || !failing) return 'run';
        failing = false;
        return fate;
      };
      const runner = workerRunner(2);
      let d: Destruction | null = null;
      FakeWorker.poolMay = () => (d?.aheadTaken ?? 0) >= 1;
      const { map, sent } = await caughtUp(runner, undefined, (j) => (d = j.session.destruction));
      expect(FakeWorker.failedAt).not.toBeNull();
      // The session's worker runs on; the pool is let go.
      expect(FakeWorker.all[0].terminated).toBe(false);
      expect(FakeWorker.all.slice(1).every((w) => w.terminated)).toBe(true);
      expect(warned.some((m) => /pool/.test(m))).toBe(true);
      expect(warned.some((m) => /in-process/.test(m))).toBe(false);
      // From the failure on, every job is the session's own, on its worker: none more cut ahead (not S5).
      expect(FakeWorker.posts.slice(FakeWorker.failedAt!).every(([w, id]) => w === 0 && id > 0)).toBe(true);
      expect(sent).not.toContain(5);
      expect(runner.parallel).toBe(0);
      expect(sameWorld(without.map, map)).toBe(true);
      // Once the catch-up is done the pool may be made again, for the next.
      runner.rest();
      expect(runner.parallel).toBe(2);
    });
  }

  it("a job that throws in every worker: the pool goes at its first failure, and the session's worker falls back to in-process only when the shell's own job fails there; the world is the same", async () => {
    const without = await caughtUp(undefined, 0);
    FakeWorker.fate = (_w, req) => (req.seed === SHELLS[1].seed ? 'throws' : 'run');
    const runner = workerRunner(2);
    const { map } = await caughtUp(runner);
    expect(warned.length).toBe(2);
    expect(warned[0]).toMatch(/pool/);
    expect(warned[1]).toMatch(/in-process/);
    // S2's own job went to the session's worker, and failed there.
    expect(FakeWorker.posts.filter(([w, id]) => w === 0 && id === 2)).toHaveLength(1);
    expect(FakeWorker.all.every((w) => w.terminated)).toBe(true);
    expect(runner.parallel).toBe(0);
    expect(sameWorld(without.map, map)).toBe(true);
  });
});
