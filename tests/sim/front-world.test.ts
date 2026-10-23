import { beforeAll, describe, expect, it } from 'vitest';
import { standardViews } from '../../src/app/views';
import { loadTunables } from '../../src/core/tunables';
import { Stance } from '../../src/physics/character';
import { Session } from '../../src/sim/session';
import { fillBand } from '../../src/world/generation/fill';
import { generateWorld, type GeneratedWorld } from '../../src/world/generation/generate';
import { genParams } from '../../src/world/generation/params';
import { planWorld } from '../../src/world/generation/plan';

// The front over the generated world, from its enemy line's bays: light, the visitor's default,
// is heard without pinning (the spec's Light), even with the head over the crest.
const tun = loadTunables();
const plan = planWorld(genParams(tun), 7);
let world: GeneratedWorld;

beforeAll(async () => {
  world = await generateWorld(plan, async (bands) => bands.map((b) => fillBand(plan, b)));
}, 120_000);

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
