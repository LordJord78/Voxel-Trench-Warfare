import { describe, expect, it } from 'vitest';
import { planShot, tracerAt, tracerTunables, type Shot } from '../../src/battle/tracers';
import { Rng } from '../../src/core/rng';
import { loadTunables } from '../../src/core/tunables';

// A tracer's flight (the battle spec's §4): fired along its line, slowed by drag and dropped by
// gravity; ended where it first goes under the ground; one in six ricocheting up from there, slower,
// at a random bearing; burnt out after burn_s whatever it does. A pure function of its shot and time.
const tun = loadTunables();
const tt = tracerTunables(tun);
const rad = Math.PI / 180;
const muzzle: [number, number, number] = [100, 20, 100];
const level = (bearingDeg: number, upDeg: number): [number, number, number] => [Math.sin(bearingDeg * rad) * Math.cos(upDeg * rad), Math.sin(upDeg * rad), Math.cos(bearingDeg * rad) * Math.cos(upDeg * rad)];
const shoot = (dir: [number, number, number], ground: (x: number, z: number) => number, seed = 1, t0 = 10): Shot => planShot(1, muzzle, dir, t0, ground, Rng.root(seed).derive('battle.guns'), tt);

describe("a tracer's flight", () => {
  it('flies its line of fire slowed by drag, and drops under gravity', () => {
    const dir = level(30, 2);
    const shot = shoot(dir, () => -1e9);
    const at = tracerAt(shot, 11, tt)!;
    const along = Math.log(1 + tt.k * tt.muzzleMps) / tt.k;
    for (const c of [0, 2]) expect(at.position[c]).toBeCloseTo(muzzle[c] + dir[c] * along, 6);
    expect(at.position[1]).toBeCloseTo(muzzle[1] + dir[1] * along - tt.gravity / 2, 6);
    const speedAlong = tt.muzzleMps / (1 + tt.k * tt.muzzleMps);
    expect(at.velocity[0]).toBeCloseTo(dir[0] * speedAlong, 6);
    expect(at.velocity[1]).toBeCloseTo(dir[1] * speedAlong - tt.gravity, 6);
    expect(at.flown).toBeCloseTo(along, 6);
    expect(tracerAt(shot, 9.99, tt)).toBeNull();
  });

  it('ends where it first goes under the ground', () => {
    const ground = () => muzzle[1] - 2;
    const shot = shoot(level(0, 0), ground);
    const leg = shot.legs[0];
    // Level, it drops 2 m in sqrt(4/g) s.
    expect(leg.t1 - leg.t0).toBeCloseTo(Math.sqrt(4 / tt.gravity), 1);
    const end = tracerAt(shot, leg.t1 - 1e-6, tt)!;
    expect(Math.abs(end.position[1] - ground())).toBeLessThan(0.2);
    if (shot.legs.length === 1) expect(tracerAt(shot, leg.t1 + 0.01, tt)).toBeNull();
  });

  it('one in six ricochets: it climbs from where it struck, slower, at a random bearing', () => {
    const ground = () => muzzle[1] - 5;
    let ricochets = 0;
    const quarters = new Set<number>();
    for (let seed = 1; seed <= 600; seed++) {
      const shot = shoot(level(seed * 7, -10), ground, seed);
      if (shot.legs.length < 2) continue;
      ricochets++;
      const [first, second] = shot.legs;
      const strike = tracerAt(shot, first.t1 - 1e-9, tt)!;
      for (let c = 0; c < 3; c++) expect(second.from[c]).toBeCloseTo(strike.position[c], 3);
      const climb = Math.asin(second.dir[1]) / rad;
      expect(climb).toBeGreaterThanOrEqual(tt.ricochetUpDeg[0] - 1e-9);
      expect(climb).toBeLessThanOrEqual(tt.ricochetUpDeg[1] + 1e-9);
      expect(second.v0).toBeCloseTo(tt.ricochetSpeed * Math.hypot(...strike.velocity), 3);
      expect(second.t0).toBeCloseTo(first.t1, 9);
      quarters.add(Math.floor(((Math.atan2(second.dir[0], second.dir[2]) / rad + 360) % 360) / 90));
    }
    expect(ricochets / 600).toBeGreaterThan(1 / 6 - 0.05);
    expect(ricochets / 600).toBeLessThan(1 / 6 + 0.05);
    expect(quarters.size).toBe(4);
  });

  it('burns out after burn_s however it flies', () => {
    const shot = shoot(level(0, 45), () => -1e9);
    expect(tracerAt(shot, 10 + tt.burnS - 0.01, tt)).not.toBeNull();
    expect(tracerAt(shot, 10 + tt.burnS + 0.01, tt)).toBeNull();
    expect(tt.burnS).toBe(3);
  });

  it('a shot that can no longer come down to the field is not marched further, and plans the same', () => {
    // Over a field no higher than 16 m, fired 8° up from 20 m: it never comes down within its burn.
    let asked = 0;
    const field = () => {
      asked++;
      return 16;
    };
    const high = planShot(1, muzzle, level(30, 8), 10, field, Rng.root(3).derive('battle.guns'), tt, 16);
    expect(asked).toBeLessThanOrEqual(2);
    expect(high).toEqual(planShot(1, muzzle, level(30, 8), 10, () => 16, Rng.root(3).derive('battle.guns'), tt));
    // Over rolling ground, with and without the field's top: the same flights, struck or not.
    const rolling = (x: number, z: number) => 15 + 2 * Math.sin(x / 7) * Math.cos(z / 11);
    for (let k = 0; k < 200; k++) {
      const dir = level(k * 13, -3 + (k % 12));
      expect(planShot(k, muzzle, dir, 10, rolling, Rng.root(k).derive('battle.guns'), tt, 17)).toEqual(planShot(k, muzzle, dir, 10, rolling, Rng.root(k).derive('battle.guns'), tt));
    }
  });

  it('the same stream plans the same shot', () => {
    const ground = () => muzzle[1] - 5;
    expect(shoot(level(20, -10), ground, 4)).toEqual(shoot(level(20, -10), ground, 4));
  });
});
