import { describe, expect, it } from 'vitest';
import { waterTunables, type RingState } from '../../src/battle/water';
import { loadTunables } from '../../src/core/tunables';
import { FRAME, MAX_GLINTS, MAX_RINGS } from '../../src/render/frame-uniforms';
import { structLayout, StructWriter } from '../../src/render/layout';
import type { SceneLight } from '../../src/render/lights';
import { glintsFrom, STILL_WATER, waterFrameTunables, writeWater } from '../../src/render/water-frame';

// The frame's water (reflect.wgsl reads it): the director's rings, the newest 32, in voxels; the
// wind's roughness; and the glints, the frame's flares and fires, the brightest 32.
const tun = loadTunables();
const gt = waterFrameTunables(tun);
const wt = waterTunables(tun);
const V = 0.1;
const offsets = structLayout(FRAME).offsets;
const floats = (w: StructWriter, name: string, k: number) => Array.from(new Float32Array(w.buffer, offsets[name] + 16 * k, 4));
const u32 = (w: StructWriter, name: string) => new Uint32Array(w.buffer, offsets[name], 1)[0];

describe("the frame's water", () => {
  it('the frame takes the 32 newest rings, in voxels, and none at rest', () => {
    expect([MAX_RINGS, MAX_GLINTS]).toEqual([32, 32]);
    const rings: RingState[] = Array.from({ length: 40 }, (_, k) => ({ at: [10 + k, 1.6, 20], radiusM: 0.5, heightM: 0.02, age: 0.5 }));
    const w = new StructWriter(FRAME);
    writeWater(w, { rings, wind: [3, 4], slope: 0.06, seconds: 12.5 }, [], V, gt, wt);
    expect(u32(w, 'ringCount')).toBe(32);
    // The newest: the last 32 given.
    const first = floats(w, 'rings', 0);
    [10 + 8, 1.6, 20, 0.5].forEach((m, i) => expect(first[i]).toBeCloseTo(m / V, 3));
    const shape = floats(w, 'rings', 1);
    expect(shape[0]).toBeCloseTo(0.02 / V, 4);
    expect(shape[1]).toBeCloseTo((wt.ringWidthM + 0.1 * 0.5) / V, 4);
    expect(shape[2]).toBeCloseTo(wt.ringWavelengthM / V, 4);
    // The wind's way, and its slope.
    const wind = Array.from(new Float32Array(w.buffer, offsets.waterWind, 2));
    expect(wind[0]).toBeCloseTo(0.6, 6);
    expect(wind[1]).toBeCloseTo(0.8, 6);
    expect(new Float32Array(w.buffer, offsets.waterSlope, 1)[0]).toBeCloseTo(0.06, 6);
    expect(new Float32Array(w.buffer, offsets.reflectReach, 1)[0]).toBeCloseTo(gt.reflectM / V, 3);
    expect(new Float32Array(w.buffer, offsets.waterTime, 1)[0]).toBeCloseTo(12.5, 6);
    // At rest: still.
    const rest = new StructWriter(FRAME);
    writeWater(rest, STILL_WATER, [], V, gt, wt);
    expect(u32(rest, 'ringCount')).toBe(0);
    expect(new Float32Array(rest.buffer, offsets.waterSlope, 1)[0]).toBe(0);
  });

  it("the glints are the frame's flares and fires, the brightest 32, dimmed as their light is", () => {
    const light = (kind: SceneLight['kind'], intensity: number, x: number): SceneLight => ({ position: [x, 20, 50], radius: 30, colour: [1, 0.5, 0.25], intensity, kind, phase: 0 });
    const lights = [
      light('lantern', 2.5, 1),
      ...Array.from({ length: 30 }, (_, k) => light('flare', 100 + k, 10 + k)),
      ...Array.from({ length: 10 }, (_, k) => light('fire', 40, 60 + k)),
    ];
    const glints = glintsFrom(lights, 0.5, gt);
    expect(glints).toHaveLength(32);
    // No lantern; the brightest first: the flares, dimmed by the key to 50–64.5, then the fires at 40.
    const bright = glints.map((g) => g.radiance[0]);
    expect(bright).toEqual([...bright].sort((a, b) => b - a));
    expect(glints.some((g) => g.position[0] === 1)).toBe(false);
    const flare = glints.find((g) => g.position[0] === 39)!;
    expect(flare.radiance[0]).toBeCloseTo(129 * 0.5 * gt.gain, 6);
    expect(flare.radiusM).toBe(gt.flareM);
    // The fires (40, undimmed) are the faintest of those kept: two of them dropped.
    const fires = glints.filter((g) => g.radiusM === gt.fireM);
    expect(fires).toHaveLength(2);
    expect(fires[0].radiance[0]).toBeCloseTo(40 * gt.gain, 6);
  });
});
