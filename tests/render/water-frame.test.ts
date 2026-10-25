import { describe, expect, it } from 'vitest';
import { waterTunables, type RingState } from '../../src/battle/water';
import { loadTunables } from '../../src/core/tunables';
import { FRAME, MAX_GLINTS, MAX_RINGS } from '../../src/render/frame-uniforms';
import { structLayout, StructWriter } from '../../src/render/layout';
import type { FireState } from '../../src/battle/director';
import { fireTunables } from '../../src/battle/fires';
import { flareTunables, type FlareState } from '../../src/battle/flares';
import { glintsFrom, glintTerms, STILL_WATER, waterFrameTunables, writeWater } from '../../src/render/water-frame';

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
    writeWater(w, { rings, wind: [3, 4], slope: 0.06, seconds: 12.5, glints: [] }, V, gt, wt);
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
    writeWater(rest, STILL_WATER, V, gt, wt);
    expect(u32(rest, 'ringCount')).toBe(0);
    expect(new Float32Array(rest.buffer, offsets.waterSlope, 1)[0]).toBe(0);
  });

  it("the glints are the battle's burning flares and fires as they are drawn, the brightest 32; none at rest", () => {
    const ft = flareTunables(tun);
    const fireT = fireTunables(tun);
    const terms = glintTerms(tun);
    const flare = (id: number, glow: number, stage: FlareState['stage'] = 'burning'): FlareState => ({ id, position: [10 + id, 30, 50], glow, stage, colour: [1, 0.88, 0.7] });
    const flares = [flare(1, 1), flare(2, 0, 'climb'), ...Array.from({ length: 20 }, (_, k) => flare(10 + k, 0.2 + 0.02 * k))];
    const fires: FireState[] = [{ id: 3, at: [5, 16, 5], strength: 1, size: 0.8, hamlet: false, dying: false }];
    const glints = glintsFrom(flares, fires, 0.5, terms);
    // Every burning flare and the fire; never more than 32.
    expect(glints).toHaveLength(22);
    expect(glintsFrom(Array.from({ length: 40 }, (_, k) => flare(100 + k, 1)), fires, 1, terms)).toHaveLength(MAX_GLINTS);
    const bright = glints.map((g) => 0.2126 * g.radiance[0] + 0.7152 * g.radiance[1] + 0.0722 * g.radiance[2]);
    expect(bright).toEqual([...bright].sort((a, b) => b - a));
    // A burning flare's: its drawn disc, as bright as it is drawn (dimmed by the sky's key, as the disc is).
    const full = glints.find((g) => g.position[0] === 11)!;
    expect(full.radiusM).toBeCloseTo(ft.discSizeM / 2, 9);
    expect(full.radiance[0]).toBeCloseTo(ft.discGlow * 1 * 0.5 * terms.particleGlow, 6);
    // A climbing flare draws no disc, and glints not.
    expect(glints.some((g) => g.position[0] === 12)).toBe(false);
    // A fire's: its flames, as bright as they leave it, over their cluster, up their rise.
    const fire = glints.find((g) => g.position[0] === 5)!;
    expect(fire.radiance[0]).toBeCloseTo(fireT.flameColour[0] * fireT.flameGlow * terms.particleGlow, 6);
    expect(fire.position[1]).toBeGreaterThan(16);
    // At rest, none.
    expect(glintsFrom([], [], 1, terms)).toEqual([]);
    expect(STILL_WATER.glints).toEqual([]);
  });
});
