import { describe, expect, it } from 'vitest';
import { KEY_MAP_SIZE, KEY_SLOTS, keyShadowInfo, keySlot, type KeyShadowInfo } from '../../src/render/key-shadow';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';
import { mapCoords, OPEN, texelDepth, texelRay } from '../support/key-shadow-ref';
import type { Vec3 } from '../support/trace-ref';

const MAP = { x: 2560, y: 320, z: 2560 };
const dir = (azimuthDeg: number, elevationDeg: number): Vec3 => {
  const a = (azimuthDeg * Math.PI) / 180;
  const e = (elevationDeg * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
};
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const finite = (info: KeyShadowInfo) => [...info.u, ...info.v, ...info.along, ...info.origin, info.texel, info.reach].every(Number.isFinite);
const KEYS: [number, number][] = [[18, 4.5], [204, 30], [90, 60], [45, 45], [300, 1], [0, 89.99], [0, 90]];

describe("the key light's height map, on the CPU", () => {
  it('lies square to the light: u level, and u, v and the way the light runs at right angles', () => {
    for (const [az, el] of KEYS) {
      const key = dir(az, el);
      const info = keyShadowInfo(MAP, 0.1, key);
      expect(info.u[1]).toBe(0);
      for (const a of [info.u, info.v, info.along]) expect(Math.hypot(...a)).toBeCloseTo(1, 9);
      expect(dot(info.u, info.v)).toBeCloseTo(0, 9);
      expect(dot(info.u, info.along)).toBeCloseTo(0, 9);
      expect(dot(info.v, info.along)).toBeCloseTo(0, 9);
      info.along.forEach((c, k) => expect(c).toBeCloseTo(-key[k], 9));
    }
  });

  it('covers the whole map from any side, in texels of a quarter metre or more', () => {
    for (const [az, el] of KEYS) {
      const info = keyShadowInfo(MAP, 0.1, dir(az, el));
      expect(info.texel).toBeGreaterThanOrEqual(2.5);
      for (const corner of [0, 1, 2, 3, 4, 5, 6, 7]) {
        const p: Vec3 = [corner & 1 ? MAP.x : 0, corner & 2 ? MAP.y : 0, corner & 4 ? MAP.z : 0];
        const { s, t, depth } = mapCoords(info, p);
        for (const c of [s, t]) {
          expect(c).toBeGreaterThan(0);
          expect(c).toBeLessThan(KEY_MAP_SIZE);
        }
        // Its rays start before every corner.
        expect(depth).toBeGreaterThan(-info.reach);
      }
    }
    // A small map is still a quarter metre a texel.
    expect(keyShadowInfo({ x: 128, y: 128, z: 128 }, 0.1, dir(18, 30)).texel).toBe(2.5);
  });

  it('at 1° elevation its texels are at most 2 m, with no NaN; so too overhead and below the horizon', () => {
    const low = keyShadowInfo(MAP, 0.1, dir(18, 1));
    expect(finite(low)).toBe(true);
    expect(low.texel).toBeLessThanOrEqual(20);
    // A map too wide for 2 m texels stops at 2 m.
    expect(keyShadowInfo({ x: 30000, y: 320, z: 30000 }, 0.1, dir(18, 1)).texel).toBe(20);
    for (const key of [dir(0, 90), dir(200, -5), dir(200, -90)]) expect(finite(keyShadowInfo(MAP, 0.1, key))).toBe(true);
  });

  it('traces every texel once in 16 frames, a texel of every 4 × 4 block each frame, and again', () => {
    expect(KEY_SLOTS).toBe(16);
    const seen = new Set<string>();
    for (let k = 0; k < KEY_SLOTS; k++) {
      const [x, y] = keySlot(k);
      expect([x, y].every((c) => Number.isInteger(c) && c >= 0 && c < 4)).toBe(true);
      seen.add(`${x},${y}`);
      expect(keySlot(k + KEY_SLOTS)).toEqual(keySlot(k));
    }
    expect(seen.size).toBe(16);
  });

  it("finds a texel's depth where its ray from past the map first meets the world, along the light from the map's middle", () => {
    const map = new BrickMap({ x: 64, y: 64, z: 64 });
    map.fillBox(0, 0, 0, 64, 10, 64, P.SOD);
    const info = keyShadowInfo(map.dims, 0.1, dir(30, 45));
    // The texels around the middle meet the floor's top, y = 10.
    for (const [i, j] of [[512, 512], [509, 514], [515, 510]]) {
      const { o, d } = texelRay(info, i, j);
      const t = (o[1] - 10) / -d[1];
      const at = [o[0] + d[0] * t, o[2] + d[2] * t];
      expect(at.every((c) => c > 0 && c < 64)).toBe(true);
      expect(texelDepth(map, info, i, j)).toBeCloseTo(t - info.reach, 3);
    }
    // A texel whose ray passes the map by is open.
    expect(texelDepth(map, info, 0, 0)).toBe(OPEN);
    expect(texelDepth(map, info, 512, 1000)).toBe(OPEN);
  });
});
