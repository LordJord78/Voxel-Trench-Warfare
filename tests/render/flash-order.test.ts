import { describe, expect, it } from 'vitest';
import type { TransientLight } from '../../src/render/effects';
import { FRAME, MAX_FLASHES } from '../../src/render/frame-uniforms';
import { transientOrder } from '../../src/render/renderer';

// The frame's transient lights (renderer.ts setTransientLights): the shots' flashes first, then the rest
// (a gun's light's pool, a test's light), each by intensity, the strongest MAX_FLASHES of them in all,
// and how many of those are shots'. The player's own kept smoke takes [effects] own_smoke_flash_share
// of the shots' flashes alone (effects-light.wgsl flashesAt reads the count): a pool of the player's
// light, or a friend's, lights it whole, as every other kind of light does.

const at = (x: number): [number, number, number] => [x, 1, 2];
const shot = (intensity: number, x = 0): TransientLight => ({ position: at(x), radiusM: 6, colour: [1, 0.7, 0.4], intensity, shot: true });
const pool = (intensity: number, x = 0): TransientLight => ({ position: at(x), radiusM: 4, colour: [1, 1, 0.9], intensity });

describe("the frame's transient lights", () => {
  it("are the shots' flashes first, then the rest, each by intensity: a pool brighter than a flash still comes after it", () => {
    const lights = [pool(5, 1), shot(1.5, 2), pool(40, 3), shot(3, 4)];
    const { flashes, shots } = transientOrder(lights);
    expect(flashes.map((l) => [l.shot === true, l.intensity])).toEqual([[true, 3], [true, 1.5], [false, 40], [false, 5]]);
    expect(shots).toBe(2);
    // Its own list: the frame's is left as it came.
    expect(lights.map((l) => l.intensity)).toEqual([5, 1.5, 40, 3]);
  });

  it('are at most MAX_FLASHES: the shots first to a place, and the count no more than the places', () => {
    const many = [pool(50), ...[1, 2, 3, 4, 5, 6].map((k) => shot(k))];
    const { flashes, shots } = transientOrder(many);
    expect(flashes).toHaveLength(MAX_FLASHES);
    expect(shots).toBe(MAX_FLASHES);
    expect(flashes.map((l) => l.intensity)).toEqual([6, 5, 4, 3]);
    // Two shots and three pools: both shots, and the two strongest pools.
    const mixed = transientOrder([pool(1), pool(9), shot(2), pool(4), shot(3)]);
    expect(mixed.flashes.map((l) => [l.shot === true, l.intensity])).toEqual([[true, 3], [true, 2], [false, 9], [false, 4]]);
    expect(mixed.shots).toBe(2);
  });

  it('never counts a pool as a shot: none of pools alone, and none of no lights', () => {
    expect(transientOrder([pool(5), pool(2)]).shots).toBe(0);
    expect(transientOrder([pool(5), { ...pool(3), shot: false }])).toEqual({ flashes: [pool(5), { ...pool(3), shot: false }], shots: 0 });
    expect(transientOrder([])).toEqual({ flashes: [], shots: 0 });
  });

  it("the frame's uniforms carry the count beside the flashes, after flashCount", () => {
    const names = FRAME.fields.map(([name]) => name);
    expect(names.indexOf('shotFlashCount')).toBe(names.indexOf('flashCount') + 1);
    expect(FRAME.fields[names.indexOf('shotFlashCount')][1]).toBe('u32');
  });
});
