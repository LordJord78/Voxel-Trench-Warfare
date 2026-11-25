import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { loadTunables } from '../../src/core/tunables';
import { Destruction, destructionTunables, inProcessRunner, type Crater, type DetonationRunner } from '../../src/sim/destruction';
import { chip, detonate } from '../../src/world/destruction';
import { detonationRegion, runDetonation, type DetonationRequest, type DetonationResult } from '../../src/world/detonation';
import { P } from '../../src/world/materials';
import { groundTop } from '../../src/world/raycast';
import { BRICK, BrickMap } from '../../src/world/bricks';
import type { Box } from '../../src/world/region';
import { copyBox, regionMap, sameCopy } from '../../src/world/region-copy';
import { sameWorld, shellOptions, trenchArena } from '../support/worlds';

// The session's craters land through a queue (the spec's §3): posted to a runner, written back a
// budget a tick, in order; a mark inside a region that is out is held and made again after; a shell
// over a region that is out waits for it; a job that asks for a wider region gets one.
const tun = loadTunables();
const CHIP = tun.f('destruction.chip_energy_j');
const t = (bricksPerTick = 512) => ({ ...destructionTunables(tun, 42), bricksPerTick });
const CREST: [number, number, number] = [128, 76, 150];

/** A runner that keeps each result until released, and counts what it was posted. */
function heldRunner(): DetonationRunner & { release(): void; posted: DetonationRequest[] } {
  const waiting: DetonationResult[] = [];
  const done: DetonationResult[] = [];
  const posted: DetonationRequest[] = [];
  return {
    posted,
    post: (req) => {
      posted.push(req);
      waiting.push(runDetonation(req));
    },
    take: () => done.splice(0),
    release: () => done.push(...waiting.splice(0)),
  };
}

/** Tick until `n` craters have landed (at most `limit` ticks); the craters, and the ticks it took. */
function land(d: Destruction, n = 1, limit = 50) {
  const craters = [];
  let ticks = 0;
  while (craters.length < n && ticks < limit) {
    craters.push(...d.tick());
    ticks++;
  }
  return { craters, ticks };
}

describe('the destruction queue', () => {
  it("a shell's crater lands through the queue as detonate cuts it in place", () => {
    const inPlace = trenchArena();
    detonate(inPlace, ...CREST, 30, Rng.root(11), shellOptions());
    const map = trenchArena();
    const d = new Destruction(map, inProcessRunner(), t());
    const id = d.shell(CREST, 30, 11);
    const { craters, ticks } = land(d);
    expect(craters).toEqual([{ id, centre: CREST, radius: 30, bricks: expect.any(Number) }]);
    expect(craters[0].bricks).toBeGreaterThan(50);
    expect(ticks).toBeLessThanOrEqual(3);
    expect(sameWorld(inPlace, map)).toBe(true);
    expect(d.pending).toBe(0);
    expect(d.out).toEqual([]);
  });

  it("a mark inside a region that is out is held, then made again once its bricks are back", () => {
    const inPlace = trenchArena();
    detonate(inPlace, ...CREST, 30, Rng.root(11), shellOptions());
    chip(inPlace, 60, 50, 119, 1e6, CHIP);
    const map = trenchArena();
    const runner = heldRunner();
    const d = new Destruction(map, runner, t());
    d.shell(CREST, 30, 11);
    d.tick();
    expect(runner.posted.length).toBe(1);
    expect(d.out.length).toBe(1);
    // The far wall of the trench, inside the region but clear of the crater.
    expect(d.mark(60, 50, 119, 1e6, CHIP)).toBe('held');
    expect(map.get(60, 50, 119)).toBe(P.CLAY);
    // Outside every region that is out, a mark is made at once.
    expect(d.mark(250, 50, 10, 1e6, CHIP)).toBe(true);
    chip(inPlace, 250, 50, 10, 1e6, CHIP);
    runner.release();
    expect(land(d).craters.length).toBe(1);
    expect(map.get(60, 50, 119)).not.toBe(P.CLAY);
    expect(sameWorld(inPlace, map)).toBe(true);
  });

  it('a second shell over a region that is out waits, and both land as in-place detonates in order cut them', () => {
    const inPlace = trenchArena();
    detonate(inPlace, ...CREST, 30, Rng.root(11), shellOptions());
    detonate(inPlace, 140, 76, 150, 25, Rng.root(12), shellOptions());
    const map = trenchArena();
    const runner = heldRunner();
    const d = new Destruction(map, runner, t());
    const first = d.shell(CREST, 30, 11);
    const second = d.shell([140, 76, 150], 25, 12);
    d.tick();
    d.tick();
    expect(runner.posted.map((r) => r.id)).toEqual([first]);
    runner.release();
    const { craters } = land(d, 1);
    expect(craters.map((c) => c.id)).toEqual([first]);
    // In again, the first's region frees the second, which is copied from the world as the first left it.
    expect(runner.posted.map((r) => r.id)).toEqual([first, second]);
    runner.release();
    expect(land(d, 1).craters.map((c) => c.id)).toEqual([second]);
    expect(sameWorld(inPlace, map)).toBe(true);
  });

  it('a shell on the ground is cut where the ground is when it goes out, and says what it struck there', () => {
    const map = trenchArena();
    const runner = heldRunner();
    const d = new Destruction(map, runner, t());
    const first = d.shell(CREST, 30, 11);
    // On the ground: the y it is given is not where it is cut.
    const second = d.shell([140, 0, 150], 25, 12, true);
    d.tick();
    d.tick();
    expect(runner.posted.map((r) => r.id)).toEqual([first]);
    // Waiting, it is pending, and so is the first; ground clear of both is not.
    expect(d.overlapsPending({ x0: 140, y0: 0, z0: 150, x1: 141, y1: 1, z1: 151 })).toBe(true);
    expect(d.overlapsPending({ x0: 250, y0: 0, z0: 10, x1: 251, y1: 1, z1: 11 })).toBe(false);
    runner.release();
    const firstIn = land(d, 1).craters;
    expect(firstIn.map((c) => c.id)).toEqual([first]);
    expect(firstIn[0]).not.toHaveProperty('material');
    // The first in, the second goes out, centred on the ground as the first left it: lower than the crest was.
    expect(runner.posted.map((r) => r.id)).toEqual([first, second]);
    const top = groundTop(map, 140, 150)!;
    expect(top).toBeLessThan(76);
    expect(runner.posted[1].centre).toEqual([140, top, 150]);
    const struck = map.get(140, top - 1, 150);
    expect(struck).not.toBe(P.AIR);
    runner.release();
    expect(land(d, 1).craters).toEqual([{ id: second, centre: [140, top, 150], radius: 25, bricks: expect.any(Number), material: struck }]);
    expect(d.overlapsPending({ x0: 140, y0: 0, z0: 150, x1: 141, y1: 1, z1: 151 })).toBe(false);
    const inPlace = trenchArena();
    detonate(inPlace, ...CREST, 30, Rng.root(11), shellOptions());
    detonate(inPlace, 140, top, 150, 25, Rng.root(12), shellOptions());
    expect(sameWorld(inPlace, map)).toBe(true);
  });

  it('ten overlapping shells all land, in order', () => {
    const inPlace = trenchArena();
    const map = trenchArena();
    const d = new Destruction(map, inProcessRunner(), t());
    const ids: number[] = [];
    for (let k = 0; k < 10; k++) {
      const at: [number, number, number] = [110 + 4 * k, 76, 150 - k];
      detonate(inPlace, ...at, 22, Rng.root(100 + k), shellOptions());
      ids.push(d.shell(at, 22, 100 + k));
    }
    const { craters } = land(d, 10, 100);
    expect(craters.map((c) => c.id)).toEqual(ids);
    expect(sameWorld(inPlace, map)).toBe(true);
  });

  it('write-back takes at most bricks_per_tick bricks a tick', () => {
    const map = trenchArena();
    const d = new Destruction(map, inProcessRunner(), t(64));
    d.shell(CREST, 30, 11);
    let landed = 0;
    let written = 0;
    for (let k = 0; k < 40 && landed === 0; k++) {
      landed += d.tick().length;
      const dirty = map.takeDirty().length;
      expect(dirty).toBeLessThanOrEqual(64);
      written += dirty;
    }
    expect(landed).toBe(1);
    expect(written).toBeGreaterThan(64);
  });

  it('with no tick, nothing is written, and the crater lands on the ticks after', () => {
    const map = trenchArena();
    const d = new Destruction(map, inProcessRunner(), t());
    d.shell(CREST, 30, 11);
    d.tick();
    map.takeDirty();
    const before = trenchArena();
    expect(sameWorld(before, map)).toBe(true);
    expect(land(d).craters.length).toBe(1);
    expect(sameWorld(before, map)).toBe(false);
  });

  it('a wider region asked for is copied and posted again', () => {
    const inPlace = trenchArena();
    detonate(inPlace, ...CREST, 30, Rng.root(11), shellOptions());
    const map = trenchArena();
    const posted: DetonationRequest[] = [];
    const done: DetonationResult[] = [];
    // The first time, it asks for the whole world.
    const runner: DetonationRunner = {
      post: (req) => {
        posted.push(req);
        done.push(posted.length === 1 ? { id: req.id, wider: { x0: 0, y0: 0, z0: 0, x1: 256, y1: 128, z1: 256 } } : runDetonation(req));
      },
      take: () => done.splice(0),
    };
    const d = new Destruction(map, runner, t());
    d.shell(CREST, 30, 11);
    expect(land(d).craters.length).toBe(1);
    expect(posted.map((r) => r.copy.size)).toEqual([posted[0].copy.size, [32, 16, 32]]);
    expect(sameWorld(inPlace, map)).toBe(true);
  });

  it('a shell waits to go out while `waits` holds it, and so does every one behind it', () => {
    // Two shells at the arena's ends, their regions apart: the second waits for the first all the same,
    // as behind a region out, so craters go out in the order they were shelled on every client.
    const map = trenchArena();
    const runner = heldRunner();
    const d = new Destruction(map, runner, t());
    expect(d.lastId).toBe(0);
    const west = d.shell([20, 64, 150], 3, 21);
    const east = d.shell([236, 64, 150], 3, 22);
    expect(d.lastId).toBe(east);
    const [wBox, eBox] = [20, 236].map((x) => detonationRegion(map.dims, [x, 64, 150], 3, t().options.loosen)!);
    expect(wBox.x1 <= eBox.x0).toBe(true);
    let holding = true;
    const asked: number[] = [];
    d.waits = (id, box) => {
      asked.push(id);
      expect(box).toEqual(id === west ? wBox : eBox);
      return holding && id === west;
    };
    d.tick();
    d.tick();
    expect(runner.posted).toEqual([]);
    expect(asked).toEqual([west, west]);
    expect(d.pending).toBe(2);
    // A shell's region, while it is queued, is ground pending only to what comes after it (`upTo` its
    // id or later); out, it is pending to everything, as its bricks will come back over it.
    expect([d.overlapsPendingBy(wBox, west), d.overlapsPendingBy(wBox, west - 1), d.overlapsPendingBy(eBox, west)]).toEqual([true, false, false]);
    holding = false;
    d.tick();
    expect(runner.posted.map((r) => r.id)).toEqual([west, east]);
    expect([d.overlapsPendingBy(wBox, 0), d.overlapsPendingBy(eBox, 0)]).toEqual([true, true]);
    runner.release();
    expect(land(d, 2).craters.map((c) => c.id)).toEqual([west, east]);
    expect(d.pending).toBe(0);
  });

  it('a job asking for a wider region that `waits` holds goes back to wait, and out again once let go', () => {
    const inPlace = trenchArena();
    detonate(inPlace, ...CREST, 30, Rng.root(11), shellOptions());
    const map = trenchArena();
    const posted: DetonationRequest[] = [];
    const done: DetonationResult[] = [];
    const runner: DetonationRunner = {
      post: (req) => {
        posted.push(req);
        done.push(posted.length === 1 ? { id: req.id, wider: { x0: 0, y0: 0, z0: 0, x1: 256, y1: 128, z1: 256 } } : runDetonation(req));
      },
      take: () => done.splice(0),
    };
    const d = new Destruction(map, runner, t());
    d.shell(CREST, 30, 11);
    let holding = true;
    // Its first region goes out; the wider one it asks for is held.
    d.waits = (_, box) => holding && box.x1 - box.x0 === 256;
    for (let k = 0; k < 5; k++) d.tick();
    expect(posted).toHaveLength(1);
    expect([d.pending, d.out.length]).toEqual([1, 0]);
    holding = false;
    expect(land(d).craters.length).toBe(1);
    expect(posted.map((r) => r.copy.size)).toEqual([posted[0].copy.size, [32, 16, 32]]);
    expect(sameWorld(inPlace, map)).toBe(true);
  });

  it("a crater's write-back takes under 4 ms a tick", () => {
    // The second of two craters, the first warming up: only the ticks that write its bricks back.
    const map = trenchArena();
    const runner = heldRunner();
    const d = new Destruction(map, runner, t());
    const times: number[] = [];
    let bricks = 0;
    for (const [k, at] of [[0, [100, 64, 60]], [1, [150, 64, 70]]] as const) {
      d.shell([...at], 34, 20 + k);
      d.tick();
      runner.release();
      map.takeDirty();
      for (let n = 0; n < 10; n++) {
        const t0 = performance.now();
        const landed = d.tick().length;
        const ms = performance.now() - t0;
        const written = map.takeDirty().length;
        if (k === 1 && written > 0) {
          times.push(ms);
          bricks += written;
        }
        if (landed) break;
      }
    }
    expect(bricks).toBeGreaterThan(100);
    expect(Math.max(...times)).toBeLessThan(4);
  });

  it("a crater's cut lands at once and its settling after; the region is out, and marks held, until both are in", () => {
    const inPlace = trenchArena();
    detonate(inPlace, ...CREST, 30, Rng.root(11), shellOptions());
    chip(inPlace, 60, 50, 119, 1e6, CHIP);
    const map = trenchArena();
    const cuts: DetonationResult[] = [];
    const rest: DetonationResult[] = [];
    const done: DetonationResult[] = [];
    const runner: DetonationRunner = {
      post: (req) => rest.push(runDetonation(req, (cut) => cuts.push(cut))),
      take: () => done.splice(0),
    };
    const d = new Destruction(map, runner, t());
    const id = d.shell(CREST, 30, 11);
    d.tick();
    done.push(...cuts.splice(0));
    expect(d.tick()).toEqual([]);
    expect(d.cuts.map((c) => c.id)).toEqual([id]);
    expect(map.get(128, 75, 150)).toBe(P.AIR);
    expect(d.out.length).toBe(1);
    expect(d.mark(60, 50, 119, 1e6, CHIP)).toBe('held');
    done.push(...rest.splice(0));
    expect(land(d).craters.map((c) => c.id)).toEqual([id]);
    expect(d.cuts).toEqual([]);
    expect(sameWorld(inPlace, map)).toBe(true);
  });
});

// A catch-up on the room's log has its next shells' craters cut ahead of their turn (sim/room-battle.ts):
// each such job is no shell's until its shell's own job goes out and takes the work over, and only if
// its ground is as it was when the work was sent. Two shells on the ground, as a room's are cut: the
// west's region and the east's apart (whole sectors: x 0–128 and 128–256), on the open clay.
describe('craters cut ahead of their turn', () => {
  const WEST: [number, number, number] = [40, 0, 60];
  const EAST: [number, number, number] = [216, 0, 60];
  const R = 8;
  const loosen = t().options.loosen;

  /** The world where the shells go in each in its turn, cut nowhere ahead: each landed, `between` each pair. */
  function inTurn(shells: readonly (readonly [readonly [number, number, number], number])[], between?: (map: BrickMap, k: number) => void): BrickMap {
    const map = trenchArena();
    const d = new Destruction(map, inProcessRunner(), t());
    shells.forEach(([at, seed], k) => {
      if (k > 0) between?.(map, k);
      d.shell(at, R, seed, true);
      land(d);
    });
    return map;
  }

  /** Ticks until `n` craters have landed, the runner's results released before each. */
  function released(d: Destruction, runner: { release(): void }, n = 1) {
    const craters = [];
    for (let k = 0; k < 50 && craters.length < n; k++) {
      runner.release();
      craters.push(...d.tick());
    }
    return craters;
  }

  it('one cut ahead goes in as it would have in its turn, its work taken over; until then nothing of it is pending, out or written', () => {
    const [w, e] = [WEST, EAST].map((at) => detonationRegion(trenchArena().dims, at, R, loosen)!);
    expect(w.x1 <= e.x0).toBe(true);
    const map = trenchArena();
    const runner = heldRunner();
    const d = new Destruction(map, runner, t());
    d.ahead([EAST[0], 64, EAST[2]], R, 32);
    expect(runner.posted.map((r) => r.id)).toEqual([-1]);
    // Centred on the ground's top, and given the region as the world is now.
    expect(runner.posted[0].centre).toEqual([EAST[0], groundTop(map, EAST[0], EAST[2]), EAST[2]]);
    runner.release();
    for (let k = 0; k < 3; k++) expect(d.tick()).toEqual([]);
    expect([d.pending, d.out.length, d.lastId, d.overlapsPending(e), d.overlapsOut(e)]).toEqual([0, 0, 0, false, false]);
    expect(sameWorld(trenchArena(), map)).toBe(true);
    // In their turns: the west's, then the east's, which takes the work over and posts nothing.
    const west = d.shell(WEST, R, 31, true);
    expect(released(d, runner).map((c) => c.id)).toEqual([west]);
    const east = d.shell(EAST, R, 32, true);
    const craters = released(d, runner);
    expect(craters.map((c) => c.id)).toEqual([east]);
    const fresh = trenchArena();
    expect(craters[0].material).toBe(fresh.get(EAST[0], groundTop(fresh, EAST[0], EAST[2])! - 1, EAST[2]));
    expect(runner.posted.map((r) => r.id)).toEqual([-1, west]);
    expect([d.aheadTaken, d.aheadDropped]).toEqual([1, 0]);
    expect(sameWorld(inTurn([[WEST, 31], [EAST, 32]]), map)).toBe(true);
  });

  it("one whose ground changed before its turn, by a voxel or a crater over it, is cut afresh from the ground as it is then", () => {
    // A voxel dug in its region, far from its crater (a scoop's); then a crater over its region.
    const dug = (map: BrickMap) => map.set(250, 63, 10, P.AIR);
    for (const [shells, between] of [
      [[[WEST, 31], [EAST, 32]], (map: BrickMap) => dug(map)],
      [[[[196, 0, 60], 33], [EAST, 32]], undefined],
    ] as const) {
      const map = trenchArena();
      const runner = heldRunner();
      const d = new Destruction(map, runner, t());
      d.ahead([EAST[0], 64, EAST[2]], R, 32);
      const first = d.shell(shells[0][0], R, shells[0][1], true);
      released(d, runner);
      between?.(map);
      const east = d.shell(EAST, R, 32, true);
      expect(released(d, runner).map((c) => c.id)).toEqual([east]);
      expect(runner.posted.map((r) => r.id)).toEqual([-1, first, east]);
      expect([d.aheadTaken, d.aheadDropped]).toEqual([0, 1]);
      expect(sameWorld(inTurn(shells, between), map)).toBe(true);
    }
  });

  it("what comes back of it after its shell's job went out is that job's: its cut, then its crater", () => {
    const map = trenchArena();
    const runner = heldRunner();
    const d = new Destruction(map, runner, t());
    d.ahead([EAST[0], 64, EAST[2]], R, 32);
    const east = d.shell(EAST, R, 32, true);
    d.tick();
    d.tick();
    expect(runner.posted.map((r) => r.id)).toEqual([-1]);
    expect([d.pending, d.out.length, d.aheadTaken]).toEqual([1, 1, 1]);
    expect(released(d, runner).map((c) => c.id)).toEqual([east]);
    expect(sameWorld(inTurn([[EAST, 32]]), map)).toBe(true);
  });

  it('one dropped (dropAhead) is no shell\'s: what comes back of it is nothing, and its shell is cut afresh', () => {
    const map = trenchArena();
    const runner = heldRunner();
    const d = new Destruction(map, runner, t());
    d.ahead([EAST[0], 64, EAST[2]], R, 32);
    d.dropAhead();
    runner.release();
    d.tick();
    const east = d.shell(EAST, R, 32, true);
    expect(released(d, runner).map((c) => c.id)).toEqual([east]);
    expect(runner.posted.map((r) => r.id)).toEqual([-1, east]);
    expect([d.aheadTaken, d.aheadDropped]).toEqual([0, 0]);
    expect(sameWorld(inTurn([[EAST, 32]]), map)).toBe(true);
  });

  it('one taken over whose worker is lost after its cut came back and went in (handed back as its own region) goes out again on the copy it was given: the world is as if it was never lost', () => {
    // The page's runner hands back each job a pool worker had out when the pool fails
    // (app/destruction-in-worker.ts): as a "wider" region that is the job's own. A tree's trunk stands
    // in the crater's rim, 0.9–1.1 m from its centre: a cut makes the rim's trunk branch (spoilOf), and a
    // cut again over that ground would make the branch air. Every other material's spoil is its own.
    const treed = () => {
      const m = trenchArena();
      m.fillBox(EAST[0] + 9, 64, EAST[2] - 1, EAST[0] + 11, 72, EAST[2] + 1, P.TRUNK);
      m.takeDirty();
      return m;
    };
    const inPlace = treed();
    const alone = new Destruction(inPlace, inProcessRunner(), t());
    alone.shell(EAST, R, 32, true);
    land(alone);
    const map = treed();
    const done: DetonationResult[] = [];
    const posted: DetonationRequest[] = [];
    let lost: { cut: DetonationResult; region: Box } | null = null;
    const runner: DetonationRunner = {
      post: (req) => {
        posted.push(req);
        if (req.id >= 0) return void done.push(runDetonation(req, (cut) => done.push(cut)));
        let cut: DetonationResult | null = null;
        runDetonation(req, (c) => (cut = c));
        lost = { cut: cut!, region: copyBox(req.copy) };
      },
      take: () => done.splice(0),
    };
    const d = new Destruction(map, runner, t());
    d.ahead([EAST[0], 64, EAST[2]], R, 32);
    const east = d.shell(EAST, R, 32, true);
    d.tick();
    expect([d.aheadTaken, d.out.length]).toEqual([1, 1]);
    // Its cut comes back, and goes in.
    done.push(lost!.cut);
    d.tick();
    expect(d.cuts.map((c) => c.id)).toEqual([east]);
    expect(map.get(EAST[0] + 9, 64, EAST[2])).toBe(P.BRANCH);
    // Then its worker is lost: the job goes out again, on the copy it was first given, not the world as its cut left it.
    done.push({ id: -1, wider: lost!.region });
    d.tick();
    expect(posted.map((r) => r.id)).toEqual([-1, east]);
    expect(sameCopy(posted[1].copy, posted[0].copy)).toBe(true);
    expect(land(d).craters.map((c) => c.id)).toEqual([east]);
    expect(sameWorld(inPlace, map)).toBe(true);
  });
});

/**
 * A runner that hands back each job's cut and the rest of it (its settled crater, or its ask for a wider
 * region) apart, each when released, a job's rest only once its cut is back: a live page's destruction
 * worker, whose cut comes back within a frame of its post and its settling about 170 ms later. It keeps
 * what it was posted.
 */
function liveRunner(): DetonationRunner & { posted: DetonationRequest[]; cuts(): void; rest(): void; lose(id: number, region: Box): void } {
  const jobs: { cut: DetonationResult | null; rest: DetonationResult; cutBack: boolean }[] = [];
  const done: DetonationResult[] = [];
  const posted: DetonationRequest[] = [];
  return {
    posted,
    post: (req) => {
      posted.push(req);
      const cut: DetonationResult[] = [];
      const rest = runDetonation(req, (c) => cut.push(c));
      jobs.push({ cut: cut[0] ?? null, rest, cutBack: cut.length === 0 });
    },
    take: () => done.splice(0),
    cuts: () => {
      for (const j of jobs) if (!j.cutBack) {
        done.push(j.cut!);
        j.cutBack = true;
      }
    },
    rest: () => {
      for (let k = 0; k < jobs.length; ) if (jobs[k].cutBack) done.push(jobs.splice(k, 1)[0].rest);
      else k++;
    },
    // Its worker lost: nothing more of what is out comes back, and job `id` is handed back as `region`.
    lose: (id, region) => {
      jobs.length = 0;
      done.push({ id, wider: region });
    },
  };
}

/** Ticks a live page's way until `n` craters have landed: each round, the cuts back and a tick to write them; then the rest, and a tick. */
function live(d: Destruction, runner: { cuts(): void; rest(): void }, n = 1): Crater[] {
  const craters: Crater[] = [];
  for (let k = 0; k < 200 && craters.length < n; k++) {
    runner.cuts();
    craters.push(...d.tick());
    runner.rest();
    craters.push(...d.tick());
  }
  return craters;
}

/** The voxel at world (x, y, z) in a request's copy of its region. */
function inCopy(req: DetonationRequest, [x, y, z]: readonly [number, number, number]): number {
  return regionMap(req.copy).get(x - req.copy.origin[0] * BRICK, y, z - req.copy.origin[2] * BRICK);
}

// A crater whose settling needs more room than its region asks for a wider one (world/detonation.ts),
// as the job's last result: on a live page its cut has come back long before, and is in the world. The
// wider region is cut again from its ground as it was before that cut, as where the cut and the ask come
// back in one take (in-process; a catch-up's crater cut ahead, all of it back before its turn): a cut over
// its own cut would make the rim's trunk, a branch after one cut, air. A ridge of spoil standing sheer on
// the clay, 1.6 m high, z 140–150, along x 256 ± `half`; a shell at its foot slumps it further along than
// its region holds, asking once at 7 m (`half` 70) and twice at 11 m. A tree's trunk in the crater's rim,
// 0.95–1.05 m south of the shell.
describe('a crater whose job asks for a wider region', () => {
  const AT: [number, number, number] = [256, 0, 135];
  const R = 8;
  const SEED = 5;
  const TRUNK: [number, number, number] = [256, 65, 124];
  const ridged = (half = 70) => {
    const map = new BrickMap({ x: 512, y: 128, z: 256 });
    map.fillBox(0, 0, 0, 512, 64, 256, P.CLAY);
    map.fillBox(256 - half, 64, 140, 256 + half, 80, 150, P.SPOIL);
    map.fillBox(255, 64, 124, 257, 72, 126, P.TRUNK);
    map.takeDirty();
    return map;
  };
  /** The crater cut once, in place: detonate at the ground's top. */
  const inPlace = (half?: number) => {
    const map = ridged(half);
    detonate(map, AT[0], groundTop(map, AT[0], AT[2])!, AT[2], R, Rng.root(SEED), shellOptions());
    return map;
  };
  /** Through the queue in-process, each job's results in one take: the world, and the size of each region posted. */
  const oneTake = (half?: number) => {
    const map = ridged(half);
    const sizes: [number, number, number][] = [];
    const runner = inProcessRunner();
    const d = new Destruction(map, { post: (req) => (sizes.push(req.copy.size), runner.post(req)), take: runner.take }, t());
    d.shell(AT, R, SEED, true);
    expect(land(d).craters).toHaveLength(1);
    return { map, sizes };
  };

  it("its cut in the world when it asks (a live page's order), it is cut again from its region's ground as it was before its cut: the world is the one where both come back in one take", () => {
    const together = oneTake();
    expect(together.sizes).toHaveLength(2);
    expect(together.map.get(...TRUNK)).toBe(P.BRANCH);
    expect(sameWorld(inPlace(), together.map)).toBe(true);
    // Its cut written whole within a tick of coming back; or 16 bricks a tick, part of it when the ask comes.
    for (const budget of [512, 16]) {
      const map = ridged();
      const runner = liveRunner();
      const d = new Destruction(map, runner, t(budget));
      const id = d.shell(AT, R, SEED, true);
      d.tick();
      runner.cuts();
      d.tick();
      expect(d.written).toBe(budget === 512 ? d.cuts[0].bricks : 16);
      expect(map.get(...TRUNK)).toBe(P.BRANCH);
      runner.rest();
      d.tick();
      expect(runner.posted.map((r) => r.copy.size)).toEqual(together.sizes);
      expect(inCopy(runner.posted[1], TRUNK), `${budget} bricks a tick`).toBe(P.TRUNK);
      expect(live(d, runner).map((c) => c.id)).toEqual([id]);
      expect(map.get(...TRUNK)).toBe(P.BRANCH);
      expect(sameWorld(together.map, map), `${budget} bricks a tick`).toBe(true);
    }
  });

  it("so is one cut ahead of its turn and taken over, its cut back and in after its shell's job took it over, then its ask", () => {
    const together = oneTake();
    const map = ridged();
    const runner = liveRunner();
    const d = new Destruction(map, runner, t());
    d.ahead([AT[0], 64, AT[2]], R, SEED);
    const id = d.shell(AT, R, SEED, true);
    d.tick();
    expect([d.aheadTaken, runner.posted.map((r) => r.id)]).toEqual([1, [-1]]);
    runner.cuts();
    d.tick();
    expect(d.cuts.map((c) => c.id)).toEqual([id]);
    expect(map.get(...TRUNK)).toBe(P.BRANCH);
    runner.rest();
    d.tick();
    expect(runner.posted.map((r) => [r.id, r.copy.size])).toEqual([[-1, together.sizes[0]], [id, together.sizes[1]]]);
    expect(inCopy(runner.posted[1], TRUNK)).toBe(P.TRUNK);
    expect(live(d, runner).map((c) => c.id)).toEqual([id]);
    expect(sameWorld(together.map, map)).toBe(true);
  });

  it('one that asks twice is cut once, from the ground as it was before its cut, whether its results come back in one take or live', () => {
    // In one take its first cut is written while its first wider job is out; then that job asks again.
    const together = oneTake(110);
    expect(together.sizes).toHaveLength(3);
    expect(together.map.get(...TRUNK)).toBe(P.BRANCH);
    expect(sameWorld(inPlace(110), together.map)).toBe(true);
    const map = ridged(110);
    const runner = liveRunner();
    const d = new Destruction(map, runner, t());
    d.shell(AT, R, SEED, true);
    d.tick();
    expect(live(d, runner)).toHaveLength(1);
    expect(runner.posted.map((r) => r.copy.size)).toEqual(together.sizes);
    expect(runner.posted.map((r) => inCopy(r, TRUNK))).toEqual([P.TRUNK, P.TRUNK, P.TRUNK]);
    expect(sameWorld(together.map, map)).toBe(true);
  });

  it("one handed back as its own region once its cut is in (its worker lost: the page's runner falls back) goes out again on its region's ground as it was before its cut", () => {
    // A ridge 3 m along: the crater's region holds its slump, and it asks for nothing wider.
    const map = ridged(30);
    const runner = liveRunner();
    const d = new Destruction(map, runner, t());
    const id = d.shell(AT, R, SEED, true);
    d.tick();
    runner.cuts();
    d.tick();
    expect(map.get(...TRUNK)).toBe(P.BRANCH);
    // Lost: its settled crater never comes, and its own region is handed back (app/destruction-in-worker.ts handBack).
    const own = runner.posted[0];
    runner.lose(id, copyBox(own.copy));
    d.tick();
    expect(runner.posted.map((r) => [r.id, r.copy.size])).toEqual([[id, own.copy.size], [id, own.copy.size]]);
    expect(inCopy(runner.posted[1], TRUNK)).toBe(P.TRUNK);
    expect(live(d, runner).map((c) => c.id)).toEqual([id]);
    expect(sameWorld(inPlace(30), map)).toBe(true);
  });

  it("keeps each brick its cut wrote, as it was, only while it is out and might yet ask: let go once its settled crater is back, and never kept where both come back in one take", () => {
    // 8 bricks a tick: its cut (24 bricks), then its settled crater, written over several.
    const map = ridged(30);
    const runner = liveRunner();
    const d = new Destruction(map, runner, t(8));
    d.shell(AT, R, SEED, true);
    d.tick();
    expect(d.kept).toEqual({ bricks: 0, bytes: 0 });
    runner.cuts();
    for (let k = 0; k < 50 && d.cuts.length === 0; k++) d.tick();
    const cut = d.cuts[0].bricks;
    expect(cut).toBeGreaterThan(8);
    expect(d.kept.bricks).toBe(cut);
    expect(d.kept.bytes).toBeGreaterThan(0);
    expect(d.kept.bytes).toBeLessThanOrEqual(512 * cut);
    // Its settled crater back, and still being written: nothing kept.
    runner.rest();
    expect(d.tick()).toEqual([]);
    expect([d.pending, d.out.length]).toEqual([1, 1]);
    expect(d.kept).toEqual({ bricks: 0, bytes: 0 });
    expect(land(d).craters).toHaveLength(1);
    const together = new Destruction(ridged(30), inProcessRunner(), t(16));
    together.shell(AT, R, SEED, true);
    for (let k = 0; k < 100 && together.pending > 0; k++) {
      together.tick();
      expect(together.kept.bricks).toBe(0);
    }
    expect(together.pending).toBe(0);
  });
});

// The page profiles a catch-up's destruction ticks (main.ts catchUps()[k].parts) by Destruction's own
// counters, timed with the page's clock while it gives one, rather than by swapping its tick.
describe("the destruction's ticks, counted", () => {
  it('counts every tick, and sums their ms by the clock it is given while it has one; none without', () => {
    const map = trenchArena();
    const d = new Destruction(map, inProcessRunner(), t());
    d.tick();
    d.tick();
    expect([d.ticks, d.tickMs]).toEqual([2, 0]);
    let now = 100;
    d.clock = () => (now += 3);
    d.shell([128, 0, 60], 8, 5, true);
    const { ticks } = land(d);
    expect([d.ticks, d.tickMs]).toEqual([2 + ticks, 3 * ticks]);
    d.clock = null;
    d.tick();
    expect([d.ticks, d.tickMs]).toEqual([3 + ticks, 3 * ticks]);
  });
});
