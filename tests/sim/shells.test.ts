import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../src/core/tunables';
import { blastHarm, harmTunables } from '../../src/combat/harm';
import { BILLBOARD_FLOATS } from '../../src/combat/particles';
import { CHEST, pose, toWorld } from '../../src/combat/soldier-rig';
import { Stance } from '../../src/physics/character';
import { boxHitsSolid } from '../../src/physics/collision';
import { idleIntent, Session } from '../../src/sim/session';
import { isSolid, P, paletteData } from '../../src/world/materials';
import { trenchArena } from '../support/worlds';

// A shell landing in the session: at the top of the ground under it, its blast an event at once and
// its crater an event once it is in the world; and the ground going from under the player leaves
// them falling or standing, never inside solid or held in the air. In a room, a shell by the player
// harms them by its distance from their chest and whether its way there is blocked.
const tun = loadTunables();
const harmT = harmTunables(tun);

/** The player's chest as their body is posed (soldier-rig.ts CHEST, the middle of its torso's box). */
function chestOf(s: Session): [number, number, number] {
  const p = s.player;
  const frames = pose({ position: p.position.toArray(), yaw: p.yaw, pitch: p.pitch, height: p.height, speed: p.velocity.horizontalLength, bob: p.bobPhase, deadFor: null });
  return toWorld(frames.torso, CHEST);
}

const near = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

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
    expect(first.blasts).toEqual([{ tick: s.ticks, at: [12.8, 7.6000000000000005, 15.0], radiusM: 3, material: P.SPOIL, crater: id, seed: 7 }]);
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

  it('a shell landing on water is a splash at its top, as big as the shell', () => {
    const s = session();
    // A pool on the ground 12.8 m along, its top 0.3 m over the ground there.
    const top = Math.round(7.6 / 0.1);
    s.map.fillBox(120, top, 140, 136, top + 3, 160, P.WATER);
    s.land(12.8, 15.0, 3, 7);
    const e = s.drainEvents();
    expect(e.blasts).toHaveLength(1);
    expect(e.blasts[0].material).toBe(P.WATER);
    expect(e.splashes).toEqual([{ tick: s.ticks, at: e.blasts[0].at, energyJ: expect.any(Number), kind: 'shell' }]);
    expect(e.splashes[0].energyJ).toBeGreaterThan(1e5);
    // On dry ground, none.
    const dry = session();
    dry.land(12.8, 15.0, 3, 7);
    expect(dry.drainEvents().splashes).toEqual([]);
  });

  it('a shell landing beside water throws its debris in: splashes on the water a moment later, the same for the same seed; none with no water near', () => {
    const top = Math.round(7.6 / 0.1);
    const run = (pool: boolean) => {
      const s = session();
      // A pool's top level with the ground, 2 m to 7 m off along x from where the shell lands.
      if (pool) s.map.fillBox(148, top - 2, 90, 198, top, 210, P.WATER);
      s.land(12.8, 15.0, 3, 7);
      const landed = s.ticks;
      const out: { tick: number; at: number[]; energyJ: number; kind: string }[] = [];
      for (let k = 0; k < 120; k++) {
        s.tick();
        out.push(...s.drainEvents().splashes);
      }
      return { landed, debris: out.filter((w) => w.kind === 'debris'), dt: s.clock.dt };
    };
    const a = run(true);
    expect(a.debris.length).toBeGreaterThan(0);
    for (const w of a.debris) {
      // On the pool's top, after the debris' fall.
      expect(w.at[0]).toBeGreaterThanOrEqual(14.8 - 1e-9);
      expect(w.at[1]).toBeCloseTo(7.6, 6);
      expect((w.tick - a.landed) * a.dt).toBeGreaterThanOrEqual(0.6 - 1e-9);
      expect((w.tick - a.landed) * a.dt).toBeLessThanOrEqual(1.4 + a.dt);
      expect(w.energyJ).toBeLessThan(1e4);
    }
    expect(run(true).debris).toEqual(a.debris);
    expect(run(false).debris).toEqual([]);
  });

  it('a shell with no ground under it lands nowhere', () => {
    const s = session();
    expect(s.land(-5, 15, 3, 7)).toBeNull();
    expect(s.drainEvents().blasts).toEqual([]);
  });

  it("in a room a shell by the player is a harm of its blast's by distance and cover; none solo, quiet, or dead", () => {
    // The player on the open clay 7 m short of the trench, the shell 2 m ahead of them.
    const at = (s: Session) => {
      s.drainEvents();
      s.land(12.8, 7.0, 3, 7);
      return s.drainEvents();
    };
    const open = session([12.8, 6.4, 5.0]);
    open.room = true;
    const e = at(open);
    expect(e.blasts).toHaveLength(1);
    const d = near(e.blasts[0].at, chestOf(open));
    expect(d).toBeGreaterThan(2);
    expect(d).toBeLessThan(3);
    expect(e.harms.map((h) => [h.tick, h.cause])).toEqual([[open.ticks, 'shell']]);
    expect(e.harms[0].amount).toBeCloseTo(blastHarm(d, 3, false, harmT), 9);
    expect(e.harms[0].amount).toBeGreaterThan(100);
    // A clay wall 2.5 m high between them, 0.4 m thick and a metre from the player: the same blast, covered.
    const walled = session([12.8, 6.4, 5.0]);
    walled.map.fillBox(0, 64, 58, 256, 89, 62, P.CLAY);
    walled.room = true;
    const w = at(walled);
    expect(near(w.blasts[0].at, chestOf(walled))).toBeCloseTo(d, 9);
    expect(w.harms.map((h) => h.cause)).toEqual(['shell']);
    expect(w.harms[0].amount).toBeCloseTo(blastHarm(d, 3, true, harmT), 9);
    expect(w.harms[0].amount).toBeCloseTo(0.35 * e.harms[0].amount, 9);
    // Solo, none.
    expect(at(session([12.8, 6.4, 5.0])).harms).toEqual([]);
    // Quiet: its crater alone, no blast, no particles, shake, suppression or harm.
    const quiet = session([12.8, 6.4, 5.0]);
    quiet.room = true;
    quiet.drainEvents();
    const billboards = () => quiet.particles.billboards(new Float32Array(quiet.particles.capacity * BILLBOARD_FLOATS));
    const before = billboards();
    expect(quiet.land(12.8, 7.0, 3, 7, true)).not.toBeNull();
    const q = quiet.drainEvents();
    expect([q.blasts, q.harms, q.splashes]).toEqual([[], [], []]);
    expect(quiet.suppression.level).toBe(0);
    expect(quiet.blastShake.amplitude).toBe(0);
    expect(billboards()).toBe(before);
    expect(quiet.destruction.pending).toBe(1);
    // Dead, none.
    const dead = session([12.8, 6.4, 5.0]);
    dead.room = true;
    dead.alive = false;
    const k = at(dead);
    expect(k.blasts).toHaveLength(1);
    expect(k.harms).toEqual([]);
  });

  it('in a room a shell is cut where the ground is when its crater goes out, and the crater says what it struck', () => {
    const s = session([12.8, 6.4, 3.0]);
    s.room = true;
    const id = s.land(12.8, 15.0, 3, 7);
    const craters = [];
    for (let k = 0; k < 10; k++) {
      s.tick();
      craters.push(...s.drainEvents().craters);
    }
    expect(craters.map((c) => [c.id, c.centre, c.radius, c.material])).toEqual([[id, [128, 76, 150], 30, P.SPOIL]]);
    // Solo, a crater carries no material.
    const solo = session([12.8, 6.4, 3.0]);
    solo.land(12.8, 15.0, 3, 7);
    const soloCraters = [];
    for (let k = 0; k < 10; k++) {
      solo.tick();
      soloCraters.push(...solo.drainEvents().craters);
    }
    expect(soloCraters).toHaveLength(1);
    expect(soloCraters[0]).not.toHaveProperty('material');
  });

  it('a whistle is an incoming shell at the top of the ground, in the time given', () => {
    const s = session([12.8, 6.4, 3.0]);
    s.whistle(12.8, 15.0, 1.25);
    expect(s.drainEvents().incoming).toEqual([{ tick: s.ticks, at: [12.8, 7.6000000000000005, 15.0], landsInS: 1.25 }]);
    s.whistle(-5, 15, 1);
    expect(s.drainEvents().incoming).toEqual([]);
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
    // 36 sessions of 6 s each: over the default timeout on a slower machine than the M1 Pro.
  }, 120_000);
});
