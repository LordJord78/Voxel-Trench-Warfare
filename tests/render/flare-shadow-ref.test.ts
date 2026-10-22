import { describe, expect, it } from 'vitest';
import { FLARE_MAP_SIZE, paraboloid, unparaboloid } from '../../src/render/flare-shadows';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';
import { OPEN, texelDisc, texelDistance, texelRay } from '../support/flare-shadow-ref';
import type { Vec3 } from '../support/trace-ref';

const angle = (a: Vec3, b: Vec3) => Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));

describe("the flares' shadow maps, on the CPU", () => {
  it('lay the hemisphere below a flare on the unit disc, and back', () => {
    let s = 7;
    const rand = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    for (let k = 0; k < 500; k++) {
      const v: Vec3 = [rand() * 2 - 1, -rand(), rand() * 2 - 1];
      const l = Math.hypot(...v);
      const d: Vec3 = [v[0] / l, v[1] / l, v[2] / l];
      const [x, y] = paraboloid(d);
      expect(x * x + y * y).toBeLessThanOrEqual(1 + 1e-12);
      unparaboloid(x, y).forEach((c, i) => expect(c).toBeCloseTo(d[i], 9));
    }
    expect(paraboloid([0, -1, 0])).toEqual([0, 0]);
    const [x, y] = paraboloid([Math.SQRT1_2, 0, Math.SQRT1_2]);
    expect(Math.hypot(x, y)).toBeCloseTo(1, 12);
  });

  it('span some 0.9° a texel straight below the flare and 0.45° toward its horizon', () => {
    const half = FLARE_MAP_SIZE / 2;
    const below = angle(unparaboloid(...texelDisc(half, half)), unparaboloid(...texelDisc(half + 1, half)));
    const rim = angle(unparaboloid(...texelDisc(FLARE_MAP_SIZE - 2, half)), unparaboloid(...texelDisc(FLARE_MAP_SIZE - 1, half)));
    expect((below * 180) / Math.PI).toBeCloseTo(0.895, 2);
    expect((rim * 180) / Math.PI).toBeCloseTo(0.45, 1);
  });

  it("find a texel's distance where its ray from the flare first meets the world, within the flare's reach", () => {
    const map = new BrickMap({ x: 64, y: 64, z: 64 });
    map.fillBox(0, 0, 0, 64, 10, 64, P.SOD);
    const at: Vec3 = [32, 50, 32];
    for (const [i, j] of [[128, 128], [120, 140], [150, 100]]) {
      const ray = texelRay(at, i, j)!;
      const t = (ray.o[1] - 10) / -ray.d[1];
      expect(texelDistance(map, at, 650, i, j)).toBeCloseTo(t, 3);
      // Beyond its reach, the floor is not there for the flare.
      expect(texelDistance(map, at, t - 1, i, j)).toBe(OPEN);
    }
    // A texel off the disc has no ray.
    expect(texelRay(at, 0, 0)).toBeNull();
    expect(texelDistance(map, at, 650, 0, 0)).toBe(OPEN);
  });
});
