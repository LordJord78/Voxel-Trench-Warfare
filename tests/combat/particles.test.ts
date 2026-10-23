import { describe, expect, it } from 'vitest';
import { BILLBOARD_FLOATS, particleSpec, Particles, type ParticleSpec } from '../../src/combat/particles';
import { Rng } from '../../src/core/rng';
import { loadTunables } from '../../src/core/tunables';

// The reference's particle pool (combat/particles.py): struct-of-arrays, per-second drag then
// gravity then the move, removal in order at the end of life, and billboards whose size and
// colour run from start to end by age. Its two kinds (the flash and brass) and the dust and
// sparks of impacts come from [particles.*].
const tun = loadTunables();
const DT = 1 / 60;

const spec = (over: Partial<ParticleSpec> = {}): ParticleSpec => ({
  lifeS: 1,
  gravity: -9.81,
  drag: 2,
  sizeStartM: 0.2,
  sizeEndM: 0.4,
  colourStart: [1, 0, 0, 1],
  colourEnd: [0, 0, 1, 0],
  emissive: false,
  count: 1,
  speed: 0,
  lift: 0,
  spread: 0,
  speedJitter: 0,
  ...over,
});

function billboards(p: Particles): Float32Array[] {
  const out = new Float32Array(p.capacity * BILLBOARD_FLOATS);
  const n = p.billboards(out);
  return Array.from({ length: n }, (_, i) => out.slice(i * BILLBOARD_FLOATS, (i + 1) * BILLBOARD_FLOATS));
}

describe('particles', () => {
  it("read their kinds from [particles.*]: the reference's flash and brass, and dust and sparks", () => {
    const brass = particleSpec(tun, 'brass');
    expect([brass.lifeS, brass.gravity, brass.drag, brass.sizeStartM]).toEqual([1.3, -9.81, 0.35, 0.028]);
    expect([brass.count, brass.speed, brass.lift, brass.spread, brass.speedJitter, brass.emissive]).toEqual([1, 2.6, 1.5, 0.55, 0.2, false]);
    const flash = particleSpec(tun, 'muzzle_flash');
    expect([flash.lifeS, flash.speed, flash.emissive]).toEqual([0.045, 2.0, true]);
    expect(particleSpec(tun, 'dust').emissive).toBe(false);
    expect(particleSpec(tun, 'spark').emissive).toBe(true);
    expect(tun.i('particles.pool_capacity')).toBe(4096);
  });

  it("a particle slows and falls as the reference's does", () => {
    const p = new Particles(8);
    p.emit([1, 2, 3], [3, 0, 4], spec(), 1);
    p.step(DT);
    const [b] = billboards(p);
    const k = 1 - 2 * DT;
    const v = [3 * k, -9.81 * DT, 4 * k];
    expect(b[0]).toBeCloseTo(1 + v[0] * DT, 6);
    expect(b[1]).toBeCloseTo(2 + v[1] * DT, 6);
    expect(b[2]).toBeCloseTo(3 + v[2] * DT, 6);
  });

  it('particles die at their life and the pool keeps its order', () => {
    const p = new Particles(8);
    p.emit([0, 0, 0], [0, 0, 0], spec({ lifeS: 0.05, gravity: 0 }), 1);
    p.emit([1, 0, 0], [0, 0, 0], spec({ lifeS: 1, gravity: 0 }), 1);
    p.emit([2, 0, 0], [0, 0, 0], spec({ lifeS: 0.05, gravity: 0 }), 1);
    p.emit([3, 0, 0], [0, 0, 0], spec({ lifeS: 1, gravity: 0 }), 1);
    for (let k = 0; k < 4; k++) p.step(DT);
    expect(p.count).toBe(2);
    expect(billboards(p).map((b) => b[0])).toEqual([1, 3]);
  });

  it('a full pool refuses the rest and counts them', () => {
    const p = new Particles(tun.i('particles.pool_capacity'));
    expect(p.emit([0, 0, 0], [0, 1, 0], spec(), 4100)).toBe(4096);
    expect(p.emit([0, 0, 0], [0, 1, 0], spec(), 6)).toBe(0);
    expect(p.count).toBe(4096);
    expect(p.dropped).toBe(10);
  });

  it('billboards run size and colour by age, half the size across, colour premultiplied', () => {
    const p = new Particles(8);
    p.emit([0, 0, 0], [0, 0, 0], spec({ gravity: 0, lifeS: 30 * DT }), 1);
    for (let k = 0; k < 15; k++) p.step(DT);
    const [b] = billboards(p);
    expect(b[3]).toBeCloseTo(0.15, 6);
    expect(Array.from(b.slice(4, 8)).map((v) => +v.toFixed(6))).toEqual([0.25, 0, 0.25, 0.5]);
    expect(b[8]).toBe(0);
  });

  it("dust takes the struck material's colour", () => {
    const p = new Particles(8);
    p.emit([0, 0, 0], [0, 0, 0], spec({ colourStart: [1, 1, 1, 0.5], colourEnd: [1, 1, 1, 0.5] }), 1, undefined, [0.2, 0.4, 0.6]);
    const [b] = billboards(p);
    expect(Array.from(b.slice(4, 8)).map((v) => +v.toFixed(6))).toEqual([0.1, 0.2, 0.3, 0.5]);
  });

  it('the same seed throws the same brass', () => {
    const brass = particleSpec(tun, 'brass');
    const run = () => {
      const p = new Particles(64);
      const rng = Rng.root(9).derive('effects.particles');
      for (let k = 0; k < 10; k++) {
        p.emit([0, 1.5, 0], [brass.speed, brass.lift, 0], brass, brass.count, rng);
        p.step(DT);
      }
      return billboards(p).map((b) => Array.from(b));
    };
    const a = run();
    expect(a.length).toBe(10);
    expect(new Set(a.map((b) => b[0].toFixed(6))).size).toBeGreaterThan(5);
    expect(run()).toEqual(a);
  });
});
