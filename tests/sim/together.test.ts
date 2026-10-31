import { describe, expect, it } from 'vitest';
import { pose } from '../../src/combat/soldier-rig';
import { loadTunables } from '../../src/core/tunables';
import { idleIntent, LOCAL_BODY, Session, type Body } from '../../src/sim/session';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';

// Rounds and bodies (the multiplayer spec's §4): with others in the world, the player's rounds stop
// in their bodies, theirs in the player's, no one's in their own; solo play has no one to hit.
const tun = loadTunables();

/** A floor and a clay wall 13 m ahead of a player standing at (12.8, 0.4, 5) facing +z, settled. */
function arena(together: boolean): Session {
  const map = new BrickMap({ x: 256, y: 64, z: 256 });
  map.fillBox(0, 0, 0, 256, 4, 256, P.SOD);
  map.fillBox(0, 4, 180, 256, 64, 200, P.CLAY);
  const s = Session.create({ map, plan: null, spawn: { position: [12.8, 0.4, 5] } }, tun, 7, 0);
  s.together = together;
  s.intent = idleIntent();
  for (let k = 0; k < 40; k++) s.tick();
  return s;
}

/** Another player standing `z` m out along +z (seat `id`), facing back at the player. */
function body(id: number, z: number): Body {
  const feet: [number, number, number] = [12.8, 0.4, z];
  return { id, feet, frames: pose({ position: feet, yaw: 180, pitch: 0, height: 1.8, speed: 0, bob: 0, deadFor: null }) };
}

/** One shot, aimed level from the eye, and the ticks it takes to land: the hits and impacts. */
function fire(s: Session, pitch = 0) {
  s.player.pitch = pitch;
  s.intent = { ...idleIntent(), fire: true };
  s.tick();
  s.intent = idleIntent();
  // A round flies some 15 m a tick: it may land in the tick that fires it.
  const first = s.drainEvents();
  const hits = [...first.hits];
  const impacts: number[] = first.impacts.map((i) => i.position[2]);
  for (let k = 0; k < 30; k++) {
    s.tick();
    const e = s.drainEvents();
    hits.push(...e.hits);
    impacts.push(...e.impacts.map((i) => i.position[2]));
  }
  return { hits, impacts };
}

describe('rounds among players', () => {
  it("the player's round stops in another's body, which it strikes where it passes", () => {
    const s = arena(true);
    s.bodies = [body(3, 12)];
    const { hits, impacts } = fire(s);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ owner: 0, body: 3 });
    expect(['head', 'torso']).toContain(hits[0].zone);
    expect(hits[0].position[2]).toBeGreaterThan(11.6);
    expect(hits[0].position[2]).toBeLessThan(12.4);
    expect(impacts).toEqual([]);
  });

  it('solo, there is no one to hit: the same round goes on into the wall', () => {
    const s = arena(false);
    s.bodies = [body(3, 12)];
    const { hits, impacts } = fire(s);
    expect(hits).toEqual([]);
    expect(impacts).toHaveLength(1);
  });

  it("another's round strikes the player, and passes through its own shooter's body", () => {
    const s = arena(true);
    // Seat 2's round, from its eye 10 m out, back at the player's chest; seat 2 stands where it fires from.
    s.bodies = [body(2, 15)];
    s.fireRemote(4, [12.8, 1.7, 15.2], [0, -0.02, -1].map((v, _, a) => v / Math.hypot(...a)) as [number, number, number], false, [12.9, 1.6, 15.6]);
    const hits: ReturnType<Session['drainEvents']>['hits'] = [];
    for (let k = 0; k < 10; k++) {
      s.tick();
      hits.push(...s.drainEvents().hits);
    }
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ owner: 4, body: LOCAL_BODY });
    // Its own seat's body (seat 2, owner 4) did not stop it at the start.
    s.bodies = [body(2, 15)];
    s.fireRemote(4, [12.8, 1.2, 15.0], [0, 0, 1], false, [12.8, 1.2, 15.0]);
    for (let k = 0; k < 2; k++) s.tick();
    expect(s.drainEvents().hits).toEqual([]);
  });

  it('the dead do nothing until they are back in, armed and calm', () => {
    const s = arena(true);
    s.alive = false;
    s.weapon.rounds = 3;
    s.suppression.level = 0.8;
    const before = s.player.position;
    s.intent = { ...idleIntent(), forward: 1, fire: true };
    for (let k = 0; k < 30; k++) s.tick();
    expect(s.weapon.rounds).toBe(3);
    expect(s.player.position.x).toBeCloseTo(before.x, 6);
    expect(s.player.position.z).toBeCloseTo(before.z, 6);
    s.respawn([20, 0.4, 8], 90);
    expect(s.alive).toBe(true);
    expect(s.weapon.rounds).toBe(s.weapon.spec.magazine);
    expect(s.suppression.level).toBe(0);
    expect(s.player.position.x).toBe(20);
    expect(s.player.yaw).toBe(90);
  });
});
