import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../../src/core/tunables';
import { columnModel, columnTopAt } from '../../../src/world/generation/columns';
import { genParams } from '../../../src/world/generation/params';
import { planWorld } from '../../../src/world/generation/plan';

const p = genParams(loadTunables());
const plan = planWorld(p, 7);
const front = plan.lines[0];
// A bay whose parapet no crater has touched, so its profile is the planner's own.
function cleanBay() {
  for (const b of front.bays.slice(5)) {
    const mm = columnModel(plan, b.x0, b.x1);
    const x = Math.floor((b.x0 + b.x1) / 2);
    let clean = true;
    for (let z = b.b1; z < b.b1 + 60; z++) if (mm.flags[(x - mm.x0) * mm.nz + z] & 2) clean = false;
    if (clean) return { bay: b, m: mm };
  }
  throw new Error('every front bay has a cratered parapet');
}
const { bay, m } = cleanBay();
const at = (x: number, z: number) => (x - m.x0) * m.nz + z;

describe('column model', () => {
  it('opens the walkway down to the duckboards', () => {
    const c = at(Math.floor(bay.walkX), Math.floor(bay.walkZ));
    expect(m.floor[c]).toBe(bay.floorY);
    expect(m.flags[c] & 4).toBe(4);
  });
  it('raises the bench to the step top and the parapet face to the crest', () => {
    const x = Math.floor((bay.x0 + bay.x1) / 2);
    expect(m.solidTop[at(x, bay.stepLo)]).toBe(bay.stepTopY);
    expect(m.revetTop[at(x, bay.b1)]).toBe(bay.crestY);
  });
  it('falls away from the crest at 45 degrees until it meets the field', () => {
    const x = Math.floor((bay.x0 + bay.x1) / 2);
    let prev = m.spoilTop[at(x, bay.b1 + 1)];
    for (let z = bay.b1 + 2; m.spoilTop[at(x, z)] > m.surface[at(x, z)]; z++) {
      const h = m.spoilTop[at(x, z)];
      expect(prev - h).toBeLessThanOrEqual(1);
      prev = h;
    }
  });
  it('lets a comm trench cut through the support line parapet', () => {
    const comm = plan.lines[6];
    const cross = comm.bays.find((b) => b.z0 <= p.layout.support + 30 && b.z1 >= p.layout.support + 30)!;
    const mm = columnModel(plan, cross.x0, cross.x1);
    const c = (Math.floor(cross.walkX) - mm.x0) * mm.nz + Math.floor(cross.walkZ);
    expect(mm.spoilTop[c]).toBe(-1);
    expect(mm.floor[c]).toBeGreaterThan(0);
  });
  it('keeps the columns of a map deeper than 4096 voxels apart when it caches them', () => {
    const deep = genParams(loadTunables(), (raw) => {
      (raw.world as Record<string, unknown>).size_z_m = 512;
    });
    const a = planWorld(deep, 7);
    const b = planWorld(deep, 7);
    columnTopAt(a, 600, 4096);
    expect(columnTopAt(a, 601, 0)).toBe(columnTopAt(b, 601, 0));
  });
});
