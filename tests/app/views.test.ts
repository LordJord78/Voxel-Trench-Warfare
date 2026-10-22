import { CLOCK_KEYS } from '../../src/core/sky-clock';
import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../src/core/tunables';
import { standardViews, VIEW_NAMES } from '../../src/app/views';
import { genParams } from '../../src/world/generation/params';
import { planWorld } from '../../src/world/generation/plan';

const p = genParams(loadTunables());
const plan = planWorld(p, 7);
const v = p.voxel;
const front = plan.lines[0];
const bay = front.bays[front.bays.length >> 1];
const spawn = { position: [bay.walkX * v, (bay.floorY + 1) * v, bay.walkZ * v] as [number, number, number], bay };
const views = standardViews(plan, spawn);

describe('the standard views', () => {
  it('are all six, finite, and over the map', () => {
    expect(Object.keys(views).sort()).toEqual([...VIEW_NAMES].sort());
    for (const view of Object.values(views)) {
      for (const c of view.position) expect(Number.isFinite(c)).toBe(true);
      expect(view.position[0]).toBeGreaterThanOrEqual(0);
      expect(view.position[0]).toBeLessThan(p.dims.x * v);
      expect(view.position[2]).toBeGreaterThanOrEqual(0);
      expect(view.position[2]).toBeLessThan(p.dims.z * v);
    }
  });
  it('stand a standing eye over the floor in the bay, on the step and in a dugout', () => {
    expect(views.bay.position[1] - (bay.floorY + 1) * v).toBeGreaterThanOrEqual(1.5);
    expect(views.step.position[1] - bay.stepTopY * v).toBeGreaterThanOrEqual(1.5);
    const d = front.dugouts[0];
    expect(views.dugout.position[1] - (d.dugFloor + 1) * v).toBeGreaterThanOrEqual(1.5);
    expect(views.dugout.position[1]).toBeLessThan(d.roofY * v);
  });
  it('looks out from the step, puts the overview above the world, and keeps no man\'s land for the night', () => {
    expect(views.step.yaw).toBe(bay.facing > 0 ? 0 : 180);
    expect(views.overview.position[1]).toBeGreaterThan(p.dims.y * v);
    expect(views['nml-night'].hours).toBe(CLOCK_KEYS.night);
    for (const name of VIEW_NAMES) if (name !== 'nml-night') expect(views[name].hours).toBe(CLOCK_KEYS.dusk);
  });
});
