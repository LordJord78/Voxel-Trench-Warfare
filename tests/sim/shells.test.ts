import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../src/core/tunables';
import { boxHitsSolid } from '../../src/physics/collision';
import { Session } from '../../src/sim/session';
import { P } from '../../src/world/materials';
import { trenchArena } from '../support/worlds';

// A shell landing in the session: at the top of the ground under it, its blast an event at once and
// its crater an event once it is in the world; and the ground going from under the player leaves
// them falling or standing, never inside solid or held in the air.
const tun = loadTunables();

function session(spawn: [number, number, number] = [3.2, 4.4, 2]): Session {
  const s = Session.create({ map: trenchArena(), plan: null, spawn: { position: spawn }, waterTable: 42 }, tun, 7, 0);
  // Down to the ground under the spawn: the trench's floor is 3 m below the crest.
  for (let k = 0; k < 90; k++) s.tick();
  s.drainEvents();
  return s;
}

describe('a shell landing', () => {
  it('lands at the top of the ground, and its crater is an event with a blast', () => {
    const s = session();
    const id = s.land(12.8, 15.0, 3, 7);
    expect(id).not.toBeNull();
    const first = s.drainEvents();
    expect(first.blasts).toEqual([{ tick: s.ticks, at: [12.8, 7.6000000000000005, 15.0], radiusM: 3, material: P.SPOIL }]);
    const craters = [];
    for (let k = 0; k < 10; k++) {
      s.tick();
      craters.push(...s.drainEvents().craters);
    }
    expect(craters.map((c) => [c.id, c.centre, c.radius])).toEqual([[id, [128, 76, 150], 30]]);
    expect(s.map.get(128, 75, 150)).toBe(P.AIR);
  });

  it('a shell with no ground under it lands nowhere', () => {
    const s = session();
    expect(s.land(-5, 15, 3, 7)).toBeNull();
    expect(s.drainEvents().blasts).toEqual([]);
  });

  it('a crater cut where the player stands leaves them falling or standing, never inside solid or held in the air', () => {
    for (const [x, z] of [[12.8, 15.0], [12.8, 14.2], [13.5, 12.4]] as const) {
      const s = session([x, 7.6, z]);
      const p = s.player;
      expect(p.onGround).toBe(true);
      s.land(x, z, 3, 11);
      for (let k = 0; k < 150; k++) {
        s.tick();
        const where = `${x},${z} tick ${k}: ${p.position.x.toFixed(2)},${p.position.y.toFixed(2)},${p.position.z.toFixed(2)} v ${p.velocity.y.toFixed(2)}`;
        expect(boxHitsSolid(s.controller.grid, p.position, s.controller.t.radius, p.height), where).toBe(false);
        expect(p.onGround || p.velocity.y < 0 || p.climbTo !== null, where).toBe(true);
      }
      expect(p.onGround).toBe(true);
      expect(p.position.y).toBeLessThan(7.0);
    }
  });
});
