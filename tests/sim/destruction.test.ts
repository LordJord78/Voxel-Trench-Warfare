import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { loadTunables } from '../../src/core/tunables';
import { Destruction, destructionTunables, inProcessRunner, type DetonationRunner } from '../../src/sim/destruction';
import { chip, detonate } from '../../src/world/destruction';
import { runDetonation, type DetonationRequest, type DetonationResult } from '../../src/world/detonation';
import { P } from '../../src/world/materials';
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
});
