import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../../src/core/tunables';
import { P, isSolid } from '../../../src/world/materials';
import { bandMap } from '../../../src/world/generation/fill';
import { checkInvariants } from '../../../src/world/generation/invariants';
import { genParams } from '../../../src/world/generation/params';
import { planWorld } from '../../../src/world/generation/plan';

const p = genParams(loadTunables());
const plan = planWorld(p, 7);
const front = plan.lines[0];

describe('trench furniture', () => {
  it('lays sandbags on crests without raising them', () => {
    let bags = 0;
    const maps = new Map<number, ReturnType<typeof bandMap>>();
    for (const bay of front.bays.slice(5, 10)) {
      for (let x = bay.x0; x < bay.x1; x++) {
        const band = Math.floor(x / 32);
        if (!maps.has(band)) maps.set(band, bandMap(plan, band));
        const map = maps.get(band)!;
        const lx = x - band * 32;
        const top = map.get(lx, bay.crestY - 1, bay.b1 + 1);
        if (top === P.SANDBAG || top === P.SANDBAG_SEAM || top === P.SANDBAG_WORN) bags++;
        expect(map.get(lx, bay.crestY, bay.b1 + 1)).toBe(P.AIR);
      }
    }
    expect(bags).toBeGreaterThan(10);
  });
  it('digs dugouts with headroom, a roof, a curtain and a lantern', () => {
    const d = front.dugouts[0];
    const band = Math.floor(((d.lo[0] + d.hi[0]) >> 1) / 32);
    const map = bandMap(plan, band);
    const cx = ((d.lo[0] + d.hi[0]) >> 1) - band * 32;
    const cz = (d.lo[2] + d.hi[2]) >> 1;
    for (let y = d.dugFloor + 1; y < d.dugFloor + 20; y++) expect(map.get(cx, y, cz)).toBe(P.AIR);
    expect(isSolid(map.get(cx, d.roofY, cz))).toBe(true);
    let lantern = 0, cloth = 0;
    for (let x = 0; x < 32; x++) for (let y = d.dugFloor; y < d.roofY; y++) for (let z = d.lo[2] - 12; z < d.hi[2] + 12; z++) {
      const v = map.get(x, y, z);
      if (v === P.LANTERN_GLOW) lantern++;
      if (v === P.CLOTH) cloth++;
    }
    expect(lantern).toBeGreaterThanOrEqual(1);
    expect(cloth).toBeGreaterThan(0);
    expect(checkInvariants(map, p.waterTable, { ditchWater: true }).hangingGranular).toBe(0);
  });
  it('cuts dugouts without leaving spoil past repose or earth hanging around their passages', () => {
    const seen = new Set<number>();
    for (const line of plan.lines) {
      for (const d of line.dugouts) {
        const band = Math.floor(((d.passage.x0 + d.passage.x1) >> 1) / 32);
        if (seen.has(band)) continue;
        seen.add(band);
        const r = checkInvariants(bandMap(plan, band), p.waterTable, { ditchWater: true });
        expect(r.looseSteep, `${line.spec.name} dugout band ${band}: ${r.samples.join('; ')}`).toBe(0);
        expect(r.hangingGranular, `${line.spec.name} dugout band ${band}: ${r.samples.join('; ')}`).toBe(0);
      }
    }
  }, 60_000);
});
