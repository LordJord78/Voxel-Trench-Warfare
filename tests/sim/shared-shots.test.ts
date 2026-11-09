import { describe, expect, it } from 'vitest';
import type { Loadout } from '../../src/combat/arsenal';
import { loadTunables } from '../../src/core/tunables';
import { decodeShotMark } from '../../src/net/gear';
import { decodeShot } from '../../src/net/protocol';
import { idleIntent, Session, type ShotEvent } from '../../src/sim/session';
import { BrickMap } from '../../src/world/bricks';
import { K, kindOf, P } from '../../src/world/materials';
import { sameWorld } from '../support/worlds';

// One shot, one set of chips (the shared-battle spec's "Edits: chips", and the plan's spec note 7):
// in a room the shooter flies its shot as its words say, and every other client flies those words;
// a shotgun's pellets come from the shot's seed, (its shooter's seat, the tick it left on), so the
// shooter's world and a receiver's take the same chips; and a suppressed round flies at the
// suppressor's velocity on both.
const tun = loadTunables();
const TICK = 1 / 60;

/**
 * 25.6 × 6.4 × `lengthM` m: a sod floor 0.4 m deep under the player's first 6.4 m, and, if asked, a
 * sod wall from z 7 to 10 m, 5 m ahead of the player at (12.8, 0.4, 2) facing +z. Not clay: an m870
 * pellet carries at most 280 J (½ × 3.5 g × (400 m/s)²), and clay needs 286 (260 J × its 1.1).
 */
function arena(wall: boolean, lengthM = 51.2): BrickMap {
  const map = new BrickMap({ x: 256, y: 64, z: Math.round(lengthM * 10) });
  map.fillBox(0, 0, 0, 256, 4, 64, P.SOD);
  if (wall) map.fillBox(0, 4, 70, 256, 64, 100, P.SOD);
  map.takeDirty();
  return map;
}

/** A player on `map` in a room (`seat` theirs, if given), settled, with `loadout` in the hands. */
function stand(map: BrickMap, loadout: Loadout, seat?: number): Session {
  const s = Session.create({ map, plan: null, spawn: { position: [12.8, 0.4, 2] }, waterTable: -1 }, tun, 7, 0);
  s.room = true;
  if (seat !== undefined) s.seat = seat;
  s.equip(loadout);
  s.intent = idleIntent();
  for (let k = 0; k < 40; k++) s.tick();
  s.drainEvents();
  return s;
}

/** A pulls the trigger once: their shot's event, from that tick. */
function fireOnce(a: Session): ShotEvent {
  a.intent = { ...idleIntent(), fire: true };
  a.tick();
  a.intent = idleIntent();
  const shots = a.drainEvents().shots;
  expect(shots).toHaveLength(1);
  return shots[0];
}

/** The shot's words, as the room relays them, fired on B as Together fires another's: owner 2 + their seat, at the shot's tick. */
function receive(b: Session, seat: number, shot: ShotEvent): void {
  const heard = decodeShot(shot.wire);
  expect(heard).not.toBeNull();
  const h = heard!;
  b.fireRemote(2 + seat, h.origin, h.dir, h.tracer, h.origin, h.mark, decodeShotMark(h.mark ?? 0).kind, h.tick);
}

describe("another's shot on every client", () => {
  it("another's shotgun shot chips the same voxels on the shooter's world and a receiver's", () => {
    const shotgun: Loadout = { primary: 'm870', secondary: 'm17', fits: {} };
    const a = stand(arena(true), shotgun, 2);
    const b = stand(arena(true), shotgun);
    const shot = fireOnce(a);
    // Its words go with it, and its rounds left from what they say.
    expect(shot.wire).toBeDefined();
    const said = decodeShot(shot.wire)!;
    expect(shot.origin).toEqual(said.origin);
    expect(shot.dir).toEqual(said.dir);
    expect(shot.tick).toBe(said.tick);
    receive(b, 2, shot);
    for (let k = 0; k < 60; k++) {
      a.tick();
      b.tick();
    }
    // A pellet changes at most one voxel and the first flies along the shot's own direction, so a
    // second voxel changed is a seeded pellet's chip.
    const untouched = arena(true);
    const changed: number[] = [];
    for (let z = 0; z < 512; z++) {
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 256; x++) {
          if (a.map.get(x, y, z) !== untouched.get(x, y, z)) changed.push(a.map.get(x, y, z));
        }
      }
    }
    expect(changed.length).toBeGreaterThanOrEqual(2);
    expect(changed.every((p) => kindOf(p) === K.SPOIL)).toBe(true);
    expect(sameWorld(a.map, b.map)).toBe(true);
  });

  it('a suppressed rifle shot flies on the receiver\'s world as on the shooter\'s', () => {
    // 410 m of open air beyond the floor: the round's first 20 ticks (a third of a second) are 290 m.
    const kitted: Loadout = { primary: 'm4', secondary: 'm17', fits: { m4: { optic: 'reddot', muzzle: 'suppressor', under: 'none', side: 'none' } } };
    const a = stand(arena(false, 409.6), kitted, 3);
    const b = stand(arena(false, 409.6), kitted);
    const shot = fireOnce(a);
    expect(decodeShotMark(shot.mark!)).toMatchObject({ gun: 'm4', suppressed: true });
    // The shooter's round stepped once in the tick it left on; the receiver's steps once in its next.
    receive(b, 3, shot);
    b.tick();
    expect(a.rounds.count).toBe(1);
    expect(b.rounds.count).toBe(1);
    expect(b.rounds.position(0)).toEqual(a.rounds.position(0));
    expect(b.rounds.velocity(0)).toEqual(a.rounds.velocity(0));
    // At the suppressor's velocity, 0.97 of the bare gun's 905 m/s, less a tick's drag (under 2%).
    const v = b.rounds.velocity(0);
    expect(Math.hypot(v[0], v[1], v[2])).toBeLessThan(0.97 * 905);
    expect(Math.hypot(v[0], v[1], v[2])).toBeGreaterThan(0.98 * 0.97 * 905);
    for (const [upTo, steps] of [[5, 4], [20, 15]]) {
      for (let k = 0; k < steps; k++) {
        a.tick();
        b.tick();
      }
      expect(b.rounds.count, `${upTo} ticks`).toBe(1);
      expect(b.rounds.position(0), `${upTo} ticks`).toEqual(a.rounds.position(0));
      expect(b.rounds.velocity(0), `${upTo} ticks`).toEqual(a.rounds.velocity(0));
    }
  });
});
