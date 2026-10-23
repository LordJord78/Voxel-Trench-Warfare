import { describe, expect, it } from 'vitest';
import { BrickMap } from '../../src/world/bricks';
import { chip } from '../../src/world/destruction';
import { P, spoilOf } from '../../src/world/materials';

// Ported from reference/python/tests/test_destruction.py's chip cases: a round marks what it
// strikes at chip_energy_j (260 J) per unit of the material's hardness.
const CHIP_J = 260;

function cell(p: number): BrickMap {
  const map = new BrickMap({ x: 32, y: 32, z: 32 });
  map.set(4, 4, 4, p);
  map.takeDirty();
  return map;
}

describe("a round's mark", () => {
  it('a rifle round marks soil but not concrete', () => {
    const clay = cell(P.CLAY);
    expect(chip(clay, 4, 4, 4, 900, CHIP_J)).toBe(true);
    expect(clay.get(4, 4, 4)).toBe(spoilOf(P.CLAY));
    expect(spoilOf(P.CLAY)).toBe(P.SPOIL);
    const concrete = cell(P.CONCRETE);
    expect(chip(concrete, 4, 4, 4, 900, CHIP_J)).toBe(false);
    expect(concrete.get(4, 4, 4)).toBe(P.CONCRETE);
    expect(chip(concrete, 4, 4, 4, 1040, CHIP_J)).toBe(true);
  });

  it('a spent round marks nothing', () => {
    const clay = cell(P.CLAY);
    expect(chip(clay, 4, 4, 4, 3, CHIP_J)).toBe(false);
    expect(clay.get(4, 4, 4)).toBe(P.CLAY);
  });

  it('a branch is shot away, and timber turns to rubble', () => {
    const branch = cell(P.BRANCH);
    expect(chip(branch, 4, 4, 4, 900, CHIP_J)).toBe(true);
    expect(branch.get(4, 4, 4)).toBe(P.AIR);
    const timber = cell(P.TIMBER);
    expect(chip(timber, 4, 4, 4, 900, CHIP_J)).toBe(true);
    expect(timber.get(4, 4, 4)).toBe(P.RUBBLE);
  });

  it('spoil marked again stays as it is, and air and water are never marked', () => {
    for (const p of [P.SPOIL, P.SPOIL_DRY, P.RUBBLE, P.AIR, P.WATER]) {
      const map = cell(p);
      expect(chip(map, 4, 4, 4, 900, CHIP_J)).toBe(false);
      expect(map.get(4, 4, 4)).toBe(p);
      expect(map.takeDirty()).toEqual([]);
    }
  });

  it('a mark dirties its brick', () => {
    const clay = cell(P.CLAY);
    chip(clay, 4, 4, 4, 900, CHIP_J);
    expect(clay.takeDirty()).toEqual([clay.brickIndex(0, 0, 0)]);
  });
  it("a lantern's glow is not marked: its light cannot be put out yet", () => {
    const lantern = cell(P.LANTERN_GLOW);
    expect(chip(lantern, 4, 4, 4, 1328, CHIP_J)).toBe(false);
    expect(lantern.get(4, 4, 4)).toBe(P.LANTERN_GLOW);
  });
});
