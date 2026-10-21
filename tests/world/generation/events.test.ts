import { describe, expect, it } from 'vitest';
import { Rng } from '../../../src/core/rng';
import { BrickMap } from '../../../src/world/bricks';
import { carveSphere, carveWith, detonate } from '../../../src/world/destruction';
import { bandSink } from '../../../src/world/sink';
import { P } from '../../../src/world/materials';
import { checkInvariants } from '../../../src/world/generation/invariants';

function slab(): BrickMap {
  const w = new BrickMap({ x: 96, y: 64, z: 96 });
  w.fillBox(0, 0, 0, 96, 30, 96, P.MUD);
  w.fillBox(40, 30, 40, 56, 40, 42, P.TIMBER);
  w.fillBox(40, 30, 42, 56, 38, 50, P.SPOIL);
  return w;
}

describe('band-stable carving', () => {
  it('cuts the same voxels when the world edge clamps the box', () => {
    const wide = new BrickMap({ x: 128, y: 64, z: 64 });
    const narrow = new BrickMap({ x: 64, y: 64, z: 64 });
    wide.fillBox(0, 0, 0, 128, 40, 64, P.MUD);
    narrow.fillBox(0, 0, 0, 64, 40, 64, P.MUD);
    carveSphere(wide, 64, 38, 32, 12, Rng.root(5));
    carveSphere(narrow, 64, 38, 32, 12, Rng.root(5));
    for (let x = 40; x < 64; x++) for (let y = 20; y < 40; y++) for (let z = 15; z < 50; z++) {
      expect(narrow.get(x, y, z), `${x},${y},${z}`).toBe(wide.get(x, y, z));
    }
  });
});

describe('carving through sinks', () => {
  it('cuts the same voxels whichever band draws it', () => {
    const whole = new BrickMap({ x: 128, y: 64, z: 64 });
    const split = new BrickMap({ x: 128, y: 64, z: 64 });
    const same = new BrickMap({ x: 128, y: 64, z: 64 });
    for (const w of [whole, split, same]) w.fillBox(0, 0, 0, 128, 40, 64, P.MUD);
    carveWith(bandSink(whole, 0), { x0: -1e9, x1: 1e9 }, 64, 38, 32, 12, Rng.root(5));
    carveWith(bandSink(split, 0), { x0: -1e9, x1: 58 }, 64, 38, 32, 12, Rng.root(5));
    carveWith(bandSink(split, 0), { x0: 58, x1: 1e9 }, 64, 38, 32, 12, Rng.root(5));
    carveSphere(same, 64, 38, 32, 12, Rng.root(5));
    for (let x = 45; x < 84; x++) for (let y = 20; y < 40; y++) for (let z = 15; z < 50; z++) {
      expect(split.get(x, y, z), `split ${x},${y},${z}`).toBe(whole.get(x, y, z));
      expect(same.get(x, y, z), `map ${x},${y},${z}`).toBe(whole.get(x, y, z));
    }
  });
});

describe('detonate', () => {
  it('blows a crater, loosens the rim, brings the parapet down and stays settled', () => {
    const w = slab();
    const box = detonate(w, 48, 34, 41, 7, Rng.root(9), { hardLimit: 2, core: 0.55, loosen: 1.45, waterTable: 5 });
    expect(box).not.toBeNull();
    expect(w.get(48, 34, 41)).toBe(P.AIR);
    const r = checkInvariants(w, 5);
    expect(r.hangingGranular).toBe(0);
    expect(r.looseSteep).toBe(0);
  });
  it('leaves concrete standing outside the core', () => {
    const w = new BrickMap({ x: 64, y: 64, z: 64 });
    w.fillBox(0, 0, 0, 64, 30, 64, P.MUD);
    w.fillBox(20, 30, 20, 44, 34, 44, P.CONCRETE);
    detonate(w, 32, 33, 32, 10, Rng.root(2), { hardLimit: 2, core: 0.55, loosen: 1.45, waterTable: 5 });
    expect(w.get(32, 33, 40)).toBe(P.CONCRETE);
    expect(w.get(32, 33, 32)).toBe(P.AIR);
  });
});
