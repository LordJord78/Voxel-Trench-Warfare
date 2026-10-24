import { describe, expect, it } from 'vitest';
import { barrageTunables, flashPower, flashTunables, planBarrage, type PlannedShell } from '../../src/battle/barrages';
import { Rng } from '../../src/core/rng';
import { loadTunables } from '../../src/core/tunables';

// Barrages beyond the map (the battle spec's §3): a run of 6–40 shells over 10–60 s, falling 1–8 km off
// along the front to either side and beyond the enemy's line; each shell a flash on the horizon, brightest
// as it lands and gone within its window.
const tun = loadTunables();
const bt = barrageTunables(tun);
const ft = flashTunables(tun);
const centre: [number, number] = [128, 128];
const plan = (seed: number, t0 = 100): PlannedShell[] => planBarrage(t0, centre, Rng.root(seed).derive('battle.barrages'), bt);
/** Degrees as yaw from the map's middle: 0 toward the enemy (+z), 90 along +x. */
const bearing = (s: PlannedShell) => (Math.atan2(s.x - centre[0], s.z - centre[1]) * 180) / Math.PI;
const distance = (s: PlannedShell) => Math.hypot(s.x - centre[0], s.z - centre[1]);

describe('barrages beyond the map', () => {
  it('a barrage is 6–40 shells over 10–60 s, 1–8 km out within 110° of toward the enemy', () => {
    // The box's own angle: 200 m across seen from 925 m.
    const box = (Math.atan(200 / 925) * 180) / Math.PI;
    for (let seed = 1; seed <= 200; seed++) {
      const shells = plan(seed);
      expect(shells.length).toBeGreaterThanOrEqual(6);
      expect(shells.length).toBeLessThanOrEqual(40);
      for (let k = 0; k < shells.length; k++) {
        const s = shells[k];
        expect(s.t).toBeGreaterThanOrEqual(100);
        expect(s.t).toBeLessThanOrEqual(160);
        if (k > 0) expect(s.t).toBeGreaterThanOrEqual(shells[k - 1].t);
        expect(distance(s)).toBeGreaterThanOrEqual(1000 - 75);
        expect(distance(s)).toBeLessThanOrEqual(Math.hypot(8000 + 75, 200));
        expect(Math.abs(bearing(s))).toBeLessThanOrEqual(110 + box);
        expect(s.power).toBeGreaterThanOrEqual(bt.power[0]);
        expect(s.power).toBeLessThanOrEqual(bt.power[1]);
      }
      expect(shells[shells.length - 1].t - shells[0].t).toBeLessThanOrEqual(60);
    }
    expect([bt.everyLightS, bt.everyHeavyS, bt.arcDeg, bt.widthM, bt.depthM]).toEqual([150, 20, 110, 400, 150]);
    expect([bt.distanceM, bt.shells, bt.durationS]).toEqual([[1000, 8000], [6, 40], [10, 60]]);
  });

  it('barrages fall on both flanks and beyond the enemy', () => {
    const firsts = Array.from({ length: 500 }, (_, k) => bearing(plan(1000 + k)[0]));
    const share = (keep: (b: number) => boolean) => firsts.filter(keep).length / firsts.length;
    expect(share((b) => b < -60)).toBeGreaterThanOrEqual(0.15);
    expect(share((b) => b > 60)).toBeGreaterThanOrEqual(0.15);
    expect(share((b) => Math.abs(b) < 30)).toBeGreaterThanOrEqual(0.15);
  });

  it('a flash is brightest as its shell lands, 1/e after decay_s, and gone after the window', () => {
    const shell = { t: 50, power: 1.2 };
    expect(flashPower(shell, 49.99, ft)).toBe(0);
    expect(flashPower(shell, 50, ft)).toBe(1.2);
    expect(flashPower(shell, 50 + ft.decayS, ft)).toBeCloseTo(1.2 / Math.E, 6);
    expect(flashPower(shell, 51.01, ft)).toBe(0);
    expect([ft.windowS, ft.decayS]).toEqual([1, 0.15]);
  });

  it('the same stream plans the same barrage', () => {
    expect(plan(7)).toEqual(plan(7));
    expect(plan(8)).not.toEqual(plan(7));
  });
});
