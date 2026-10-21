import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { BrickMap } from '../../src/world/bricks';
import { carveSphere } from '../../src/world/destruction';
import { P } from '../../src/world/materials';

function ground(): BrickMap {
  const w = new BrickMap({ x: 64, y: 64, z: 64 });
  w.fillBox(0, 0, 0, 64, 32, 64, P.MUD);
  return w;
}

describe('carveSphere', () => {
  it('cuts an irregular bowl and reports its box', () => {
    const w = ground();
    const box = carveSphere(w, 32, 30, 32, 10, Rng.root(7).derive('crater'))!;
    expect(w.get(32, 30, 32)).toBe(P.AIR);
    expect(w.get(32, 10, 32)).toBe(P.MUD);
    expect(box.x0).toBeGreaterThanOrEqual(32 - 14);
    expect(box.x1).toBeLessThanOrEqual(32 + 15);
  });
  it('is the same cut for the same stream', () => {
    const a = ground();
    const b = ground();
    carveSphere(a, 30, 31, 33, 9, Rng.root(1).derive('x'));
    carveSphere(b, 30, 31, 33, 9, Rng.root(1).derive('x'));
    for (let i = 0; i < 2000; i++) {
      const x = 20 + (i % 20), y = 22 + ((i / 20) % 10 | 0), z = 23 + ((i / 200) | 0);
      expect(a.get(x, y, z)).toBe(b.get(x, y, z));
    }
  });
  it('leaves protected materials standing', () => {
    const w = ground();
    w.fillBox(28, 25, 28, 36, 33, 36, P.CONCRETE);
    const protect = new Uint8Array(256);
    protect[P.CONCRETE] = 1;
    carveSphere(w, 32, 30, 32, 10, Rng.root(7), { protect, roughness: 0 });
    expect(w.get(32, 30, 32)).toBe(P.CONCRETE);
    expect(w.get(24, 30, 32)).toBe(P.AIR);
    expect(w.get(21, 30, 32)).toBe(P.MUD);
  });
  it('returns null when the sphere misses the world', () => {
    expect(carveSphere(ground(), -100, 10, 10, 5, Rng.root(7))).toBeNull();
  });
});
