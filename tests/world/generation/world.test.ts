import { beforeAll, describe, expect, it } from 'vitest';
import { loadTunables } from '../../../src/core/tunables';
import { UNIFORM } from '../../../src/world/bricks';
import { RECORD_UNITS, decodeBrick } from '../../../src/world/encode';
import { fingerprint } from '../../../src/world/fingerprint';
import { P } from '../../../src/world/materials';
import { fillBand } from '../../../src/world/generation/fill';
import { generateWorld, type GeneratedWorld } from '../../../src/world/generation/generate';
import { checkInvariants } from '../../../src/world/generation/invariants';
import { genParams } from '../../../src/world/generation/params';
import { planWorld } from '../../../src/world/generation/plan';
import { columnModel } from '../../../src/world/generation/columns';
import { structureFootprints } from '../../../src/world/generation/props';

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
  it('keeps a GPU mirror holding every brick of the world', () => {
    const raw = new Uint8Array(512);
    let dense = 0;
    let wrong = 0;
    for (let bi = 0; bi < world.map.table.length; bi++) {
      const e = world.map.table[bi];
      const g = world.mirror.gpuTable[bi];
      if (e === 0 || e & UNIFORM) {
        if (g !== e) wrong++;
        continue;
      }
      dense++;
      const unit = g & 0x0fffffff;
      decodeBrick(world.mirror.heapView().subarray(unit * 4, (unit + RECORD_UNITS[g >>> 28]) * 4), raw);
      const want = world.map.denseView(bi)!;
      for (let i = 0; i < 512; i++) {
        if (raw[i] !== want[i]) {
          wrong++;
          break;
        }
      }
    }
    expect(dense).toBe(world.map.denseCount);
    expect(wrong).toBe(0);
    expect(world.mirror.takeEdits()).toEqual([]);
  });
  it('matches the golden fingerprint for seed 7', async () => {
    expect(await fingerprint(world.map)).toBe('dea2a4cd7809b3b83cecf714ba851600f20a91d85da08b1f17e9f4be8da4d67c');
  });
  it('meets the far field along every edge column', () => {
    const ff = world.farField;
    // The first ring of far-field cells outside the map, interpolated along the edge as the renderer draws it.
    const along = (fixed: number, t: number, fixedIsColumn: boolean) => {
      const f = (t - (fixedIsColumn ? ff.originZ : ff.originX)) / ff.cell - 0.5;
      const k = Math.floor(f);
      const w = f - k;
      const cell = (n: number) => (fixedIsColumn ? ff.height[n * ff.size + fixed] : ff.height[fixed * ff.size + n]);
      return cell(k) * (1 - w) + cell(k + 1) * w;
    };
    const left = Math.floor((-1 - ff.originX) / ff.cell);
    const right = Math.floor((p.dims.x - ff.originX) / ff.cell);
    const near = Math.floor((-1 - ff.originZ) / ff.cell);
    const far = Math.floor((p.dims.z - ff.originZ) / ff.cell);
    const off: string[] = [];
    const check = (x: number, z: number, top: number, height: number) => {
      if (Math.abs(top - height) > 2) off.push(`${x},${z}: ground ${top}, far field ${height.toFixed(1)}`);
    };
    for (const [x, col] of [[0, left], [p.dims.x - 1, right]]) {
      const m = columnModel(plan, x, x + 1);
      for (let z = 0; z < p.dims.z; z++) check(x, z, m.top[(x - m.x0) * m.nz + z], along(col, z, true));
    }
    for (const [z, row] of [[0, near], [p.dims.z - 1, far]]) {
      const m = columnModel(plan, 0, p.dims.x, z, z + 1);
      for (let x = 0; x < p.dims.x; x++) check(x, z, m.top[(x - m.x0) * m.nz + z - m.z0], along(row, x, false));
    }
    expect(off.slice(0, 8)).toEqual([]);
    const inside = Math.floor((1280 - ff.originZ) / ff.cell) * ff.size + Math.floor((1280 - ff.originX) / ff.cell);
    expect(ff.material[inside]).toBe(0);
  });
  it('stands every structure on solid ground', () => {
    const floating: string[] = [];
    for (const s of structureFootprints(plan)) {
      if (s.underY === undefined) continue;
      let n = 0;
      for (let x = s.x0; x < s.x1; x++) {
        for (let z = s.z0; z < s.z1; z++) {
          const v = world.map.get(x, s.underY, z);
          if (v === P.AIR || v === P.WATER) n++;
        }
      }
      if (n > 0) floating.push(`${s.kind} at ${s.x0},${s.z0}: ${n} columns over air or water`);
    }
    expect(floating).toEqual([]);
  });
});
