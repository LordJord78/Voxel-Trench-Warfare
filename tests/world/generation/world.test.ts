import { beforeAll, describe, expect, it } from 'vitest';
import { loadTunables } from '../../../src/core/tunables';
import { fingerprint } from '../../../src/world/fingerprint';
import { P } from '../../../src/world/materials';
import { fillBand } from '../../../src/world/generation/fill';
import { generateWorld, type GeneratedWorld } from '../../../src/world/generation/generate';
import { checkInvariants } from '../../../src/world/generation/invariants';
import { genParams } from '../../../src/world/generation/params';
import { planWorld } from '../../../src/world/generation/plan';
import { buildFarField } from '../../../src/world/generation/farfield';
import { fieldHeight } from '../../../src/world/generation/terrain';

const p = genParams(loadTunables());
const plan = planWorld(p, 7);
let world: GeneratedWorld;
const inProcess = async (bands: number[]) => bands.map((b) => fillBand(plan, b));

beforeAll(async () => {
  world = await generateWorld(plan, inProcess);
  console.log('generation timings (ms):', JSON.stringify(world.timings));
}, 120_000);

describe('the generated world', () => {
  it('is settled, dry above the table, and spawns on intact duckboards', () => {
    const r = checkInvariants(world.map, p.waterTable, { ditchWater: true });
    expect(r.hangingGranular, r.samples.join('\n')).toBe(0);
    expect(r.looseSteep, r.samples.join('\n')).toBe(0);
    expect(r.waterAboveTable).toBe(0);
    const [x, y, z] = world.spawn.position.map((m) => Math.floor(m / 0.1));
    expect([P.DUCKBOARD, P.DUCKBOARD_WORN, P.AIR]).toContain(world.map.get(x, y - 1, z));
    for (let k = 0; k < 20; k++) expect(world.map.get(x, y + k, z)).toBe(P.AIR);
  });
  it('is the same world however the bands are split across workers', async () => {
    const reversed = await generateWorld(plan, async (bands) => [...bands].reverse().map((b) => fillBand(plan, b)).reverse());
    expect(await fingerprint(reversed.map)).toBe(await fingerprint(world.map));
  }, 120_000);
  it('matches the golden fingerprint for seed 7', async () => {
    expect(await fingerprint(world.map)).toBe('009cfe7daa5a7dade317fb92854774fc804483ae75ed9f6dc9e0144605e93cd9');
  });
  it('meets the far field at the map edge, from the same terrain function', () => {
    const ff = world.farField ?? buildFarField(plan);
    for (const z of [300, 1280, 2200]) {
      const col = Math.floor((0 - ff.originX) / ff.cell) - 1;
      const row = Math.floor((z - ff.originZ) / ff.cell);
      const cx = ff.originX + (col + 0.5) * ff.cell;
      const cz = ff.originZ + (row + 0.5) * ff.cell;
      expect(Math.abs(ff.height[row * ff.size + col] - fieldHeight(plan.terrain, p, cx, cz))).toBeLessThanOrEqual(1);
    }
    const inside = (Math.floor((1280 - ff.originZ) / ff.cell)) * ff.size + Math.floor((1280 - ff.originX) / ff.cell);
    expect(ff.material[inside]).toBe(0);
  });
});
