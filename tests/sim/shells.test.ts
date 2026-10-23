import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../src/core/tunables';
import { BILLBOARD_FLOATS } from '../../src/combat/particles';
import { Stance } from '../../src/physics/character';
import { boxHitsSolid } from '../../src/physics/collision';
import { idleIntent, Session } from '../../src/sim/session';
import { isSolid, P, paletteData } from '../../src/world/materials';
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

  it('a landing throws a flash, and soil and debris of the struck material, and shakes and suppresses a player near it', () => {
    const s = session([12.8, 4.4, 13.0]);
    expect(s.blastShake.amplitude).toBe(0);
    expect(s.suppression.level).toBe(0);
    s.land(20.8, 15.0, 2.5, 3);
    const out = new Float32Array(s.particles.capacity * BILLBOARD_FLOATS);
    const all = Array.from({ length: s.particles.billboards(out) }, (_, i) => out.slice(i * BILLBOARD_FLOATS, (i + 1) * BILLBOARD_FLOATS));
    const kind = (k: number) => all.filter((b) => b[8] === k);
    expect(kind(1).length).toBe(tun.i('particles.blast_flash.count'));
    expect(kind(2).length).toBe(tun.i('particles.debris.count'));
    expect(kind(0).length).toBe(tun.i('particles.shell_soil.count'));
    // Of the struck spoil's colour: its hue, whatever its alpha.
    const palette = paletteData();
    const tint = [palette[P.SPOIL * 8], palette[P.SPOIL * 8 + 1]];
    for (const b of [...kind(0), ...kind(2)]) expect(b[4] / b[5]).toBeCloseTo(tint[0] / tint[1], 3);
    expect(s.blastShake.amplitude).toBeGreaterThan(0);
    expect(s.suppression.level).toBeGreaterThan(0);
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

  it("a parapet's slump onto a player on the trench floor stands them on it: never inside solid, never held in the air", () => {
    // The review's case: the slump was written into the body, and nothing lifted it out.
    for (const stance of [Stance.STANDING, Stance.CROUCHED, Stance.PRONE]) {
      for (const z of [12.6, 13.0, 13.3]) {
        for (const [sx, sz, r] of [[12.8, 15.0, 3], [14.5, 15.0, 3], [11.0, 14.2, 3], [12.8, 15.0, 3.4]] as const) {
          const s = Session.create({ map: trenchArena(), plan: null, spawn: { position: [12.8, 4.6, z] }, waterTable: 42 }, tun, 7, 0);
          s.intent = { ...idleIntent(), stance };
          for (let k = 0; k < 120; k++) s.tick();
          const p = s.player;
          const g = s.controller.grid;
          expect(boxHitsSolid(g, p.position, s.controller.t.radius, p.height)).toBe(false);
          s.land(sx, sz, r, 11);
          for (let k = 0; k < 240; k++) {
            s.tick();
            const where = `${stance} at z ${z}, shell ${sx},${sz} r ${r}, tick ${k}: ${p.position.y.toFixed(2)} v ${p.velocity.y.toFixed(2)}`;
            expect(boxHitsSolid(g, p.position, s.controller.t.radius, p.height), where).toBe(false);
            expect(p.onGround || p.velocity.y < 0 || p.climbTo !== null, where).toBe(true);
            const eye = [p.position.x, p.position.y + s.controller.eyeHeight(p), p.position.z].map((m) => Math.floor(m / 0.1));
            expect(isSolid(s.map.get(eye[0], eye[1], eye[2])), where).toBe(false);
          }
        }
      }
    }
  });
});
