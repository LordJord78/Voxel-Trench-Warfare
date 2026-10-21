import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { BrickMap, UNIFORM } from '../../src/world/bricks';
import { HeapMirror, RECORD_UNITS, decodeBrick, encodeBrick, formatOfLength, tableEntry } from '../../src/world/encode';

function brickWith(distinct: number, seed: number): Uint8Array {
  const r = Rng.root(seed);
  const raw = new Uint8Array(512);
  for (let i = 0; i < 512; i++) raw[i] = r.chance(0.3) ? 0 : 1 + r.randint(0, distinct);
  for (let k = 0; k < distinct; k++) raw[k] = 1 + k;
  return raw;
}

describe('encodeBrick', () => {
  it('picks the smallest format and round-trips', () => {
    for (const [distinct, format] of [[1, 0], [2, 1], [3, 2], [4, 2], [5, 3], [16, 3], [17, 4], [200, 4]] as const) {
      const raw = brickWith(distinct, distinct);
      const rec = encodeBrick(raw);
      expect(rec.length, `${distinct} distinct`).toBe(RECORD_UNITS[format] * 4);
      expect(formatOfLength(rec.length)).toBe(format);
      const out = new Uint8Array(512);
      decodeBrick(rec, out);
      expect(out).toEqual(raw);
    }
  });
  it('lays out the mask one bit per voxel', () => {
    const raw = new Uint8Array(512);
    raw[0] = 5; raw[33] = 5;
    const rec = encodeBrick(raw);
    expect(rec[4]).toBe(1);
    expect(rec[5]).toBe(2);
    expect(rec[0] & 0xff).toBe(5);
  });
  it('builds table entries that are never zero', () => {
    expect(tableEntry(3, 1)).toBe(((3 << 28) | 1) >>> 0);
    expect(() => tableEntry(0, 0)).toThrow(RangeError);
  });
});

describe('HeapMirror', () => {
  it('packs the initial heap and re-encodes changed bricks, reusing freed records', () => {
    const w = new BrickMap({ x: 32, y: 32, z: 32 });
    w.set(0, 0, 0, 3);
    w.set(8, 0, 0, 3);
    const c = w.brickIndex(2, 0, 0);
    w.setUniform(c, 6);
    w.takeDirty();
    const h = HeapMirror.fromMap(w);
    const a = w.brickIndex(0, 0, 0);
    const b = w.brickIndex(1, 0, 0);
    expect(h.gpuTable[c]).toBe((UNIFORM | 6) >>> 0);
    expect(h.gpuTable[a]).toBe(tableEntry(0, 1));
    expect(h.usedUnits).toBe(1 + 2 * RECORD_UNITS[0]);
    for (let i = 0; i < 20; i++) w.set(i % 8, 1 + (i >> 3), 1, 10 + i);
    h.update(w.takeDirty());
    expect(h.gpuTable[a] >>> 28).toBe(4);
    expect(h.takeTableWrites()).toEqual([a]);
    expect(h.takeWrites()).toHaveLength(1);
    w.set(16, 0, 0, 0);
    h.update(w.takeDirty());
    expect(h.gpuTable[c]).toBe(tableEntry(0, 1));
    const live = [a, b, c]
      .map((bi) => { const e = h.gpuTable[bi]; const u = e & 0x0fffffff; return [u, u + RECORD_UNITS[e >>> 28]]; })
      .sort((p, q) => p[0] - q[0]);
    for (let i = 1; i < live.length; i++) expect(live[i - 1][1]).toBeLessThanOrEqual(live[i][0]);
    const out = new Uint8Array(512);
    const ea = h.gpuTable[a];
    const ua = ea & 0x0fffffff;
    decodeBrick(h.heapImage().subarray(ua * 4, (ua + RECORD_UNITS[ea >>> 28]) * 4), out);
    expect(out[1 + 8 + 64]).toBe(11);
  });
});
