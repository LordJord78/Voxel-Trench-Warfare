import { beforeAll, describe, expect, it } from 'vitest';
import { FLARE_MAPS, FLARE_MAP_SIZE, FlareShadows } from '../../src/render/flare-shadows';
import type { SceneLight } from '../../src/render/lights';
import { FLARE_SHADOW_MAPS } from '../../src/render/quality';

// The flares' shadow maps follow a flare, not its place in the frame's lights: the battle's flares
// are fired and go out, so a flare's index changes under it while its map stays good; and the eight
// burning nearest the eye hold the maps (the battle spec's §2).
const ALL = FLARE_MAP_SIZE * FLARE_MAP_SIZE;
beforeAll(() => {
  (globalThis as unknown as { GPUBufferUsage: Record<string, number> }).GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8, STORAGE: 128, COPY_SRC: 4 };
});
const device = { createBuffer: () => ({}), queue: { writeBuffer: () => {} } } as unknown as GPUDevice;
const flare = (id: number, x: number): SceneLight => ({ id, position: [x, 30, 50], radius: 65, colour: [1, 0.88, 0.7], intensity: 260, kind: 'flare', phase: 0 });

describe("the flares' shadow maps", () => {
  it('a flare keeps its map by its id as others are fired and go out', () => {
    const maps = FlareShadows.create(device);
    const a = flare(1, 20);
    const b = flare(2, 40);
    maps.setFlares([a, b], 1, 0.1, [0, 0, 0]);
    expect(maps.next()).toBe(2 * ALL);
    // A new flare fired ahead of them in the list: theirs are kept, unmoved; only the new one is traced.
    maps.setFlares([flare(3, 60), a, b], 1, 0.1, [0, 0, 0]);
    expect(maps.next()).toBe(ALL);
    expect(maps.mapped()).toEqual([0, 1, 2]);
    // The first goes out: the others keep theirs.
    maps.setFlares([flare(3, 60), b], 1, 0.1, [0, 0, 0]);
    expect(maps.next()).toBe(0);
    expect(maps.mapped()).toEqual([0, 1]);
  });

  it('the eight burning nearest the eye hold the maps', () => {
    const maps = FlareShadows.create(device);
    // Twelve flares 10 m apart along x (10–120 m); the eye at x 115: the nearest eight are x 50–120.
    const twelve = Array.from({ length: 12 }, (_, i) => flare(i + 1, 10 + i * 10));
    maps.setFlares(twelve, 1, 0.1, [115 / 0.1, 0, 50 / 0.1]);
    expect(maps.mapped()).toHaveLength(FLARE_MAPS);
    expect(maps.mapped()).toEqual([7, 8, 9, 10, 11, 4, 5, 6].sort((x, y) => x - y));
  });

  it('the low preset holds four flare maps, for the nearest four burning', () => {
    expect(FLARE_SHADOW_MAPS).toEqual({ high: FLARE_MAPS, low: FLARE_MAPS / 2 });
    const maps = FlareShadows.create(device);
    // The twelve again, the eye at x 115: the nearest four are x 90–120.
    const twelve = Array.from({ length: 12 }, (_, i) => flare(i + 1, 10 + i * 10));
    const eye = [115 / 0.1, 0, 50 / 0.1];
    maps.setFlares(twelve, 1, 0.1, eye, FLARE_SHADOW_MAPS.low);
    expect(maps.mapped()).toEqual([8, 9, 10, 11]);
    expect(maps.next()).toBe(4 * ALL);
    // Up to high: the next four nearest take maps, traced outright; the four held keep theirs.
    maps.setFlares(twelve, 1, 0.1, eye, FLARE_SHADOW_MAPS.high);
    expect(maps.mapped()).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    expect(maps.next()).toBe(4 * ALL);
    // Down to low again: the farther four let go, the nearest four kept, nothing traced again.
    maps.setFlares(twelve, 1, 0.1, eye, FLARE_SHADOW_MAPS.low);
    expect(maps.mapped()).toEqual([8, 9, 10, 11]);
    expect(maps.next()).toBe(0);
  });
});
