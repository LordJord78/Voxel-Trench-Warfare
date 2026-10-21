import { describe, expect, it } from 'vitest';
import { fnv1a64 } from '../../src/core/hash';
import { Rng } from '../../src/core/rng';

describe('hash', () => {
  it('fnv1a64 hashes UTF-8 bytes like the Python reference', () => {
    expect(fnv1a64('')).toBe(0xcbf29ce484222325n);
    expect(fnv1a64('field.relief')).toBe(0x0793195090d9f6een);
    expect(fnv1a64('é')).toBe(0x0ac21707b7181e01n);
  });
});

describe('Rng', () => {
  it('reproduces the reference sequence for seed 7', () => {
    const r = Rng.root(7);
    expect(r.key).toBe(0x63cbe1e459320dd7n);
    expect([1, 2, 3, 4, 5].map(() => r.nextU32())).toEqual([429986460, 2845665001, 65897732, 2744170619, 2858337122]);
    const one = Rng.root(1);
    expect([one.nextU32(), one.nextU32(), one.nextU32()]).toEqual([185148466, 3601325357, 3163576498]);
  });
  it('derives children by label, independent of draws', () => {
    const fresh = Rng.root(7).derive('field.relief');
    const parent = Rng.root(7);
    parent.nextU32(); parent.float();
    const late = parent.derive('field.relief');
    expect(fresh.key).toBe(0xb5274747e1926506n);
    expect(fresh.label).toBe('root.field.relief');
    expect([fresh.nextU32(), fresh.nextU32(), fresh.nextU32()]).toEqual([3428254541, 1183113148, 1614887826]);
    expect(late.nextU32()).toBe(3428254541);
    const ab = Rng.root(7).derive('a').derive('b');
    expect([ab.nextU32(), ab.nextU32()]).toEqual([1994525300, 1615552073]);
    expect(ab.label).toBe('root.a.b');
  });
  it('float and randint match the reference', () => {
    const r = Rng.root(7);
    expect([r.float(), r.float(), r.float()]).toEqual([0.10011402266143266, 0.01534301518594472, 0.6655084767333013]);
    const q = Rng.root(7);
    expect(Array.from({ length: 10 }, () => q.randint(0, 10))).toEqual([0, 1, 2, 9, 2, 5, 0, 3, 7, 4]);
  });
  it('rejects empty integer ranges', () => {
    expect(() => Rng.root(7).randint(5, 5)).toThrow(RangeError);
    expect(() => Rng.root(7).randint(5, 4)).toThrow(RangeError);
  });
  it('has sane distributions', () => {
    const r = Rng.root(99);
    const n = 100_000;
    let sum = 0, sq = 0, g = 0, b = 0;
    for (let i = 0; i < n; i++) {
      const x = r.normal(); sum += x; sq += x * x;
      g += r.gamma(2.4, 1.15);
      b += r.beta(0.7, 0.7);
    }
    expect(Math.abs(sum / n)).toBeLessThan(0.02);
    expect(Math.abs(sq / n - 1)).toBeLessThan(0.03);
    expect(Math.abs(g / n - 2.76)).toBeLessThan(0.05);
    expect(Math.abs(b / n - 0.5)).toBeLessThan(0.01);
  });
  it('stateString moves with every draw', () => {
    const r = Rng.root(7);
    const before = r.stateString();
    r.nextU32();
    expect(r.stateString()).not.toBe(before);
    expect(JSON.parse(before).label).toBe('root');
  });
});
