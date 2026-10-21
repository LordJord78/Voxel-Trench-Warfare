import { describe, expect, it } from 'vitest';
import { Rng } from '../../../src/core/rng';
import { loadTunables } from '../../../src/core/tunables';
import { genParams } from '../../../src/world/generation/params';
import { buildTerrain, surfaceAt } from '../../../src/world/generation/terrain';
import { corridorHeight, planLine } from '../../../src/world/generation/trenches';

const p = genParams(loadTunables());
const t = buildTerrain(p, Rng.root(7));
const surface = (x: number, z: number) => surfaceAt(t, p, x, z);
const front = planLine(p, p.lines[0], surface, Rng.root(7).derive('trench.front'));

describe('trench planner', () => {
  it('guarantees every fire bay its peek, from its own ground', () => {
    const vs = p.voxel;
    for (const bay of front.bays) {
      const ahead = corridorHeight(surface, front.spec, bay.a0, bay.a1, bay.b1, p.trench.reach, p.trench.near, p.trench.percentile);
      const eye = bay.stepTopY + p.eye.standing;
      if (bay.stepTopY < bay.floorY + 1 + p.trench.stepMax) expect(eye + 1e-9).toBeGreaterThanOrEqual(ahead + p.trench.margin);
      expect(bay.crestY - bay.stepTopY).toBe(p.trench.crestRise);
      expect((bay.stepTopY + p.eye.crouched) * vs).toBeLessThan(bay.crestY * vs);
    }
  });
  it('steps floors at most one tread between bays and only raises crests when smoothing', () => {
    for (let i = 1; i < front.bays.length; i++) {
      expect(Math.abs(front.bays[i].floorY - front.bays[i - 1].floorY)).toBeLessThanOrEqual(p.trench.treadRise);
      expect(front.bays[i - 1].stepTopY - front.bays[i].stepTopY).toBeLessThanOrEqual(p.trench.smooth);
    }
  });
  it('crenellates by the traverse offset and ends inside the margin', () => {
    expect(front.bays[1].b0 - front.bays[0].b0).toBe(p.trench.offset);
    expect(front.bays[0].a0).toBe(60);
    expect(front.bays.at(-1)!.a1).toBeLessThanOrEqual(2500);
    expect(front.legs).toHaveLength(front.bays.length - 1);
  });
  it('places dugouts every third bay on the front, above the water table', () => {
    expect(front.dugouts.length).toBeGreaterThan(5);
    for (const d of front.dugouts) expect(d.dugFloor).toBeGreaterThan(p.waterTable);
  });
  it('plans comm trenches along z without firing steps', () => {
    const comm = planLine(p, p.lines[6], surface, Rng.root(7).derive('trench.comm_0'));
    expect(comm.bays.every((b) => b.longAxis === 2 && !b.firingSteps && b.stepTopY === b.floorY + 1)).toBe(true);
  });
});
