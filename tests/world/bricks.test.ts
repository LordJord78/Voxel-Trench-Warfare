import { describe, expect, it } from 'vitest';
import { BrickMap, UNIFORM } from '../../src/world/bricks';

const D = { x: 64, y: 32, z: 64 };

describe('BrickMap', () => {
  it('refuses dims that are not whole sectors', () => {
    expect(() => new BrickMap({ x: 40, y: 32, z: 32 })).toThrow(RangeError);
  });
  it('round-trips voxels and reads outside as air', () => {
    const w = new BrickMap(D);
    w.set(3, 4, 5, 7);
    expect(w.get(3, 4, 5)).toBe(7);
    expect(w.get(3, 4, 6)).toBe(0);
    expect(w.get(-1, 0, 0)).toBe(0);
    w.set(99, 0, 0, 7);
    expect(w.denseCount).toBe(1);
  });
  it('rejects palette ids a byte cannot hold', () => {
    const w = new BrickMap(D);
    expect(() => w.set(0, 0, 0, 256)).toThrow(RangeError);
    expect(() => w.set(0, 0, 0, 1.5)).toThrow(RangeError);
  });
  it('splits a uniform brick on write and compacts it back', () => {
    const w = new BrickMap(D);
    const bi = w.brickIndex(1, 1, 1);
    w.setUniform(bi, 4);
    expect(w.table[bi]).toBe((UNIFORM | 4) >>> 0);
    w.set(9, 9, 9, 2);
    expect(w.denseCount).toBe(1);
    expect(w.get(10, 10, 10)).toBe(4);
    w.set(9, 9, 9, 4);
    expect(w.takeDirty()).toEqual([bi]);
    expect(w.table[bi]).toBe((UNIFORM | 4) >>> 0);
    expect(w.denseCount).toBe(0);
  });
  it('reuses freed slots instead of growing', () => {
    const w = new BrickMap(D);
    for (let round = 0; round < 50; round++) {
      for (let x = 0; x < 64; x += 8) w.set(x, 0, 0, 3);
      w.takeDirty();
      for (let x = 0; x < 64; x += 8) w.set(x, 0, 0, 0);
      w.takeDirty();
    }
    expect(w.denseCount).toBe(0);
    expect(w.slotsIssued).toBe(8);
  });
  it('refuses brick indices outside the table and short bricks', () => {
    const w = new BrickMap(D);
    const raw = new Uint8Array(512);
    for (const bad of [-1, w.table.length, w.table.length + 3, 1.5, NaN]) {
      expect(() => w.writeBrick(bad, raw), `writeBrick ${bad}`).toThrow(RangeError);
      expect(() => w.setUniform(bad, 3), `setUniform ${bad}`).toThrow(RangeError);
      expect(() => w.readBrick(bad, raw), `readBrick ${bad}`).toThrow(RangeError);
      expect(() => w.denseView(bad), `denseView ${bad}`).toThrow(RangeError);
      expect(() => w.compact(bad), `compact ${bad}`).toThrow(RangeError);
    }
    expect(() => w.writeBrick(0, new Uint8Array(100))).toThrow(RangeError);
    w.set(9, 9, 9, 4);
    expect(w.get(9, 9, 9)).toBe(4);
  });
  it('counts non-empty bricks per sector', () => {
    const w = new BrickMap(D);
    w.set(33, 1, 1, 5);
    w.set(40, 1, 1, 5);
    expect(w.sectorCount(1)).toBe(2);
    expect(Array.from(w.sectorMask())).toEqual([0, 1, 0, 0]);
    w.set(33, 1, 1, 0);
    w.set(40, 1, 1, 0);
    w.takeDirty();
    expect(w.sectorCount(1)).toBe(0);
  });
  it('reads and writes whole bricks', () => {
    const w = new BrickMap(D);
    const raw = new Uint8Array(512);
    raw[0] = 9; raw[511] = 9;
    const bi = w.brickIndex(0, 0, 0);
    w.writeBrick(bi, raw);
    expect(w.get(0, 0, 0)).toBe(9);
    expect(w.get(7, 7, 7)).toBe(9);
    const out = new Uint8Array(512);
    w.readBrick(bi, out);
    expect(out).toEqual(raw);
    w.setUniform(bi, 0);
    expect(w.table[bi]).toBe(0);
    expect(w.denseCount).toBe(0);
  });
});
