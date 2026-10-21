import { describe, expect, it } from 'vitest';
import { boxHitsSolid, groundHeightUnder, submergedDepth, supportIs } from '../../src/physics/collision';
import { boxGrid, brickGrid } from '../../src/physics/grid';
import { Vec3 } from '../../src/physics/vec';
import { BrickMap } from '../../src/world/bricks';
import { K, P } from '../../src/world/materials';

// 16³ voxels at 0.5 m: ground whose top is at 2.0 m, a brick wall whose face is at x = 5.0 m,
// a one-voxel timber tread over x 3.0 to 3.5 m, and a pit of water 0.5 m deep over x 6 to 7 m.
const coarse = boxGrid([16, 16, 16], 0.5, [
  [0, 0, 0, 16, 4, 16, K.SOD],
  [10, 4, 0, 11, 10, 16, K.BRICK],
  [6, 4, 0, 7, 5, 16, K.TIMBER],
  [12, 3, 0, 14, 4, 16, K.WATER],
]);

describe('box collision', () => {
  it('counts a box touching a face as clear, and one a millimetre into it as hitting', () => {
    expect(boxHitsSolid(coarse, new Vec3(4.7, 2.0, 4.0), 0.3, 1.8)).toBe(false);
    expect(boxHitsSolid(coarse, new Vec3(4.701, 2.0, 4.0), 0.3, 1.8)).toBe(true);
  });
  it('stands on the ground without hitting it', () => {
    expect(boxHitsSolid(coarse, new Vec3(2.0, 2.0, 4.0), 0.3, 1.8)).toBe(false);
    expect(boxHitsSolid(coarse, new Vec3(2.0, 1.99, 4.0), 0.3, 1.8)).toBe(true);
  });
  it('finds the world solid beyond its sides and below it, and open above it', () => {
    expect(boxHitsSolid(coarse, new Vec3(-1.0, 2.0, 4.0), 0.3, 1.8)).toBe(true);
    expect(boxHitsSolid(coarse, new Vec3(4.0, 2.0, 8.2), 0.3, 1.8)).toBe(true);
    expect(boxHitsSolid(coarse, new Vec3(4.0, -2.0, 4.0), 0.3, 1.8)).toBe(true);
    expect(boxHitsSolid(coarse, new Vec3(4.0, 9.0, 4.0), 0.3, 1.8)).toBe(false);
  });
});

describe('probes', () => {
  it('find the ground under a body, or nothing within reach', () => {
    expect(groundHeightUnder(coarse, new Vec3(2.0, 3.2, 4.0), 0.3, 2.0)).toBe(2.0);
    expect(groundHeightUnder(coarse, new Vec3(2.0, 5.2, 4.0), 0.3, 1.0)).toBeNull();
  });
  it('count a timber tread under one boot as support, with air under the centre', () => {
    const centre = new Vec3(3.7, 2.5, 4.0);
    expect(coarse.kindAt(7, 4, 8)).toBe(K.AIR);
    expect(supportIs(coarse, centre, 0.3, K.TIMBER)).toBe(true);
    expect(supportIs(coarse, new Vec3(2.0, 2.0, 4.0), 0.3, K.TIMBER)).toBe(false);
  });
  it('measure water to its highest sample above the feet: 0.25 m of a 0.5 m voxel, 0.45 m at 10 cm', () => {
    expect(submergedDepth(coarse, new Vec3(6.5, 1.5, 4.0), 1.8)).toBe(0.25);
    const map = new BrickMap({ x: 32, y: 32, z: 32 });
    map.fillBox(0, 0, 0, 32, 15, 32, P.SOD);
    map.fillBox(0, 15, 0, 32, 20, 32, P.WATER);
    expect(submergedDepth(brickGrid(map, 0.1), new Vec3(1.6, 1.5, 1.6), 1.8)).toBeCloseTo(0.45, 12);
  });
});

describe('the 10 cm world', () => {
  const map = new BrickMap({ x: 64, y: 64, z: 64 });
  map.fillBox(0, 0, 0, 64, 20, 64, P.SOD);
  map.fillBox(10, 20, 10, 11, 21, 11, P.WIRE);
  map.fillBox(20, 20, 20, 21, 21, 21, P.CLOTH);
  map.fillBox(30, 20, 30, 31, 21, 31, P.DUCKBOARD);
  const g = brickGrid(map, 0.1);
  const over = (x: number, z: number) => new Vec3((x + 0.5) * 0.1, 2.0, (z + 0.5) * 0.1);
  it('lets a body through wire and a gas curtain, and stops it at a duckboard', () => {
    expect(boxHitsSolid(g, over(10, 10), 0.3, 1.8)).toBe(false);
    expect(boxHitsSolid(g, over(20, 20), 0.3, 1.8)).toBe(false);
    expect(boxHitsSolid(g, over(30, 30), 0.3, 1.8)).toBe(true);
  });
  it('reads outside the map as Python did: subsoil to the sides and below, air above', () => {
    expect(g.kindAt(-1, 30, 5)).toBe(K.SUBSOIL);
    expect(g.kindAt(5, -1, 5)).toBe(K.SUBSOIL);
    expect(g.kindAt(5, 64, 5)).toBe(K.AIR);
    expect(g.kindAt(5, 10, 5)).toBe(K.SOD);
  });
});
