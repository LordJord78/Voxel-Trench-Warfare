import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../src/core/tunables';
import { overlayText, placeName, type OverlayInfo } from '../../src/ui/overlay';
import { genParams } from '../../src/world/generation/params';
import { planWorld } from '../../src/world/generation/plan';

const MB = 1024 * 1024;
const info: OverlayInfo = {
  gpuMs: 9.84,
  passes: { primary: 2.1, lighting: 4.02, temporal: 0.21, atrous1: 0.3, atrous2: 0.31, atrous3: 0.32, shade: 0.45, taa: 0.5, cas: 0.15, present: 0.2 },
  fps: 101.4,
  res: [1225, 689],
  alloc: [1633, 919],
  scale: 0.75,
  preset: 'high',
  dynres: true,
  world: { denseBricks: 123456, heapUsedBytes: 512.3 * MB, heapCapacityBytes: 640.4 * MB, tableBytes: 52.4 * MB, pending: 3 },
  position: [123.45, 5.6, 78.9],
  yaw: 90,
  pitch: -8,
  timeOfDay: 19.25,
  place: 'front bay 12',
};

describe('the F3 overlay', () => {
  it('shows every pass, the GPU total and the frame rate', () => {
    const t = overlayText(info);
    expect(t).toContain('GPU 9.84 ms');
    expect(t).toContain('101 fps');
    for (const [name, ms] of Object.entries(info.passes)) expect(t).toMatch(new RegExp(`${name}\\s+${ms.toFixed(2)}`));
  });
  it('shows the internal image, its scale and the preset', () => {
    const t = overlayText(info);
    expect(t).toContain('1225×689 of 1633×919 (75%)');
    expect(t).toContain('preset high, dynamic');
    expect(overlayText({ ...info, dynres: false, preset: 'low' })).toContain('preset low, fixed');
  });
  it('shows the world in memory', () => {
    const t = overlayText(info);
    expect(t).toContain('123,456 dense bricks');
    expect(t).toContain('heap 512.3 / 640.4 MB');
    expect(t).toContain('table 52.4 MB');
    expect(t).toContain('3 uploads pending');
  });
  it('shows where the camera is, which way it looks, and when', () => {
    const t = overlayText(info);
    expect(t).toContain('123.5, 5.6, 78.9 m');
    expect(t).toContain('yaw 90° pitch -8°');
    expect(t).toContain('19:15');
    expect(t).toContain('front bay 12');
  });
  it('says so when the GPU is not timed', () => {
    const t = overlayText({ ...info, gpuMs: null, passes: {} });
    expect(t).toContain('GPU not timed');
    expect(t).not.toContain('primary');
  });
});

describe('place names', () => {
  const p = genParams(loadTunables());
  const plan = planWorld(p, 7);
  const v = p.voxel;
  const centre = (b: { x0: number; x1: number; z0: number; z1: number }) => [((b.x0 + b.x1) / 2) * v, ((b.z0 + b.z1) / 2) * v] as const;
  it('name a bay by its line and number', () => {
    const front = plan.lines.findIndex((l) => l.spec.name === 'front');
    expect(placeName(plan, ...centre(plan.lines[front].bays[12]))).toBe('front bay 12');
    const enemy = plan.lines.findIndex((l) => l.spec.name === 'enemy_support');
    expect(placeName(plan, ...centre(plan.lines[enemy].bays[3]))).toBe('enemy support bay 3');
  });
  it('say the open ground when no trench is there', () => {
    expect(placeName(plan, 0.05, 0.05)).toBe('open ground');
  });
});
