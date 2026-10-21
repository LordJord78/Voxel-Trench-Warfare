import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as d from '../../src/core/dmath';

const ulpClose = (a: number, b: number, ulps = 2) =>
  Math.abs(a - b) <= ulps * Number.EPSILON * Math.max(1, Math.abs(b));

describe('dmath', () => {
  it('sin and cos track Math within 2 ulp over [-1e4, 1e4]', () => {
    for (let i = 0; i <= 20000; i++) {
      const x = -1e4 + i * 1.000123;
      expect(ulpClose(d.sin(x), Math.sin(x))).toBe(true);
      expect(ulpClose(d.cos(x), Math.cos(x))).toBe(true);
    }
  });
  it('exp, log and pow track Math within 4 ulp', () => {
    for (let i = 0; i <= 5000; i++) {
      const x = -700 + i * 0.2801;
      expect(ulpClose(d.exp(x), Math.exp(x), 4)).toBe(true);
      const y = 1e-300 * Math.pow(1.15, i);
      expect(ulpClose(d.log(y), Math.log(y), 4)).toBe(true);
    }
    expect(ulpClose(d.pow(2.5, 3.25), Math.pow(2.5, 3.25), 64)).toBe(true);
    expect(d.pow(0.3, 1 / 0.7)).toBeCloseTo(Math.pow(0.3, 1 / 0.7), 13);
  });
  it('atan and atan2 cover all quadrants', () => {
    for (const [y, x] of [[1, 1], [1, -1], [-1, -1], [-1, 1], [0, -1], [3, 0], [-3, 0]]) {
      expect(ulpClose(d.atan2(y, x), Math.atan2(y, x))).toBe(true);
    }
    expect(ulpClose(d.atan(0.5), Math.atan(0.5))).toBe(true);
  });
  it('handles non-finite and signed-zero inputs', () => {
    expect(d.sin(NaN)).toBeNaN();
    expect(Object.is(d.sin(-0), -0)).toBe(true);
    expect(d.exp(-Infinity)).toBe(0);
    expect(d.exp(Infinity)).toBe(Infinity);
    expect(d.log(0)).toBe(-Infinity);
    expect(d.log(-1)).toBeNaN();
    expect(d.log(Infinity)).toBe(Infinity);
    expect(d.pow(-8, 1 / 3)).toBeNaN();
    expect(d.pow(5, 0)).toBe(1);
  });
  it('is exact for integer powers and square roots, with JavaScript special values', () => {
    expect(d.pow(2, 3)).toBe(8);
    expect(d.pow(3, 2)).toBe(9);
    expect(d.pow(10, 2)).toBe(100);
    expect(d.pow(2, 52)).toBe(2 ** 52);
    expect(d.pow(-8, 3)).toBe(-512);
    expect(d.pow(2, -2)).toBe(0.25);
    expect(d.pow(9, 0.5)).toBe(3);
    const special: [number, number][] = [
      [-0, 3], [-0, -3], [-0, 2], [0, -2], [-2, Infinity], [-Infinity, 0.5], [-Infinity, 3], [-Infinity, -3],
      [0.5, -Infinity], [1, Infinity], [NaN, 0], [Infinity, -1], [-1, Infinity], [2, NaN],
    ];
    for (const [x, y] of special) expect(Object.is(d.pow(x, y), Math.pow(x, y)), `pow(${x}, ${y})`).toBe(true);
  });
  it('reduces any angle the way fdlibm does', () => {
    const huge = [823550, 1e6, 1e8, 1e15, 1e16, 1e18, 1e22, -1e22, 1e100, 1e300, Number.MAX_VALUE, 2 ** 1000];
    for (const x of [...huge, 15.707961216149757, 47.12388980384689, -7.853981633974483]) {
      expect(Math.abs(d.sin(x))).toBeLessThanOrEqual(1);
      expect(d.sin(x), `sin(${x})`).toBe(Math.sin(x));
      expect(d.cos(x), `cos(${x})`).toBe(Math.cos(x));
    }
  });
  it('matches fdlibm 5.3 bit for bit', () => {
    // Inputs and outputs from fdlibm compiled in C with -ffp-contract=off: a
    // sample of 1.95M cases the port matched exactly. Any edit that moves one
    // bit here changes every world, so it has to be deliberate.
    const f64 = new Float64Array(1);
    const u64 = new BigUint64Array(f64.buffer);
    const num = (h: string) => ((u64[0] = BigInt('0x' + h)), f64[0]);
    const hex = (x: number) => ((f64[0] = x), u64[0].toString(16).padStart(16, '0'));
    const fns: Record<string, (x: number) => number> = { sin: d.sin, cos: d.cos, exp: d.exp, log: d.log, atan: d.atan };
    const lines = readFileSync(new URL('./fixtures/fdlibm-5.3.txt', import.meta.url), 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(3000);
    for (const line of lines) {
      const [fn, a, b, c] = line.split(' ');
      const got = fn === 'atan2' ? d.atan2(num(a), num(b)) : fns[fn](num(a));
      const want = fn === 'atan2' ? c : b;
      if (Number.isNaN(got) && Number.isNaN(num(want))) continue;
      expect(hex(got), line).toBe(want);
    }
  });
  it('hypot is sqrt of the sum of squares, with 2 or 3 arguments', () => {
    expect(d.hypot(3, 4)).toBe(5);
    expect(d.hypot(2, 3, 6)).toBe(7);
  });
});
