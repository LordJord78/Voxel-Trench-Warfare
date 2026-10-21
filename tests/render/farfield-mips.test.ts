import { describe, expect, it } from 'vitest';
import { farFieldMips, prepareFarHeights } from '../../src/render/farfield-mips';

/** A size × size field from a function of the sample's (i, j). */
const field = (size: number, f: (i: number, j: number) => number) => {
  const h = new Float32Array(size * size);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) h[j * size + i] = f(i, j);
  return h;
};

describe('far-field max mips', () => {
  it('holds at level 0 the highest corner of each patch', () => {
    const levels = farFieldMips(field(4, (i, j) => i + 10 * j), 4);
    expect(levels[0][0]).toBe(11);
    expect(levels[0][1 * 4 + 2]).toBe(23);
    // The last row and column repeat their edge.
    expect(levels[0][3 * 4 + 3]).toBe(33);
  });
  it('leaves a patch empty unless all four corners are ground', () => {
    const h = field(4, (i, j) => (i >= 2 && j >= 2 ? -Infinity : 5));
    const levels = farFieldMips(h, 4);
    expect(levels[0][1 * 4 + 1]).toBe(-Infinity);
    expect(levels[0][2 * 4 + 2]).toBe(-Infinity);
    expect(levels[0][0]).toBe(5);
  });
  it('builds every level down to one cell, each the max of the four below', () => {
    const levels = farFieldMips(field(2048, (i, j) => Math.sin(i * 0.01) * 40 + Math.cos(j * 0.013) * 30), 2048);
    expect(levels).toHaveLength(12);
    expect(levels[11]).toHaveLength(1);
    for (let k = 1; k < levels.length; k++) {
      const n = 2048 >> k;
      for (const [i, j] of [[0, 0], [n - 1, n - 1], [n >> 1, n >> 2]]) {
        const below = levels[k - 1];
        const m = Math.max(below[2 * j * 2 * n + 2 * i], below[2 * j * 2 * n + 2 * i + 1], below[(2 * j + 1) * 2 * n + 2 * i], below[(2 * j + 1) * 2 * n + 2 * i + 1]);
        expect(levels[k][j * n + i]).toBe(m);
      }
    }
    expect(levels[11][0]).toBe(levels[0].reduce((m, v) => Math.max(m, v), -Infinity));
  });
  it('extends the ground one ring into the map, so no crack opens at its edge', () => {
    const h = field(8, (i, j) => (i >= 2 && i < 6 && j >= 2 && j < 6 ? -Infinity : 7));
    const p = prepareFarHeights(h, 8);
    expect(p[2 * 8 + 2]).toBe(7);
    expect(p[2 * 8 + 4]).toBe(7);
    expect(p[3 * 8 + 3]).toBe(-Infinity);
    expect(h[2 * 8 + 2]).toBe(-Infinity);
  });
});
