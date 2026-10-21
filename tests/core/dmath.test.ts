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
  it('hypot is sqrt of the sum of squares, with 2 or 3 arguments', () => {
    expect(d.hypot(3, 4)).toBe(5);
    expect(d.hypot(2, 3, 6)).toBe(7);
  });
});
