import { describe, expect, it } from 'vitest';
import { Entrenching, entrenchingTunables, type Scoop } from '../../src/combat/entrenching';
import { loadTunables } from '../../src/core/tunables';
import { BrickMap } from '../../src/world/bricks';
import { isGranular, isLoose, P } from '../../src/world/materials';
import { sameWorld } from '../support/worlds';

// The entrenching tool (the spec's §5, "Digging"): loose soil — spoil, rubble, sandbags — cleared
// from in front of the feet at the reference's 0.125 m³ per 1.35 s, 93 voxels a second at 10 cm, a
// scoop of the nearest loose voxels in reach at a time, each followed by a collapse over its
// neighbourhood. The reference's test_entrenching, ported.
const tun = loadTunables();
const t = entrenchingTunables(tun);
const V = 0.1;
const DT = 1 / 60;
/** The feet, metres: on the subsoil, facing +z (yaw 0) at the heap. */
const FEET: [number, number, number] = [3.25, 1.6, 2.05];
/** Out of reach of anything loose. */
const AWAY: [number, number, number] = [0.5, 1.6, 6.0];

/**
 * 6.4 m a side: subsoil to y 16; a heap of spoil 6 × 4 × 6 voxels with a layer of rubble on top,
 * 0.75 m ahead of the feet; a timber revetment beside it, and a duckboard on the floor beside that.
 */
function bench(): BrickMap {
  const map = new BrickMap({ x: 64, y: 64, z: 64 });
  map.fillBox(0, 0, 0, 64, 16, 64, P.SUBSOIL);
  map.fillBox(30, 16, 28, 36, 20, 34, P.SPOIL);
  map.fillBox(30, 20, 28, 36, 21, 34, P.RUBBLE);
  map.fillBox(36, 16, 26, 37, 22, 34, P.TIMBER);
  map.fillBox(37, 16, 24, 40, 17, 34, P.DUCKBOARD);
  map.takeDirty();
  return map;
}

/** A bank of spoil at its angle of repose rising away from the feet, more than 10 s can clear. */
function bank(): BrickMap {
  const map = new BrickMap({ x: 64, y: 64, z: 64 });
  map.fillBox(0, 0, 0, 64, 16, 64, P.SUBSOIL);
  for (let y = 16; y < 40; y++) map.fillBox(0, y, 24 + (y - 16), 64, y + 1, 64, P.SPOIL);
  map.takeDirty();
  return map;
}

function count(map: BrickMap, which: (p: number) => boolean): number {
  let n = 0;
  for (let z = 0; z < map.dims.z; z++) for (let y = 0; y < map.dims.y; y++) for (let x = 0; x < map.dims.x; x++) if (which(map.get(x, y, z))) n++;
  return n;
}

/** `seconds` of ticks of digging, as the reference's `_dig`: the scoops made. */
function dig(tool: Entrenching, seconds: number, feet = FEET, yaw = 0, free?: () => boolean): Scoop[] {
  const scoops: Scoop[] = [];
  for (let k = 0; k < Math.floor(seconds / DT); k++) {
    const s = tool.work(feet, yaw, DT, free);
    if (s) scoops.push(s);
  }
  return scoops;
}

describe('what a shovel may touch', () => {
  it("loose fill can be dug: a scoop's worth after a scoop's time", () => {
    const map = bench();
    const tool = new Entrenching(map, t, V);
    const next = tool.findScoop(FEET, 0);
    expect(next).toHaveLength(t.scoopVoxels);
    const away = next.map(([x, y, z]) => Math.hypot((x + 0.5) * V - FEET[0], (y + 0.5) * V - FEET[1], (z + 0.5) * V - FEET[2]));
    for (const [i, [x, y, z]] of next.entries()) {
      expect(isLoose(map.get(x, y, z))).toBe(true);
      expect(away[i]).toBeLessThanOrEqual(t.reachM);
      if (i > 0) expect(away[i]).toBeGreaterThanOrEqual(away[i - 1]);
    }
    const scoops = dig(tool, tool.scoopS + 0.1);
    expect(tool.cleared).toBe(t.scoopVoxels);
    expect(scoops).toHaveLength(1);
    expect(scoops[0].voxels).toBe(t.scoopVoxels);
    expect(Math.hypot(scoops[0].at[0] - FEET[0], scoops[0].at[1] - FEET[1], scoops[0].at[2] - FEET[2])).toBeLessThanOrEqual(t.reachM);
  });

  it('revetment timber, duckboards and undisturbed ground are not shovel work', () => {
    const map = bench();
    const tool = new Entrenching(map, t, V);
    const timber = count(map, (p) => p === P.TIMBER);
    const duckboard = count(map, (p) => p === P.DUCKBOARD);
    const subsoil = count(map, (p) => p === P.SUBSOIL);
    dig(tool, 30);
    expect(tool.cleared).toBeGreaterThan(100);
    expect(count(map, (p) => p === P.TIMBER)).toBe(timber);
    expect(count(map, (p) => p === P.DUCKBOARD)).toBe(duckboard);
    expect(count(map, (p) => p === P.SUBSOIL)).toBe(subsoil);
  });

  it('nothing in reach means no scoop, and nothing banked', () => {
    const map = bench();
    const tool = new Entrenching(map, t, V);
    expect(tool.findScoop(AWAY, 0)).toEqual([]);
    expect(dig(tool, 2, AWAY)).toEqual([]);
    expect(tool.cleared).toBe(0);
    expect(tool.banked).toBe(0);
    expect(tool.inReach).toBe(false);
  });

  it('digging removes the dirt rather than moving it', () => {
    const map = bench();
    const tool = new Entrenching(map, t, V);
    const loose = count(map, isLoose);
    dig(tool, tool.scoopS * 1.1);
    expect(tool.cleared).toBe(t.scoopVoxels);
    expect(count(map, isLoose)).toBe(loose - tool.cleared);
  });
});

describe('the price', () => {
  it("it clears the reference's 0.125 m³ per 1.35 s: 93 voxels a second", () => {
    expect(t.m3PerS).toBeCloseTo(0.125 / 1.35, 4);
    const tool = new Entrenching(bank(), t, V);
    expect(tool.scoopS).toBeCloseTo((t.scoopVoxels * V ** 3) / t.m3PerS, 9);
    dig(tool, 10);
    expect(Math.abs(tool.cleared - 926)).toBeLessThanOrEqual(t.scoopVoxels);

    const early = new Entrenching(bench(), t, V);
    dig(early, early.scoopS * 0.8);
    expect(early.cleared).toBe(0);
    dig(early, early.scoopS * 0.4);
    expect(early.cleared).toBe(t.scoopVoxels);
  });

  it('progress survives being interrupted', () => {
    const tool = new Entrenching(bench(), t, V);
    dig(tool, tool.scoopS * 0.7);
    const banked = tool.banked;
    expect(banked).toBeGreaterThan(0);
    dig(tool, 2, AWAY); // two seconds in cover, nothing in reach
    expect(tool.banked).toBe(banked);
    dig(tool, tool.scoopS * 0.5);
    expect(tool.cleared).toBe(t.scoopVoxels);
  });

  it('the progress bar reflects the next scoop', () => {
    const tool = new Entrenching(bench(), t, V);
    dig(tool, tool.scoopS * 0.5);
    expect(tool.fraction).toBeGreaterThan(0.2);
    expect(tool.fraction).toBeLessThan(0.9);
  });

  it('a scoop held back stays banked, one scoop and no more, and is made once it is let go', () => {
    const tool = new Entrenching(bench(), t, V);
    expect(dig(tool, 2, FEET, 0, () => false)).toEqual([]);
    expect(tool.banked).toBe(tool.scoopS);
    expect(tool.fraction).toBe(1);
    expect(dig(tool, DT * 1.5, FEET, 0, () => true)).toHaveLength(1);
    expect(tool.cleared).toBe(t.scoopVoxels);
    expect(tool.fraction).toBeLessThan(0.1);
  });
});

describe('what a scoop leaves', () => {
  it('nothing is left hanging over a scoop', () => {
    const map = bench();
    const tool = new Entrenching(map, t, V);
    const taken = tool.findScoop(FEET, 0);
    expect(dig(tool, tool.scoopS + 0.05)).toHaveLength(1);
    let hanging = 0;
    for (const [x, y, z] of taken) {
      for (let dz = -3; dz <= 3; dz++) {
        for (let dy = -3; dy <= 3; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            if (isGranular(map.get(x + dx, y + dy, z + dz)) && map.get(x + dx, y + dy - 1, z + dz) === P.AIR) hanging++;
          }
        }
      }
    }
    expect(hanging).toBe(0);
  });

  it('a scoop below the water table floods, as a crater does', () => {
    // A pit filled with spoil beside the feet, its top a voxel below them, the water table at its top.
    const pit = () => {
      const map = new BrickMap({ x: 64, y: 64, z: 64 });
      map.fillBox(0, 0, 0, 64, 16, 64, P.SUBSOIL);
      map.fillBox(28, 10, 22, 38, 16, 34, P.SPOIL);
      map.takeDirty();
      return map;
    };
    const wet = pit();
    const tool = new Entrenching(wet, t, V, 15);
    const taken = tool.findScoop(FEET, 0);
    expect(taken.every(([, y]) => y === 15)).toBe(true);
    expect(dig(tool, tool.scoopS + 0.05)).toHaveLength(1);
    for (const [x, y, z] of taken) expect(wet.get(x, y, z)).toBe(P.WATER);

    const dry = pit();
    const without = new Entrenching(dry, t, V);
    dig(without, without.scoopS + 0.05);
    for (const [x, y, z] of taken) expect(dry.get(x, y, z)).toBe(P.AIR);
  });

  it('digging is deterministic', () => {
    const run = () => {
      const map = bench();
      const tool = new Entrenching(map, t, V);
      dig(tool, 3);
      return { map, cleared: tool.cleared };
    };
    const a = run();
    const b = run();
    expect(a.cleared).toBe(b.cleared);
    expect(sameWorld(a.map, b.map)).toBe(true);
  });
});
