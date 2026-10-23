import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { cameraBasis, halton, jitter, projectToPixel, rayDir, type CameraPose } from '../../src/render/camera';

const close = (a: readonly number[], b: readonly number[], eps = 1e-12) => a.every((v, i) => Math.abs(v - b[i]) <= eps);

describe('the camera', () => {
  it('looks down +z with +x to the right at yaw 0, as the Python game did', () => {
    const b = cameraBasis(0, 0);
    expect(close(b.forward, [0, 0, 1])).toBe(true);
    expect(close(b.right, [1, 0, 0])).toBe(true);
    expect(close(b.up, [0, 1, 0])).toBe(true);
  });
  it('turns toward +x at yaw 90', () => {
    const b = cameraBasis(90, 0);
    expect(close(b.forward, [1, 0, 0])).toBe(true);
    expect(close(b.right, [0, 0, -1])).toBe(true);
  });
  it('roll 0 is the old basis exactly', () => {
    for (const [y, p] of [[0, 0], [37, -12], [200, 60]]) expect(cameraBasis(y, p, 0)).toEqual(cameraBasis(y, p));
  });
  it('a rolled pose turns right toward up about forward and stays orthonormal, at pitch ±88° too', () => {
    const dot = (a: readonly number[], c: readonly number[]) => a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
    const r = (10 * Math.PI) / 180;
    for (const pitch of [-88, -12, 0, 30, 88]) {
      const b0 = cameraBasis(37, pitch);
      const b = cameraBasis(37, pitch, 10);
      expect(close(b.forward, b0.forward)).toBe(true);
      expect(dot(b.right, b0.right)).toBeCloseTo(Math.cos(r), 12);
      expect(dot(b.right, b0.up)).toBeCloseTo(Math.sin(r), 12);
      for (const v of [b.forward, b.right, b.up]) expect(Math.hypot(v[0], v[1], v[2])).toBeCloseTo(1, 12);
      expect(dot(b.forward, b.right)).toBeCloseTo(0, 12);
      expect(dot(b.forward, b.up)).toBeCloseTo(0, 12);
      expect(dot(b.right, b.up)).toBeCloseTo(0, 12);
    }
  });
  it('projects through a rolled pose and back', () => {
    const pose: CameraPose = { position: [10, 2, 30], yaw: 37, pitch: -12, roll: 8 };
    const res: [number, number] = [1600, 900];
    const d = rayDir(pose, res, 400.5, 200.5);
    const back = projectToPixel(pose, res, [pose.position[0] + d[0] * 20, pose.position[1] + d[1] * 20, pose.position[2] + d[2] * 20])!;
    expect(back[0]).toBeCloseTo(400.5, 6);
    expect(back[1]).toBeCloseTo(200.5, 6);
  });
  it('jitters by the Halton (2, 3) sequence', () => {
    expect([halton(1, 2), halton(2, 2), halton(3, 2)]).toEqual([0.5, 0.25, 0.75]);
    expect(halton(1, 3)).toBeCloseTo(1 / 3, 15);
    expect(halton(2, 3)).toBeCloseTo(2 / 3, 15);
    const [jx, jy] = jitter(0);
    expect(jx).toBe(0);
    expect(jy).toBeCloseTo(-1 / 6, 15);
    expect(jitter(16)).toEqual(jitter(0));
  });
  it('projects each pixel ray back onto its pixel', () => {
    const pose: CameraPose = { position: [10, 2, 30], yaw: 37, pitch: -12 };
    const res: [number, number] = [1600, 900];
    const rng = Rng.root(1);
    for (let i = 0; i < 100; i++) {
      const px = rng.uniform(0, res[0]);
      const py = rng.uniform(0, res[1]);
      const d = rayDir(pose, res, px, py);
      const point: [number, number, number] = [pose.position[0] + d[0] * 25, pose.position[1] + d[1] * 25, pose.position[2] + d[2] * 25];
      const back = projectToPixel(pose, res, point)!;
      expect(Math.abs(back[0] - px)).toBeLessThan(1e-9);
      expect(Math.abs(back[1] - py)).toBeLessThan(1e-9);
    }
    expect(projectToPixel(pose, res, [pose.position[0] - 100 * Math.sin((37 * Math.PI) / 180), 2, pose.position[2] - 100 * Math.cos((37 * Math.PI) / 180)])).toBeNull();
  });
  it('spans 90 degrees across the screen', () => {
    const pose: CameraPose = { position: [0, 0, 0], yaw: 20, pitch: 10 };
    const res: [number, number] = [1500, 1000];
    const { forward } = cameraBasis(pose.yaw, pose.pitch);
    const centre = rayDir(pose, res, 750, 500);
    expect(close(centre, forward, 1e-12)).toBe(true);
    const edge = rayDir(pose, res, 0, 500);
    const angle = Math.acos(edge[0] * forward[0] + edge[1] * forward[1] + edge[2] * forward[2]);
    expect(Math.abs(angle - Math.PI / 4)).toBeLessThan(1e-9);
  });

  it('narrows to its field of view: a 60° camera sees 30° either side', () => {
    const pose: CameraPose = { position: [0, 0, 0], yaw: 30, pitch: 10, fov: 60 };
    const { forward } = cameraBasis(30, 10);
    const res: [number, number] = [200, 100];
    for (const px of [0, 200]) {
      const d = rayDir(pose, res, px, 50);
      const cos = d[0] * forward[0] + d[1] * forward[1] + d[2] * forward[2];
      expect((Math.acos(cos) * 180) / Math.PI).toBeCloseTo(30, 9);
    }
  });
  it('projects back where it cast at any field of view', () => {
    const pose: CameraPose = { position: [1, 2, 3], yaw: -40, pitch: 20, fov: 60 };
    const res: [number, number] = [320, 180];
    const rng = Rng.root(5);
    for (let i = 0; i < 100; i++) {
      const px = rng.uniform(0, 320);
      const py = rng.uniform(0, 180);
      const d = rayDir(pose, res, px, py);
      const p = projectToPixel(pose, res, [1 + d[0] * 7, 2 + d[1] * 7, 3 + d[2] * 7])!;
      expect(close(p, [px, py], 1e-9)).toBe(true);
    }
  });
});

