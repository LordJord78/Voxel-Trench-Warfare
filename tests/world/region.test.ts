import { describe, expect, it } from 'vitest';
import { BrickMap } from '../../src/world/bricks';
import { Region, clampBox } from '../../src/world/region';

const D = { x: 64, y: 64, z: 64 };

describe('fillBox', () => {
  it('fills whole bricks as uniform and partial ones per voxel', () => {
    const w = new BrickMap(D);
    w.fillBox(0, 0, 0, 20, 16, 16, 4);
    expect(w.get(19, 15, 15)).toBe(4);
    expect(w.get(20, 0, 0)).toBe(0);
    w.takeDirty();
    expect(w.denseCount).toBe(4);
  });
  it('clamps, and ignores empty or inverted boxes', () => {
    const w = new BrickMap(D);
    w.fillBox(-10, -10, -10, 4, 4, 4, 2);
    expect(w.get(0, 0, 0)).toBe(2);
    expect(() => w.fillBox(10, 10, 10, 5, 5, 5, 2)).not.toThrow();
    expect(() => w.fillBox(100, 0, 0, 200, 8, 8, 2)).not.toThrow();
    expect(w.get(3, 3, 3)).toBe(2);
  });
});

describe('Region', () => {
  it('copies a box out and writes back only what changed', () => {
    const w = new BrickMap(D);
    w.fillBox(0, 0, 0, 64, 10, 64, 3);
    const r = Region.extract(w, { x0: 5, y0: 5, z0: 5, x1: 30, y1: 20, z1: 30 });
    expect(r.get(5, 9, 5)).toBe(3);
    expect(r.get(5, 10, 5)).toBe(0);
    r.set(6, 9, 6, 0);
    r.set(6, 15, 6, 8);
    expect(r.commit(w)).toBe(2);
    expect(w.get(6, 9, 6)).toBe(0);
    expect(w.get(6, 15, 6)).toBe(8);
  });
  it('clamps boxes to the world', () => {
    expect(clampBox({ x0: -5, y0: 0, z0: 0, x1: 10, y1: 99, z1: 4 }, D)).toEqual({ x0: 0, y0: 0, z0: 0, x1: 10, y1: 64, z1: 4 });
    expect(clampBox({ x0: 70, y0: 0, z0: 0, x1: 80, y1: 1, z1: 1 }, D)).toBeNull();
  });
});
