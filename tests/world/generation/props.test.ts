import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../../src/core/tunables';
import { BrickMap } from '../../../src/world/bricks';
import { P } from '../../../src/world/materials';
import { bandMap } from '../../../src/world/generation/fill';
import { checkInvariants } from '../../../src/world/generation/invariants';
import { genParams } from '../../../src/world/generation/params';
import { planWorld } from '../../../src/world/generation/plan';
import { stampProp } from '../../../src/world/generation/props';

const p = genParams(loadTunables());
const plan = planWorld(p, 7);

function stampSplit(prop: (typeof plan.props)[number], split: number): BrickMap {
  const w = new BrickMap({ x: 256, y: 320, z: 256 });
  const ox = Math.floor(prop.x) - 128, oz = Math.floor(prop.z) - 128;
  const sink = (lo: number, hi: number) => ({
    set: (x: number, y: number, z: number, v: number) => { if (x >= lo && x < hi) w.set(x - ox, y, z - oz, v); },
    get: (x: number, y: number, z: number) => w.get(x - ox, y, z - oz),
  });
  stampProp(sink(-1e9, ox + split), { x0: -1e9, x1: ox + split }, plan, prop);
  stampProp(sink(ox + split, 1e9), { x0: ox + split, x1: 1e9 }, plan, prop);
  return w;
}

describe('props', () => {
  it('plans every kind', () => {
    const kinds = new Set(plan.props.map((q) => q.kind));
    for (const k of ['tree', 'wire', 'pole', 'fence', 'hull', 'farm', 'culvert', 'hamlet', 'church']) expect(kinds.has(k), k).toBe(true);
  });
  it('stamps the same voxels however the band boundary cuts a prop', () => {
    for (const kind of ['hull', 'farm', 'culvert', 'church', 'tree']) {
      const prop = plan.props.find((q) => q.kind === kind)!;
      const a = stampSplit(prop, 128), b = stampSplit(prop, 100);
      for (let i = 0; i < 4000; i++) {
        const x = 64 + (i * 7) % 128, y = 150 + (i * 13) % 100, z = 64 + (i * 29) % 128;
        expect(a.get(x, y, z), `${kind} at ${x},${y},${z}`).toBe(b.get(x, y, z));
      }
    }
  });
  it('levels building sites without leaving spoil past repose at their edge', () => {
    for (const kind of ['farm', 'church', 'hamlet']) {
      const prop = plan.props.find((q) => q.kind === kind)!;
      const band = Math.floor(prop.x / 32);
      for (const b of [band - 1, band, band + 1]) {
        const map = bandMap(plan, b);
        const r = checkInvariants(map, p.waterTable, { ditchWater: true });
        expect(r.looseSteep, `${kind} band ${b}: ${r.samples.join('; ')}`).toBe(0);
      }
    }
  });
  it('builds the hull out of hull plate, standing in no man\'s land', () => {
    const hull = plan.props.find((q) => q.kind === 'hull')!;
    const band = Math.floor(hull.x / 32);
    const map = bandMap(plan, band);
    let plate = 0;
    for (let x = 0; x < 32; x++) for (let y = 120; y < 220; y++) for (let z = Math.floor(hull.z) - 20; z < hull.z + 20; z++) {
      const v = map.get(x, y, z);
      if (v === P.HULL || v === P.HULL_RUST) plate++;
    }
    expect(plate).toBeGreaterThan(500);
  });
});
