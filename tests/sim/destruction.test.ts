import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { loadTunables } from '../../src/core/tunables';
import { Destruction, destructionTunables, inProcessRunner, type DetonationRunner } from '../../src/sim/destruction';
import { chip, detonate } from '../../src/world/destruction';
import { detonationRegion, runDetonation, type DetonationRequest, type DetonationResult } from '../../src/world/detonation';
import { P } from '../../src/world/materials';
import { groundTop } from '../../src/world/raycast';
import type { BrickMap } from '../../src/world/bricks';
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
});
