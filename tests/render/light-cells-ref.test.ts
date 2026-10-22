import { describe, expect, it } from 'vitest';
import { cellLists, type RefLight } from '../support/light-cells-ref';

// 8 m cells at 10 cm voxels, four across and three deep.
const SIDE = 80;
const GRID: [number, number] = [4, 3];
const light = (x: number, z: number, radius: number, y = 200): RefLight => ({ pos: [x, y, z], radius });
const cellsOf = (lists: number[][], i: number) => lists.flatMap((l, c) => (l.includes(i) ? [[c % GRID[0], Math.floor(c / GRID[0])]] : []));

describe('the light cells, on the CPU', () => {
  it('lists a light in every square its sphere reaches across x and z, at any height, and in no other', () => {
    // In the middle of cell (1, 1), 40 voxels from each edge and 56.6 from each corner.
    const lists = cellLists([light(120, 120, 30), light(120, 120, 45), light(120, 120, 60, 5000)], GRID, SIDE, 32);
    expect(cellsOf(lists, 0)).toEqual([[1, 1]]);
    expect(cellsOf(lists, 1)).toEqual([[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]]);
    expect(cellsOf(lists, 2)).toEqual([[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]]);
  });

  it('reaches a square across its far edges as across its near ones', () => {
    // 9 voxels past cell (1, 1)'s far x edge, and its far z edge.
    const lists = cellLists([light(169, 120, 9.5), light(120, 169, 9.5)], GRID, SIDE, 32);
    expect(cellsOf(lists, 0)).toEqual([[1, 1], [2, 1]]);
    expect(cellsOf(lists, 1)).toEqual([[1, 1], [1, 2]]);
  });

  it('leaves out a square exactly at a light\'s radius, where its light is nothing', () => {
    expect(cellsOf(cellLists([light(120, 120, 40)], GRID, SIDE, 32), 0)).toEqual([[1, 1]]);
  });

  it('lists a light off the map in the squares at the edge it reaches', () => {
    expect(cellsOf(cellLists([light(-10, 120, 15)], GRID, SIDE, 32), 0)).toEqual([[0, 1]]);
  });

  it('keeps the nearest of a crowd, nearest first, the lower index first between lights as near', () => {
    // 40 lights in cell (2, 1), whose middle is (200, 120), either side of it in turn: light i
    // (38 - i) / 2 voxels from it, and lights 38 and 39 as near as light 37.
    const crowd = Array.from({ length: 40 }, (_, i) => light(200 + (i % 2 ? -1 : 1) * (i < 38 ? 38 - i : 1) * 0.5, 120, 10));
    const list = cellLists(crowd, GRID, SIDE, 32)[1 * GRID[0] + 2];
    expect(list).toHaveLength(32);
    expect(list.slice(0, 3)).toEqual([37, 38, 39]);
    expect(list.slice(3)).toEqual(Array.from({ length: 29 }, (_, k) => 36 - k));
  });

  it('lists nothing in a square no light reaches, and never a light that is not a number', () => {
    const lists = cellLists([light(120, 120, 30), light(Number.NaN, 120, 30), light(120, 120, Number.NaN)], GRID, SIDE, 32);
    expect(lists.filter((l) => l.length > 0)).toEqual([[0]]);
  });
});
