import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../../src/core/tunables';
import { FLAG, columnModel } from '../../../src/world/generation/columns';
import { genParams } from '../../../src/world/generation/params';
import { planWorld } from '../../../src/world/generation/plan';
import { structureFootprints } from '../../../src/world/generation/props';
import type { LegPlan, LinePlan } from '../../../src/world/generation/trenches';

const p = genParams(loadTunables());
const plan = planWorld(p, 7);

interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}
const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;
const grow = (r: Rect, k: number): Rect => ({ x0: r.x0 - k, x1: r.x1 + k, z0: r.z0 - k, z1: r.z1 + k });
const legRect = (leg: LegPlan): Rect =>
  leg.longAxis === 0 ? { x0: leg.a0, x1: leg.a1, z0: leg.b0, z1: leg.b1 } : { x0: leg.b0, x1: leg.b1, z0: leg.a0, z1: leg.a1 };

/** Every bay and leg of every line, in world x/z. */
function trenchRects(): { line: number; bay: number | null; rect: Rect }[] {
  const out: { line: number; bay: number | null; rect: Rect }[] = [];
  plan.lines.forEach((line, li) => {
    line.bays.forEach((b, bi) => out.push({ line: li, bay: bi, rect: { x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1 } }));
    line.legs.forEach((leg) => out.push({ line: li, bay: null, rect: legRect(leg) }));
  });
  return out;
}

/**
 * The floor heights of every walkway column (trench floor, not firing-step
 * timber), and a flood fill over them that climbs at most a step-up.
 */
function trenchNetwork() {
  const tops = new Map<number, number>();
  const key = (x: number, z: number) => x * p.dims.z + z;
  for (const { rect } of trenchRects()) {
    const m = columnModel(plan, rect.x0, rect.x1, rect.z0, rect.z1);
    for (let x = rect.x0; x < rect.x1; x++) {
      for (let z = rect.z0; z < rect.z1; z++) {
        const c = (x - m.x0) * m.nz + z - m.z0;
        if (m.flags[c] & FLAG.TRENCH && m.solidTop[c] < 0) tops.set(key(x, z), m.top[c]);
      }
    }
  }
  const reach = (line: LinePlan): Set<number> => {
    const mid = line.bays[line.bays.length >> 1];
    const start = key(Math.floor(mid.walkX), Math.floor(mid.walkZ));
    const seen = new Set<number>([start]);
    const queue = [start];
    while (queue.length) {
      const k = queue.pop()!;
      const x = Math.floor(k / p.dims.z);
      const z = k - x * p.dims.z;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const n = key(x + dx, z + dz);
        const top = tops.get(n);
        if (top === undefined || seen.has(n) || Math.abs(top - tops.get(k)!) > p.stepUp) continue;
        seen.add(n);
        queue.push(n);
      }
    }
    return seen;
  };
  return { key, reach };
}

describe('the plan as a whole', () => {
  it('keeps every dugout clear of every other trench', () => {
    const rects = trenchRects();
    const clashes: string[] = [];
    plan.lines.forEach((line, li) => {
      for (const d of line.dugouts) {
        const own = line.bays.findIndex((b) => d.entrance[line.spec.longAxis] >= b.a0 && d.entrance[line.spec.longAxis] < b.a1);
        const body = [{ x0: d.lo[0], x1: d.hi[0], z0: d.lo[2], z1: d.hi[2] }, d.passage].map((r) => grow(r, 1));
        for (const t of rects) {
          if (t.line === li && t.bay === own) continue;
          if (body.some((r) => overlaps(r, t.rect))) clashes.push(`${line.spec.name} dugout at x ${d.lo[0]} meets ${plan.lines[t.line].spec.name}`);
        }
      }
    });
    expect(clashes).toEqual([]);
  });

  it('keeps comm trenches behind their own front line', () => {
    const T = p.trench;
    for (const line of plan.lines) {
      if (!line.spec.name.includes('comm')) continue;
      const zs = line.bays.flatMap((b) => [b.z0, b.z1]);
      if (line.spec.side === 0) expect(Math.max(...zs)).toBeLessThanOrEqual(p.layout.front + T.offset);
      else expect(Math.min(...zs)).toBeGreaterThanOrEqual(p.layout.enemyFront + T.width);
    }
  });

  it('keeps open craters clear of structures and of the map edge', () => {
    const structures = structureFootprints(plan);
    expect(structures.some((s) => s.kind === 'farm')).toBe(true);
    expect(structures.some((s) => s.kind === 'dugout')).toBe(true);
    const clashes: string[] = [];
    for (const c of plan.craters) {
      const reach = Math.ceil(1.4 * c.r) + 1;
      const zone = { x0: c.x - reach, x1: c.x + reach, z0: c.z - reach, z1: c.z + reach };
      for (const s of structures) if (overlaps(zone, s)) clashes.push(`crater at ${c.x},${c.z} r ${c.r.toFixed(1)} reaches the ${s.kind}`);
      if (zone.x0 < 0 || zone.z0 < 0 || zone.x1 > p.dims.x || zone.z1 > p.dims.z) clashes.push(`crater at ${c.x},${c.z} reaches the map edge`);
    }
    expect(clashes).toEqual([]);
  });

  it('gives only crossing trenches a floor profile, and climbs it one tread at a time', () => {
    for (const line of plan.lines) {
      expect(line.profile !== undefined, line.spec.name).toBe(line.spec.longAxis === 2);
      if (!line.profile) continue;
      const f = line.profile.floors;
      let step = 0;
      for (let i = 1; i < f.length; i++) step = Math.max(step, Math.abs(f[i] - f[i - 1]));
      expect(step, line.spec.name).toBeLessThanOrEqual(p.trench.treadRise);
    }
  });

  it('joins every trench on each side into one network a player can walk', () => {
    const { key, reach } = trenchNetwork();
    for (const side of [0, 1]) {
      const lines = plan.lines.filter((l) => l.spec.side === side);
      const seen = reach(lines.find((l) => l.spec.firingSteps)!);
      const cut: string[] = [];
      for (const line of lines) {
        for (const b of line.bays) if (!seen.has(key(Math.floor(b.walkX), Math.floor(b.walkZ)))) cut.push(`${line.spec.name} bay ${b.index}`);
      }
      expect(cut).toEqual([]);
    }
  }, 60_000);
});
