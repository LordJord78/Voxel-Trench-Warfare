import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../../src/core/tunables';
import { P } from '../../../src/world/materials';
import { columnModel } from '../../../src/world/generation/columns';
import { bandMap, fillBand } from '../../../src/world/generation/fill';
import { checkInvariants } from '../../../src/world/generation/invariants';
import { genParams } from '../../../src/world/generation/params';
import { planWorld } from '../../../src/world/generation/plan';

const p = genParams(loadTunables());
const plan = planWorld(p, 7);
// A front bay no crater has touched at its middle column, as in the column-model test.
const bay = plan.lines[0].bays.slice(5).find((b) => {
  const x = Math.floor((b.x0 + b.x1) / 2);
  const cm = columnModel(plan, x, x + 1);
  for (let z = b.b1; z < b.b1 + 60; z++) if (cm.flags[(x - cm.x0) * cm.nz + z] & 2) return false;
  return true;
})!;
const band = Math.floor((bay.x0 + bay.x1) / 2 / 32);
const map = bandMap(plan, band);
const lx = Math.min(29, Math.floor((bay.x0 + bay.x1) / 2) - band * 32);

describe('fillBand', () => {
  it('builds a walkable bay: duckboards, open air, timber bench, revetted face', () => {
    const wz = Math.floor(bay.walkZ);
    const floorRow = [0, 1, 2].map((k) => map.get(lx + k, bay.floorY, wz));
    expect(floorRow.filter((v) => v === P.DUCKBOARD || v === P.DUCKBOARD_WORN).length).toBeGreaterThanOrEqual(2);
    for (let y = bay.floorY + 1; y < bay.floorY + 21; y++) expect(map.get(lx, y, wz)).toBe(P.AIR);
    expect([P.TIMBER, P.TIMBER_WEATHERED, P.TIMBER_DARK]).toContain(map.get(lx, bay.stepTopY - 1, bay.stepLo));
    expect(map.get(lx, bay.crestY - 1, bay.b1)).not.toBe(P.AIR);
    expect(map.get(lx, bay.crestY + 1, bay.b1 + 1)).toBe(P.AIR);
  });
  it('lays strata under the field', () => {
    const cm = columnModel(plan, band * 32, band * 32 + 32);
    let z = 600;
    while (cm.flags[(lx + band * 32 - cm.x0) * cm.nz + z] !== 0) z++;
    let y = 319;
    while (map.get(lx, y, z) === P.AIR) y--;
    expect([P.SOD, P.SOD_DRY, P.SOD_TUFT, P.MUD_TURNED]).toContain(map.get(lx, y, z));
    expect(map.get(lx, y - 10, z)).toBe(P.MUD);
    expect(map.get(lx, y - 30, z)).toBe(P.CLAY);
    expect(map.get(lx, 10, z)).toBe(P.SUBSOIL);
  });
  it('leaves nothing hanging or past repose, and no water above the table', () => {
    const r = checkInvariants(map, p.waterTable, { ditchWater: true });
    expect(r.hangingGranular, r.samples.join('\n')).toBe(0);
    expect(r.looseSteep, r.samples.join('\n')).toBe(0);
    expect(r.waterAboveTable).toBe(0);
  });
  it('returns the band as transferable bricks', () => {
    const res = fillBand(plan, band);
    expect(res.table.length).toBe(4 * 40 * 320);
    expect(res.dense.length).toBe(res.denseBricks.length * 512);
  });
});
