import { describe, expect, it } from 'vitest';
import type { Loadout } from '../../src/combat/arsenal';
import { loadTunables } from '../../src/core/tunables';
import { decodeShotMark } from '../../src/net/gear';
import { idleIntent, Session, SHOVEL_HELD } from '../../src/sim/session';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';

// The loadout in the session (sim/session.ts): two guns carried, each its own weapon, recoil and
// kick; one in the hands at a time, the other brought up by its number; the sights raised on the
// right button; a shotgun's pellets; and the shots marked for the others with gun and kit.
const tun = loadTunables();

/** 12.8 m square of clay 0.4 m deep, a player standing on it facing +z, settled. */
function stand(loadout?: Loadout): Session {
  const map = new BrickMap({ x: 128, y: 64, z: 128 });
  map.fillBox(0, 0, 0, 128, 4, 128, P.CLAY);
  map.takeDirty();
  const s = Session.create({ map, plan: null, spawn: { position: [6.4, 0.4, 2.0] }, waterTable: -1 }, tun, 7, 0);
  if (loadout) s.equip(loadout);
  for (let k = 0; k < 60; k++) s.tick();
  s.drainEvents();
  return s;
}

const KITTED: Loadout = {
  primary: 'm4',
  secondary: 'm17',
  fits: { m4: { optic: 'reddot', muzzle: 'suppressor', under: 'vertical', side: 'laser' } },
  tracer: 'green',
};

describe('the loadout in the hands', () => {
  it('is the bare AK and the pistol until a loadout is taken in', () => {
    const s = stand();
    expect(s.weapon.spec.key).toBe('assault_rifle');
    expect(s.arms.map((a) => a.spec.gun.key)).toEqual(['ak74', 'm17']);
  });

  it("takes in a loadout's guns, and marks each shot with its gun and kit", () => {
    const s = stand(KITTED);
    expect(s.arm.spec.gun.key).toBe('m4');
    expect(s.weapon.spec.magazine).toBe(30);
    s.intent = { ...idleIntent(), fire: true };
    s.tick();
    const shot = s.drainEvents().shots[0];
    expect(shot).toBeDefined();
    expect(decodeShotMark(shot.mark!)).toMatchObject({ gun: 'm4', suppressed: true });
    expect(shot.report!).toBeLessThan(0.5);
    expect(shot.flash!).toBeLessThan(0.5);
  });

  it('brings up the pistol on its number, and nothing fires while the guns change', () => {
    const s = stand(KITTED);
    s.intent = { ...idleIntent(), swap: 1, fire: true };
    s.tick();
    s.intent = { ...idleIntent(), fire: true };
    let fired = 0;
    for (let k = 0; k < 20; k++) {
      s.tick();
      fired += s.shots.length;
    }
    expect(fired).toBe(0);
    for (let k = 0; k < 30; k++) s.tick();
    expect(s.held).toBe(1);
    expect(s.weapon.spec.magazine).toBe(17);
    expect(s.weapon.shotsFired).toBeGreaterThan(0);
  });

  it('raises the sights on the right button: the cone narrows and the view closes in', () => {
    const s = stand(KITTED);
    const hip = s.coneDeg();
    s.intent = { ...idleIntent(), aim: true };
    for (let k = 0; k < 30; k++) s.tick();
    expect(s.aimed).toBe(1);
    expect(s.coneDeg()).toBeLessThan(hip * 0.6);
    expect(s.zoomAt(1)).toBeGreaterThan(1.2);
    s.intent = idleIntent();
    for (let k = 0; k < 30; k++) s.tick();
    expect(s.aimed).toBe(0);
  });

  it("throws a shotgun's pellets, each a round of its own", () => {
    const s = stand({ primary: 'm870', secondary: 'pm', fits: {}, tracer: 'off' });
    const before = s.rounds.count;
    s.intent = { ...idleIntent(), fire: true };
    s.tick();
    expect(s.rounds.count - before).toBe(9);
    expect(s.weapon.rounds).toBe(6);
  });

  it('puts the gun away for the shovel while F is held, and the shovel away after', () => {
    const s = stand(KITTED);
    s.intent = { ...idleIntent(), dig: true };
    for (let k = 0; k < 40; k++) s.tick();
    expect(s.held).toBe(SHOVEL_HELD);
    expect(s.gear().gun).toBeNull();
    s.intent = idleIntent();
    for (let k = 0; k < 40; k++) s.tick();
    expect(s.held).toBe(0);
    expect(s.gear().gun).toBe('m4');
  });
});
