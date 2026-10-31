import { beforeAll, describe, expect, it } from 'vitest';
import { standardViews } from '../../src/app/views';
import { Artillery, artilleryTunables, planShellSource } from '../../src/combat/artillery';
import { Rng } from '../../src/core/rng';
import { loadTunables } from '../../src/core/tunables';
import { Stance } from '../../src/physics/character';
import { Session } from '../../src/sim/session';
import { fillBand } from '../../src/world/generation/fill';
import { generateWorld, type GeneratedWorld } from '../../src/world/generation/generate';
import { genParams } from '../../src/world/generation/params';
import { planWorld } from '../../src/world/generation/plan';
import { isSolid, P } from '../../src/world/materials';

// Play over the generated world: every friendly bench is climbed by walking at it from its treads,
// never the parapet behind it unless jump is held, and then every bay is left in seconds, over the
// parapet or the parados (the multiplayer spec's M1); and the front's light fire, the visitor's
// default, is heard without pinning (the spec's Light), even with the head over the crest.
const tun = loadTunables();
const params = genParams(tun);
const plan = planWorld(params, 7);
let world: GeneratedWorld;

beforeAll(async () => {
  world = await generateWorld(plan, async (bands) => bands.map((b) => fillBand(plan, b)));
}, 120_000);

describe('the firing step in the generated world', () => {
  it('every friendly bench is climbed by walking at it from its treads, and the parapet over it only with jump held', () => {
    const v = params.voxel;
    const T = params.trench;
    const timber: number[] = [P.BENCH];
    const bays = world.plan.lines.filter((l) => l.spec.side === 0 && l.spec.firingSteps).flatMap((l) => l.bays.filter((b) => b.firingSteps));
    expect(bays.length).toBe(27);
    const missed: string[] = [];
    let shotAway = 0;
    for (const bay of bays) {
      const lo = bay.stepLo;
      const hi = bay.stepLo + T.bench;
      const f = bay.facing;
      const at = (a: number, b: number): [number, number] => (bay.longAxis === 0 ? [a, b] : [b, a]);
      const benchAt = (a: number) => {
        const [x, z] = at(a, f > 0 ? lo + 2 : hi - 3);
        const [px, pz] = at(a, f > 0 ? hi + 1 : lo - 2);
        return timber.includes(world.map.get(x, bay.stepTopY - 1, z)) && world.map.get(x, bay.stepTopY, z) === P.AIR && world.map.get(px, bay.stepTopY + 10, pz) !== P.AIR;
      };
      // Mid-bay, or the nearest column to it whose bench and parapet a shell has not taken away.
      const mid = Math.floor((bay.a0 + bay.a1) / 2);
      const along: number[] = [];
      for (let d = 0; d <= bay.a1 - bay.a0; d += 3) along.push(mid + d, mid - d);
      const a = along.find((c) => c - 4 > bay.a0 + 12 && c + 4 < bay.a1 && [-3, 0, 3].every((d) => benchAt(c + d)));
      if (a === undefined) {
        shotAway++;
        continue;
      }
      const walkB = f > 0 ? (bay.b0 + lo - T.treadsAcross * T.treadDepth) / 2 : (hi + T.treadsAcross * T.treadDepth + bay.b1) / 2;
      const [x, z] = at(a + 0.5, walkB);
      const s = Session.create({ map: world.map, plan: world.plan, spawn: world.spawn }, tun, 7, 0);
      s.teleport([x * v, (bay.floorY + 1) * v + 0.2, z * v], bay.longAxis === 0 ? (f > 0 ? 0 : 180) : f > 0 ? 90 : -90, 0);
      for (let k = 0; k < 30; k++) s.tick();
      // Up the treads and onto the bench, then on into the parapet: it is not climbed.
      const bench = bay.stepTopY * v;
      s.intent = { ...s.intent, forward: 1 };
      let k = 0;
      while (k++ < 360 && !(s.player.onGround && s.player.position.y > bench - 0.01)) s.tick();
      s.intent = { ...s.intent, forward: 0 };
      for (let j = 0; j < 10; j++) s.tick();
      const y = s.player.position.y;
      const stance = s.player.stance;
      let highest = y;
      s.intent = { ...s.intent, forward: 1 };
      for (let j = 0; j < 120; j++) {
        s.tick();
        highest = Math.max(highest, s.player.position.y);
      }
      if (Math.abs(y - bench) > 0.01 || stance !== Stance.FIRING_STEP || highest > bench + 0.01) {
        missed.push(`${bay.line}#${bay.index}: ${y.toFixed(2)} for ${bench.toFixed(2)}, then at most ${highest.toFixed(2)}, stance ${stance}`);
        continue;
      }
      // Jump held: over the parapet and standing on its crest within 3 s.
      const crest = bay.crestY * v;
      s.intent = { ...s.intent, forward: 1, jump: true };
      let over = -1;
      for (let j = 0; j < 180 && over < 0; j++) {
        s.tick();
        if (s.player.onGround && s.player.position.y > crest - 0.05) over = j;
      }
      if (over < 0) missed.push(`${bay.line}#${bay.index}: not over the parapet (${crest.toFixed(2)}) in 3 s, at ${s.player.position.y.toFixed(2)}`);
    }
    expect(missed, missed.join('\n')).toEqual([]);
    // Breached by the planned direct hits or a crater on the parapet: 3 of the 27 at seed 7.
    expect(shotAway).toBeLessThanOrEqual(3);
  }, 120_000);

  it('from the duckboards of every friendly bay, a jump held at the parados is out of the trench within 3 s', () => {
    const v = params.voxel;
    const T = params.trench;
    const bays = world.plan.lines.filter((l) => l.spec.side === 0 && l.spec.firingSteps).flatMap((l) => l.bays.filter((b) => b.firingSteps));
    const stuck: string[] = [];
    let open = 0;
    for (const bay of bays) {
      const f = bay.facing;
      const lo = bay.stepLo;
      const hi = bay.stepLo + T.bench;
      const at = (a: number, b: number): [number, number] => (bay.longAxis === 0 ? [a, b] : [b, a]);
      const walkB = f > 0 ? (bay.b0 + lo - T.treadsAcross * T.treadDepth) / 2 : (hi + T.treadsAcross * T.treadDepth + bay.b1) / 2;
      // A face behind the walkway, shelled or not, and not a dugout's entrance or a comm trench's
      // mouth (those are walked into, not climbed), nor a crater's floor, nor the burster course
      // heaped over a dugout behind it (a mound to walk round, not a bank to climb): solid at the
      // shins and the chest in the four columns behind, and no higher than the parados, wherever
      // the rear wall was dug back to (up to two voxels past the plan's).
      const rear = f > 0 ? bay.b0 - 1 : bay.b1;
      const solidAt = (a: number, d: number) => {
        const [cx, cz] = at(a, rear - f * d);
        return isSolid(world.map.get(cx, bay.floorY + 3, cz)) && isSolid(world.map.get(cx, bay.floorY + 12, cz)) && !isSolid(world.map.get(cx, bay.groundY + T.paradosH + 2, cz));
      };
      const wall = (a: number) => {
        let back = 0;
        while (back < 2 && !solidAt(a, back)) back++;
        for (let d = back; d < back + 4; d++) if (!solidAt(a, d)) return false;
        return true;
      };
      const mid = Math.floor((bay.a0 + bay.a1) / 2);
      const along: number[] = [];
      for (let d = 0; d <= bay.a1 - bay.a0; d += 3) along.push(mid + d, mid - d);
      const a = along.find((c) => c - 4 > bay.a0 && c + 4 < bay.a1 && [-3, 0, 3].every((d) => wall(c + d)));
      if (a === undefined) {
        open++;
        continue;
      }
      const [x, z] = at(a + 0.5, walkB);
      const duck = (bay.floorY + 1) * v;
      const s = Session.create({ map: world.map, plan: world.plan, spawn: world.spawn }, tun, 7, 0);
      // Facing away from the firing step: the parados is behind the walkway.
      s.teleport([x * v, duck + 0.2, z * v], bay.longAxis === 0 ? (f > 0 ? 180 : 0) : f > 0 ? -90 : 90, 0);
      for (let k = 0; k < 30; k++) s.tick();
      s.intent = { ...s.intent, forward: 1, jump: true };
      let out = -1;
      for (let j = 0; j < 180 && out < 0; j++) {
        s.tick();
        if (s.player.onGround && s.player.position.y > duck + 2.2) out = j;
      }
      if (out < 0) stuck.push(`${bay.line}#${bay.index}: ${(s.player.position.y - duck).toFixed(2)} m over the duckboards after 3 s`);
    }
    expect(stuck, stuck.join('\n')).toEqual([]);
    expect(open).toBeLessThanOrEqual(4);
  }, 120_000);
});

describe('the front over the generated world', () => {
  it('light never pins a player on the firing step with their head over the crest', () => {
    const v = standardViews(world.plan, world.spawn).step;
    const eye = tun.f('player.eye_height_standing');
    const pin = tun.f('suppression.eject_from_step_at');
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const s = Session.create({ map: world.map, plan: world.plan, spawn: world.spawn }, tun, seed, 0);
      s.teleport([v.position[0], v.position[1] - eye, v.position[2]], v.yaw, 0);
      for (let k = 0; k < 30; k++) s.tick();
      expect(s.player.stance).toBe(Stance.FIRING_STEP);
      s.front.intensity = 'light';
      let peak = 0;
      for (let k = 0; k < 5 * 60 * 60; k++) {
        s.tick();
        peak = Math.max(peak, s.suppression.level);
      }
      expect(peak, `seed ${seed}`).toBeLessThan(pin);
      expect(s.ejected, `seed ${seed}`).toBe(0);
      expect(s.suppression.cracks, `seed ${seed}`).toBeGreaterThan(20);
    }
  }, 300_000);
});

describe("the front's shells over the generated world", () => {
  it("the plan's shells land on the map, most of them away from the player, none nearer than 15 m on light and some nearer on heavy", () => {
    const v = standardViews(world.plan, world.spawn).step;
    const target: [number, number, number] = [v.position[0], v.position[1], v.position[2]];
    const size = [world.map.dims.x * params.voxel, world.map.dims.z * params.voxel];
    const landed = (intensity: 'light' | 'heavy') => {
      const a = new Artillery(artilleryTunables(tun), planShellSource(world.plan), Rng.root(5).derive('combat.shells'));
      a.intensity = intensity;
      const d: number[] = [];
      for (let k = 0; k < 10 * 3600; k++) {
        for (const s of a.tick(1 / 60, target).landed) {
          expect(s.x >= 0 && s.x < size[0] && s.z >= 0 && s.z < size[1], `${s.x}, ${s.z}`).toBe(true);
          d.push(Math.hypot(s.x - target[0], s.z - target[2]));
        }
      }
      return d;
    };
    const light = landed('light');
    const heavy = landed('heavy');
    expect(light.length).toBeGreaterThan(40);
    expect(Math.min(...light)).toBeGreaterThanOrEqual(15);
    expect(light.filter((d) => d > 40).length / light.length).toBeGreaterThan(0.6);
    expect(heavy.length).toBeGreaterThan(400);
    expect(heavy.filter((d) => d < 15).length).toBeGreaterThan(0);
  });
});

// Last in the file: its shells cut craters into the world the tests above share.
describe("the visitor's default over the generated world", () => {
  it('light fire and light shelling together never pin a player on the firing step', () => {
    const v = standardViews(world.plan, world.spawn).step;
    const eye = tun.f('player.eye_height_standing');
    const s = Session.create({ map: world.map, plan: world.plan, spawn: world.spawn }, tun, 3, 0);
    s.teleport([v.position[0], v.position[1] - eye, v.position[2]], v.yaw, 0);
    for (let k = 0; k < 30; k++) s.tick();
    s.front.intensity = 'light';
    s.artillery.intensity = 'light';
    let peak = 0;
    let blasts = 0;
    for (let k = 0; k < 5 * 60 * 60; k++) {
      s.tick();
      peak = Math.max(peak, s.suppression.level);
      blasts += s.drainEvents().blasts.length;
    }
    expect(blasts).toBeGreaterThan(20);
    expect(peak).toBeLessThan(tun.f('suppression.eject_from_step_at'));
    expect(s.ejected).toBe(0);
  }, 300_000);
});
