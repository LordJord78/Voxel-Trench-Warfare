import { describe, expect, it } from 'vitest';
import { soldierModel, TAPE } from '../../src/combat/soldier-model';
import { bodySphere, hitParts, PART_BOX, PARTS, pose, toWorld, twoBone, type Frame, type PoseInput } from '../../src/combat/soldier-rig';

const at = (over: Partial<PoseInput> = {}): PoseInput => ({ position: [10, 2, 20], yaw: 0, pitch: 0, height: 1.8, speed: 0, bob: 0, deadFor: null, ...over });

/** The highest and lowest of a posed body's part boxes' corners. */
function extent(frames: Record<string, Frame>): { top: number; bottom: number } {
  let top = -Infinity;
  let bottom = Infinity;
  for (const part of PARTS) {
    if (part === 'rifle') continue;
    const { min, max } = PART_BOX[part];
    for (let c = 0; c < 8; c++) {
      const y = toWorld(frames[part], [c & 1 ? max[0] : min[0], c & 2 ? max[1] : min[1], c & 4 ? max[2] : min[2]])[1];
      top = Math.max(top, y);
      bottom = Math.min(bottom, y);
    }
  }
  return { top, bottom };
}

describe("a soldier's rig", () => {
  it('stands as tall as the controller says, crouches and lies down, feet on the ground', () => {
    for (const [height, tallest, lowest] of [[1.8, 1.85, 1.65], [1.25, 1.4, 1.0], [0.55, 0.75, 0.2]] as const) {
      const { top, bottom } = extent(pose(at({ height })));
      expect(top - 2, `height ${height}`).toBeLessThan(tallest);
      expect(top - 2, `height ${height}`).toBeGreaterThan(lowest);
      expect(bottom - 2, `height ${height}`).toBeGreaterThan(-0.12);
      expect(bottom - 2, `height ${height}`).toBeLessThan(0.1);
    }
  });

  it('gives every part a square, unit frame, walking or not, alive or falling', () => {
    for (const p of [at(), at({ speed: 6, bob: 1.1, pitch: 30, yaw: 123 }), at({ height: 0.9, speed: 1, bob: 4 }), at({ deadFor: 0.4 }), at({ deadFor: 3, height: 0.55 })]) {
      const frames = pose(p);
      for (const part of PARTS) {
        const f = frames[part];
        const d = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        for (const [a, b, want] of [[f.x, f.x, 1], [f.y, f.y, 1], [f.z, f.z, 1], [f.x, f.y, 0], [f.y, f.z, 0], [f.x, f.z, 0]] as const) expect(d(a, b), part).toBeCloseTo(want, 6);
        // Right-handed: x is y × z.
        const c = [f.y[1] * f.z[2] - f.y[2] * f.z[1], f.y[2] * f.z[0] - f.y[0] * f.z[2], f.y[0] * f.z[1] - f.y[1] * f.z[0]];
        c.forEach((v, k) => expect(v, part).toBeCloseTo(f.x[k], 6));
      }
    }
  });

  it('holds the rifle along the aim, and falls when killed', () => {
    const r = pose(at({ yaw: 90, pitch: 20 })).rifle;
    expect(r.z[0]).toBeCloseTo(Math.cos((20 * Math.PI) / 180), 5);
    expect(r.z[1]).toBeCloseTo(Math.sin((20 * Math.PI) / 180), 5);
    expect(extent(pose(at({ deadFor: 2 }))).top - 2).toBeLessThan(0.6);
    expect(extent(pose(at({ deadFor: 0 }))).top - 2).toBeGreaterThan(1.6);
  });

  it('reaches with two bones by the law of cosines', () => {
    const { joint, end } = twoBone([0, 1, 0], [0, 0.2, 0.3], 0.5, 0.5, [0, 0, 1]);
    expect(Math.hypot(joint[0], joint[1] - 1, joint[2])).toBeCloseTo(0.5, 9);
    expect(Math.hypot(end[0] - joint[0], end[1] - joint[1], end[2] - joint[2])).toBeCloseTo(0.5, 9);
    expect(joint[2]).toBeGreaterThan(0.15);
    // Out of reach: straight toward it.
    const far = twoBone([0, 0, 0], [0, 0, 5], 0.5, 0.5, [0, 1, 0]);
    expect(far.end[2]).toBeCloseTo(1, 3);
  });
});

describe('a round against a body', () => {
  const frames = pose(at());
  const across = (y: number, z = 20) => hitParts(frames, [5, 2 + y, z], [1, 0, 0], 10);
  it('strikes the head, the torso or a limb by where it passes, and nothing over the helmet', () => {
    expect(across(1.65)?.zone).toBe('head');
    expect(across(1.3)?.zone).toBe('torso');
    expect(across(0.3)?.zone).toBe('limb');
    expect(across(2.2)).toBeNull();
    expect(across(1.3, 21)).toBeNull();
    const hit = across(1.3)!;
    expect(hit.t).toBeGreaterThan(4.6);
    expect(hit.t).toBeLessThan(5);
  });
  it('lets a segment that ends short of the body pass, and the sphere holds every part', () => {
    expect(hitParts(frames, [5, 3.3, 20], [1, 0, 0], 4.5)).toBeNull();
    const { centre, radius } = bodySphere([10, 2, 20]);
    for (const p of [at({ height: 0.55 }), at({ deadFor: 5 }), at({ speed: 6, bob: 2 })]) {
      const f = pose(p);
      for (const part of PARTS) {
        if (part === 'rifle') continue;
        const { min, max } = PART_BOX[part];
        for (let c = 0; c < 8; c++) {
          const w = toWorld(f[part], [c & 1 ? max[0] : min[0], c & 2 ? max[1] : min[1], c & 4 ? max[2] : min[2]]);
          expect(Math.hypot(w[0] - centre[0], w[1] - centre[1], w[2] - centre[2]), part).toBeLessThan(radius);
        }
      }
    }
  });
});

describe("a soldier's voxels", () => {
  const model = soldierModel();
  it('fills every part, within its box, and wears the tape on the helmet and the left arm only', () => {
    for (const part of PARTS) {
      const g = model[part];
      const filled = g.voxels.filter((v) => v !== 0).length;
      expect(filled, part).toBeGreaterThan(20);
      const taped = g.voxels.some((v) => v === TAPE);
      expect(taped, part).toBe(part === 'head' || part === 'upperArmL');
      if (part === 'rifle') continue;
      const { min, max } = PART_BOX[part];
      for (let k = 0; k < 3; k++) {
        expect(-g.origin[k] * g.voxelM, part).toBeCloseTo(min[k], 6);
        expect((g.dims[k] - g.origin[k]) * g.voxelM, part).toBeGreaterThanOrEqual(max[k] - 1e-6);
      }
    }
  });
});
