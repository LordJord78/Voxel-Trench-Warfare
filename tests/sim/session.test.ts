import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../src/core/tunables';
import { Stance, type MoveIntent } from '../../src/physics/character';
import { Session } from '../../src/sim/session';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';

const tun = loadTunables();
const ground = () => {
  const map = new BrickMap({ x: 64, y: 64, z: 64 });
  map.fillBox(0, 0, 0, 64, 20, 64, P.SOD);
  return map;
};
const walk: MoveIntent = { forward: 1, strafe: 0, jump: false, sprint: false, stance: Stance.STANDING, periscope: false };
const create = () => Session.create({ map: ground(), plan: null, spawn: { position: [3.2, 2.5, 1.0] } }, tun, 7);

describe('the session', () => {
  it('settles the player onto the ground from a spawn above it', () => {
    const s = create();
    for (let t = 0; t < 60; t++) s.tick();
    expect(s.player.onGround).toBe(true);
    expect(s.player.position.y).toBeCloseTo(2.0, 9);
  });

  it('runs whole 60 Hz ticks and interpolates between the last two', () => {
    const s = create();
    s.intent = walk;
    expect(s.advance(1 / 30)).toBe(2);
    expect(s.advance(0.004)).toBe(0);
    expect(s.clock.alpha).toBeCloseTo(0.24, 9);
    const half = s.footAt(0.5);
    const mid = s.prevPosition.lerp(s.player.position, 0.5);
    expect(half.toArray()).toEqual(mid.toArray());
    expect(s.player.position.z).toBeGreaterThan(s.prevPosition.z);
  });

  it('ends in the same place at 30, 120 and 144 frames a second', () => {
    const ends = [1 / 30, 1 / 120, 1 / 144].map((interval) => {
      const s = create();
      s.intent = walk;
      while (s.clock.tick < 120) s.advance(interval);
      expect(s.clock.tick).toBe(120);
      return s.player.position.toArray();
    });
    for (const end of ends.slice(1)) expect(end).toEqual(ends[0]);
  });

  it('runs no more than its catch-up after a five-second gap, and keeps the player on the ground', () => {
    const s = create();
    for (let t = 0; t < 60; t++) s.tick();
    s.intent = walk;
    expect(s.advance(5)).toBeLessThanOrEqual(s.clock.maxSubsteps);
    expect(s.player.onGround).toBe(true);
    expect(s.player.position.y).toBeCloseTo(2.0, 9);
  });

  it('gives the same states for the same seed and intents', () => {
    const run = () => {
      const s = create();
      const states: unknown[] = [];
      for (let t = 0; t < 90; t++) {
        s.intent = t < 45 ? walk : { ...walk, forward: 0, strafe: 1 };
        s.player.yaw = t;
        s.tick();
        states.push(JSON.stringify(s.player));
      }
      return states;
    };
    expect(run()).toEqual(run());
  });

  it('teleports to a standing, still player, and interpolates from there', () => {
    const s = create();
    s.intent = walk;
    for (let t = 0; t < 30; t++) s.tick();
    s.teleport([4.0, 2.0, 4.0], 90, -5);
    expect(s.player.velocity.toArray()).toEqual([0, 0, 0]);
    expect([s.player.yaw, s.player.pitch, s.player.stance]).toEqual([90, -5, Stance.STANDING]);
    expect(s.footAt(0.3).toArray()).toEqual([4.0, 2.0, 4.0]);
  });
});
