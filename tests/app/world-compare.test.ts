import { describe, expect, it } from 'vitest';
import { bloodCells, maskedFingerprint, pageFingerprint, standTop } from '../../src/app/world-compare';
import { packCell } from '../../src/combat/entrenching';
import { BrickMap } from '../../src/world/bricks';
import { fingerprint } from '../../src/world/fingerprint';
import { P, PALETTE } from '../../src/world/materials';
import { cloneMap, sameWorld } from '../support/worlds';

// Two pages' worlds compared (battle.spec.ts's sameWorlds, through main.ts's hooks): blood spatter is
// per page and colour only (the shared-battle plan's note 12), so a comparison masks every voxel where
// either page holds a BLOOD_* id. The page finds its blood (bloodCells), and fingerprints its world with
// the union of both pages' set to air (maskedFingerprint), putting each voxel back after.

/** 6.4 m a side: clay to 1.6 m, a timber post, one brick of it all sod (uniform), the rest air. */
function arena(): BrickMap {
  const map = new BrickMap({ x: 64, y: 64, z: 64 });
  map.fillBox(0, 0, 0, 64, 16, 64, P.CLAY);
  map.fillBox(20, 16, 20, 22, 30, 22, P.TIMBER);
  map.fillBox(40, 16, 40, 48, 24, 48, P.SOD);
  map.takeDirty();
  return map;
}

describe("a page's world as two pages compare it", () => {
  it('the blood ids are the palette names starting BLOOD_, 83 to 90', () => {
    const ids = PALETTE.flatMap((p, id) => (p.name.startsWith('BLOOD_') ? [id] : []));
    expect(ids).toEqual([83, 84, 85, 86, 87, 88, 89, 90]);
  });

  it('finds every voxel holding a BLOOD_* id, in dense bricks and uniform ones, as packed cells in ascending order', () => {
    const map = arena();
    expect(bloodCells(map)).toEqual([]);
    map.set(21, 25, 20, P.BLOOD_TIMBER);
    map.set(3, 15, 9, P.BLOOD_CLAY);
    map.set(5, 15, 9, P.BLOOD_SPOIL);
    // A whole brick of blood, uniform: every one of its 512.
    map.fillBox(40, 16, 40, 48, 24, 48, P.BLOOD_SOIL);
    map.takeDirty();
    const cells = bloodCells(map);
    const brick: number[] = [];
    for (let z = 40; z < 48; z++) for (let y = 16; y < 24; y++) for (let x = 40; x < 48; x++) brick.push(packCell(map.dims, x, y, z));
    expect(cells).toEqual([packCell(map.dims, 3, 15, 9), packCell(map.dims, 5, 15, 9), packCell(map.dims, 21, 25, 20), ...brick].sort((a, b) => a - b));
    // Not a voxel more: no other id is blood.
    map.set(6, 15, 9, P.MUD);
    expect(bloodCells(map)).toHaveLength(cells.length);
  });

  it('fingerprints the world with the masked voxels as air, and leaves every voxel as it was', async () => {
    const mine = arena();
    const theirs = arena();
    // Each page spattered its own: a voxel of the post on one, the clay's top on the other.
    mine.set(21, 25, 20, P.BLOOD_TIMBER);
    theirs.set(3, 15, 9, P.BLOOD_CLAY);
    const kept = cloneMap(mine);
    const unmasked = await fingerprint(mine);
    expect(await fingerprint(theirs)).not.toBe(unmasked);
    const mask = [...new Set([...bloodCells(mine), ...bloodCells(theirs)])].sort((a, b) => a - b);
    expect(mask).toHaveLength(2);
    const a = await maskedFingerprint(mine, mask);
    expect(await maskedFingerprint(theirs, mask)).toBe(a);
    // What it hashes: the world with those voxels air.
    const aired = cloneMap(kept);
    aired.set(21, 25, 20, P.AIR);
    aired.set(3, 15, 9, P.AIR);
    expect(a).toBe(await fingerprint(aired));
    // Put back as they were.
    expect(sameWorld(mine, kept)).toBe(true);
    expect(await fingerprint(mine)).toBe(unmasked);
  });

  it("a page's fingerprint with a mask only while its frames are held: unheld, it refuses, naming freeze()", async () => {
    const map = arena();
    map.set(21, 25, 20, P.BLOOD_TIMBER);
    map.takeDirty();
    const mask = bloodCells(map);
    const kept = cloneMap(map);
    // Without a mask it is the plain fingerprint, held or not.
    expect(await pageFingerprint(map, undefined, false)).toBe(await fingerprint(map));
    expect(await pageFingerprint(map, undefined, true)).toBe(await fingerprint(map));
    // With one, held: the masked fingerprint.
    expect(await pageFingerprint(map, mask, true)).toBe(await maskedFingerprint(map, mask));
    // With one, unheld: a frame run while the masked voxels are air would see them so. Refused, the world untouched.
    await expect(pageFingerprint(map, mask, false)).rejects.toThrow(/freeze\(\)/);
    expect(sameWorld(map, kept)).toBe(true);
  });

  it("the ground's top at (x, z) metres: the highest voxel neither air nor water, or none", () => {
    const map = arena();
    // Water over the clay at one column, a post at another.
    map.fillBox(10, 16, 10, 11, 19, 11, P.WATER);
    map.takeDirty();
    const V = 0.1;
    expect(standTop(map, 0.55, 0.55, V)).toBeCloseTo(1.6, 9);
    expect(standTop(map, 1.05, 1.05, V)).toBeCloseTo(1.6, 9);
    expect(standTop(map, 2.05, 2.05, V)).toBeCloseTo(3.0, 9);
    // A column of air, and one off the world: none.
    const empty = new BrickMap({ x: 32, y: 32, z: 32 });
    expect(standTop(empty, 0.5, 0.5, V)).toBeNull();
    expect(standTop(map, -0.05, 1, V)).toBeNull();
    expect(standTop(map, 6.4, 1, V)).toBeNull();
  });

  it('takes no cell outside the world, and with none masked is the plain fingerprint', async () => {
    const map = arena();
    const all = map.dims.x * map.dims.y * map.dims.z;
    expect(await maskedFingerprint(map, [])).toBe(await fingerprint(map));
    expect(await maskedFingerprint(map, [-1, all, 2.5])).toBe(await fingerprint(map));
  });
});
