import { describe, expect, it } from 'vitest';
import { lineSource } from '../../src/combat/front';
import { frontHarm, harmTunables } from '../../src/combat/harm';
import { loadTunables } from '../../src/core/tunables';
import { idleIntent, LOCAL_BODY, Session, type CombatEvents } from '../../src/sim/session';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';
import { sameWorld } from '../support/worlds';

// The front in a room (the shared-battle spec's "The front in a room"): each page's front is its
// own, fired at its own player, so its rounds chip nothing of the world everyone shares (their dust
// and suppression stay); a round of it into the player is a harm of its zone's damage times
// front_damage_scale, which the page tells the room; and a player it cannot see is cracked over, not
// hit. Its line is the reference's rig, 38 m off along +z.
const tun = loadTunables();
const harmT = harmTunables(tun);
const TICK = 1 / 60;

/**
 * 51.2 × 6.4 × 51.2 m of sod 0.4 m deep, a clay backstop behind the player (z 0–1 m), and `wall`
 * (a clay wall 2.2 m high, 1 m in front of them) if asked; the player at (25.6, 0.4, 5) facing +z.
 */
function arenaMap(wall: boolean): BrickMap {
  const map = new BrickMap({ x: 512, y: 64, z: 512 });
  map.fillBox(0, 0, 0, 512, 4, 512, P.SOD);
  map.fillBox(0, 4, 0, 512, 64, 10, P.CLAY);
  if (wall) map.fillBox(0, 4, 60, 512, 22, 64, P.CLAY);
  map.takeDirty();
  return map;
}

/** The player settled on the arena, `room` (and, for the room, together, as Together sets both in a match), the front at `intensity`. */
function arena(room: boolean, wall = false): Session {
  const s = Session.create({ map: arenaMap(wall), plan: null, spawn: { position: [25.6, 0.4, 5] }, front: lineSource(38, 0.4) }, tun, 7, 0);
  s.intent = idleIntent();
  s.room = room;
  s.together = room;
  for (let k = 0; k < 40; k++) s.tick();
  s.drainEvents();
  return s;
}

/**
 * The Corridor's range, where Task 8 plays (its fronts at z 34 and 219.5): 25.6 × 6.4 × 204.8 m of sod
 * 0.4 m deep, the clay backstop behind the player (z 0–1 m), and a clay rim 3 m in front of them
 * (z 8.0–8.4) with its top at `topY`; the player at (12.8, 0.4, 5) facing +z, in a room, together,
 * and the front a muzzle fixed 185 m off, 2.45 m over their eye.
 */
const CORRIDOR_MUZZLE: [number, number, number] = [12.8, 4.47, 190];
function corridor(topY: number): Session {
  const map = new BrickMap({ x: 256, y: 64, z: 2048 });
  map.fillBox(0, 0, 0, 256, 4, 2048, P.SOD);
  map.fillBox(0, 4, 0, 256, 64, 10, P.CLAY);
  map.fillBox(0, 4, 80, 256, Math.round(topY / 0.1), 84, P.CLAY);
  map.takeDirty();
  const s = Session.create({ map, plan: null, spawn: { position: [12.8, 0.4, 5] }, front: () => [...CORRIDOR_MUZZLE] }, tun, 7, 0);
  s.intent = idleIntent();
  s.room = true;
  s.together = true;
  for (let k = 0; k < 40; k++) s.tick();
  s.drainEvents();
  return s;
}

/** `seconds` of the front at heavy: everything combat did. */
function heavy(s: Session, seconds: number): CombatEvents[] {
  s.front.intensity = 'heavy';
  const out: CombatEvents[] = [];
  for (let k = 0; k < Math.round(seconds / TICK); k++) {
    s.tick();
    out.push(s.drainEvents());
  }
  return out;
}

/** One kind of event, from every frame. */
function all<K extends keyof CombatEvents>(frames: CombatEvents[], key: K): CombatEvents[K] {
  const out: unknown[] = [];
  for (const e of frames) out.push(...e[key]);
  return out as CombatEvents[K];
}

describe('the front in a room', () => {
  it("in a room the front's rounds raise dust and crack, but chip nothing", () => {
    const s = arena(true);
    const frames = heavy(s, 5);
    expect(all(frames, 'frontShots').length).toBeGreaterThan(20);
    expect(all(frames, 'impacts').length).toBeGreaterThan(0);
    expect(all(frames, 'impacts').every((i) => i.owner === 1)).toBe(true);
    expect(all(frames, 'cracks').length).toBeGreaterThan(0);
    // Its dust is thrown, and it suppresses.
    expect(s.particles.count).toBeGreaterThan(0);
    expect(s.suppression.level).toBeGreaterThan(0);
    expect(sameWorld(s.map, arenaMap(false))).toBe(true);
    // Solo, the same fire marks the backstop and the ground.
    const solo = arena(false);
    const soloFrames = heavy(solo, 5);
    expect(all(soloFrames, 'impacts').length).toBeGreaterThan(0);
    expect(sameWorld(solo.map, arenaMap(false))).toBe(false);
  });

  it("in a room the front's round into the player is a harm of its zone's damage × 0.6, cause round", () => {
    const s = arena(true);
    const frames = heavy(s, 20);
    const hits = all(frames, 'hits').filter((h) => h.owner === 1 && h.body === LOCAL_BODY);
    const harms = all(frames, 'harms');
    expect(harms.length).toBeGreaterThan(0);
    expect(harms.every((h) => h.cause === 'round')).toBe(true);
    // A head's 100, a torso's 55 and a limb's 30, each × 0.6: more than one of them, nothing else.
    for (const h of harms) expect([60, 33, 18]).toContain(h.amount);
    expect(new Set(harms.map((h) => h.amount)).size).toBeGreaterThan(1);
    // One for each of its rounds into the player, on its tick, by its zone.
    expect(harms.map((h) => [h.tick, h.amount])).toEqual(hits.map((h) => [h.tick, frontHarm(h.zone, harmT)]));
    // Together but not in a room (a test's front at a together session): its rounds strike, and harm no one.
    const together = arena(false);
    together.together = true;
    const out = heavy(together, 20);
    expect(all(out, 'hits').filter((h) => h.owner === 1 && h.body === LOCAL_BODY).length).toBeGreaterThan(0);
    expect(all(out, 'harms')).toEqual([]);
  });

  it('a player whose head is behind a wall is cracked over, never hit', () => {
    // The wall's top is over the head as the line sees it: the eye's sight is stopped at its face.
    const s = arena(true, true);
    const frames = heavy(s, 20);
    const shots = all(frames, 'frontShots');
    expect(shots.length).toBeGreaterThan(100);
    expect(all(frames, 'hits')).toEqual([]);
    expect(all(frames, 'harms')).toEqual([]);
    // Every round over the wall's crest (none strikes it), on into the backstop behind the player.
    const impacts = all(frames, 'impacts');
    expect(impacts.filter((i) => i.cell[2] >= 60 && i.cell[2] < 64)).toEqual([]);
    expect(impacts.length).toBeGreaterThan(shots.length * 0.9);
    // Past the head: each heard (but those still in the air at the end), suppressing.
    expect(all(frames, 'cracks').length).toBeGreaterThan(shots.length * 0.95);
    expect(s.suppression.level).toBeGreaterThan(0);
    // Solo it fires about the head as ever, wall or no wall: many of its rounds strike the wall.
    const solo = all(heavy(arena(false, true), 20), 'impacts');
    expect(solo.filter((i) => i.cell[2] >= 60 && i.cell[2] < 64).length).toBeGreaterThan(shots.length / 4);
  });

  it("at the Corridor's range, a player whose eye a rim hides by a hair or by a hand is cracked over, never hit", () => {
    // 185 m out a round falls 0.26 m below the line it leaves on. Aimed straight at 0.3 m over the
    // stop, it would pass a hair's stop 4 cm over: through the head behind it (its top 0.16 m over the
    // eye). And it would strike a hand's rim. Its fall allowed for, it clears both by 0.3 m.
    for (const [topY, hidden] of [
      [2.1, 0.035],
      [2.2, 0.135],
    ]) {
      const what = `hidden by ${hidden} m`;
      const s = corridor(topY);
      const p = s.player.position;
      const eye: [number, number, number] = [p.x, p.y + s.controller.eyeHeight(s.player), p.z];
      expect(eye[1], what).toBeCloseTo(2.02, 6);
      // The muzzle's sight of the eye stopped at the rim's face, `hidden` under its top.
      const stop = s.sight(CORRIDOR_MUZZLE, eye);
      expect(stop, what).not.toBeNull();
      expect(stop![2], what).toBeCloseTo(8.4, 6);
      expect(topY - stop![1], what).toBeCloseTo(hidden, 3);
      const frames = heavy(s, 20);
      const shots = all(frames, 'frontShots');
      expect(shots.length, what).toBeGreaterThan(100);
      expect(all(frames, 'hits'), what).toEqual([]);
      expect(all(frames, 'harms'), what).toEqual([]);
      // None strikes the rim; on over the player into the backstop, each heard (but those still in the air at the end).
      const impacts = all(frames, 'impacts');
      expect(impacts.filter((i) => i.cell[2] >= 80 && i.cell[2] < 84), what).toEqual([]);
      expect(impacts.filter((i) => i.cell[2] < 10).length, what).toBeGreaterThan(shots.length * 0.9);
      expect(all(frames, 'cracks').length, what).toBeGreaterThan(shots.length * 0.95);
    }
  });
});
