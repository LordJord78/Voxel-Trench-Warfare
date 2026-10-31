import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadTunables } from '../../../src/core/tunables';
import { fingerprint } from '../../../src/world/fingerprint';
import { isSolid } from '../../../src/world/materials';
import { corridorX } from '../../../src/world/generation/corridor';
import { fillBand } from '../../../src/world/generation/fill';
import { generateWorld, type GeneratedWorld } from '../../../src/world/generation/generate';
import { checkInvariants } from '../../../src/world/generation/invariants';
import { MAP_SEEDS, genParams } from '../../../src/world/generation/params';
import { planWorld } from '../../../src/world/generation/plan';
import { pickSpawns } from '../../../src/world/generation/spawn';
import { clearOfTrenches } from '../../../src/world/generation/trenches';

// The Corridor (the multiplayer spec's §5): a wood down the middle, Red dug in at its south end and
// Blue at its north, the whole map the same turned half a turn about its centre.
const golden = JSON.parse(readFileSync(new URL('../../fixtures/golden-corridor.json', import.meta.url), 'utf8')) as { seed: number; fingerprint: string };

const p = genParams(loadTunables(), undefined, 'corridor');
const seed = MAP_SEEDS.corridor;
const plan = planWorld(p, seed);
const W = p.dims;
let world: GeneratedWorld;

beforeAll(async () => {
  world = await generateWorld(plan, async (bands) => bands.map((b) => fillBand(plan, b)));
}, 180_000);

describe('the Corridor', () => {
  it('has Red’s lines and Blue’s, each of Blue’s the turn of one of Red’s', () => {
    const names = plan.lines.map((l) => l.spec.name);
    expect(names).toEqual(['front', 'support', 'comm_0', 'comm_1', 'enemy_front', 'enemy_support', 'enemy_comm_0', 'enemy_comm_1']);
    for (const red of plan.lines.filter((l) => l.spec.side === 0)) {
      const blue = plan.lines.find((l) => l.spec.name === `enemy_${red.spec.name}`)!;
      expect(blue.bays).toHaveLength(red.bays.length);
      const turned = (b: (typeof red.bays)[number]) => [W.x - b.x1, W.x - b.x0, W.z - b.z1, W.z - b.z0, b.floorY, b.crestY, -b.facing];
      const have = new Set(blue.bays.map((b) => [b.x0, b.x1, b.z0, b.z1, b.floorY, b.crestY, b.facing].join()));
      for (const b of red.bays) expect(have.has(turned(b).join()), `${red.spec.name}#${b.index}`).toBe(true);
    }
  });

  it('is generated settled and dry', () => {
    const r = checkInvariants(world.map, p.waterTable, { ditchWater: true });
    expect(r.hangingGranular, r.samples.join('\n')).toBe(0);
    expect(r.looseSteep, r.samples.join('\n')).toBe(0);
    expect(r.waterAboveTable).toBe(0);
  });

  it('is the same, solid for solid, turned half a turn: field, trenches, craters', () => {
    // Every 7th column each way, every voxel from the water table up; trees and the
    // shelling's carving may differ in their detail, nothing else.
    let same = 0;
    let all = 0;
    for (let x = 3; x < W.x; x += 7) {
      for (let z = 3; z < W.z / 2; z += 7) {
        for (let y = p.waterTable; y < p.ground + 60; y++) {
          all++;
          if (isSolid(world.map.get(x, y, z)) === isSolid(world.map.get(W.x - 1 - x, y, W.z - 1 - z))) same++;
        }
      }
    }
    expect(same / all).toBeGreaterThan(0.995);
  });

  it('spawns each side in its own fire trench, at least four apiece, at either end of the wood', () => {
    const red = pickSpawns(world.map, plan, 'front', 8);
    const blue = pickSpawns(world.map, plan, 'enemy_front', 8);
    expect(red.length).toBeGreaterThanOrEqual(4);
    expect(blue.length).toBeGreaterThanOrEqual(4);
    const v = p.voxel;
    const wood = plan.corridor!;
    for (const s of red) expect(s.position[2] / v).toBeLessThan(wood.z0);
    for (const s of blue) expect(s.position[2] / v).toBeGreaterThan(wood.z1);
  });

  it('plants the wood down the middle, thick, and no tree in a trench', () => {
    const trees = plan.props.filter((q) => q.kind === 'tree');
    expect(trees.length).toBeGreaterThan(300);
    const wood = plan.corridor!;
    const inWood = trees.filter((q) => Math.abs(q.x - corridorX(p, wood, q.z)) <= wood.edge + 10);
    expect(inWood.length / trees.length).toBeGreaterThan(0.95);
    const clear = clearOfTrenches(plan.lines, 1);
    for (const q of trees) expect(clear(q.x, q.z), `tree at ${q.x},${q.z}`).toBe(true);
  });

  it('matches the golden fingerprint for seed 11', async () => {
    expect(golden.seed).toBe(seed);
    expect(await fingerprint(world.map)).toBe(golden.fingerprint);
  });
});
