import { describe, expect, it } from 'vitest';
import { columnPuffs, farShellTunables, planFarShell } from '../../src/battle/far-shells';
import { Wind, windTunables } from '../../src/battle/wind';
import { Rng } from '../../src/core/rng';
import { loadTunables } from '../../src/core/tunables';

// Shells into the far field (the battle spec's §3): 200–800 m from the map's middle, beyond its edge;
// each throws up a column of smoke that rises, leans with the wind and thins away over a minute.
const tun = loadTunables();
const ft = farShellTunables(tun);
const wind = new Wind(windTunables(tun), Rng.root(7).derive('battle.wind'));
const centre: [number, number] = [128, 128];
const shell = { t: 100, position: [500, 18, 700] };

describe('shells into the far field', () => {
  it("a far shell falls 200–800 m from the map's middle, within 110° of toward the enemy", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const s = planFarShell(40, centre, Rng.root(seed).derive('battle.far'), ft);
      const d = Math.hypot(s.x - centre[0], s.z - centre[1]);
      expect(d).toBeGreaterThanOrEqual(200);
      expect(d).toBeLessThanOrEqual(800);
      expect(Math.abs((Math.atan2(s.x - centre[0], s.z - centre[1]) * 180) / Math.PI)).toBeLessThanOrEqual(110);
      expect(s.t).toBe(40);
      expect(s.power).toBeGreaterThanOrEqual(ft.power[0]);
      expect(s.power).toBeLessThanOrEqual(ft.power[1]);
      // Beyond the map, whose corners are 181 m from its middle.
      expect(s.x < 0 || s.x > 256 || s.z < 0 || s.z > 256).toBe(true);
    }
    expect([ft.everyLightS, ft.everyHeavyS, ft.arcDeg, ft.smokeS, ft.puffs, ft.puffEveryS, ft.riseMps, ft.riseS]).toEqual([30, 5, 110, 60, 8, 0.5, 6, 8]);
  });

  it('its column stands from the crater up, leans downwind, grows and thins over a minute', () => {
    const now = 120;
    const puffs = columnPuffs(shell, now, wind, ft);
    expect(puffs).toHaveLength(8);
    const top = ft.riseMps * ft.riseS;
    for (let k = 0; k < puffs.length; k++) {
      // Puff k rises to (1 − k/8) of the column's height, and is carried as much of the wind's drift
      // since it was let out: the base stays at the crater, the top leans downwind.
      const share = 1 - k / ft.puffs;
      const release = shell.t + k * ft.puffEveryS;
      const drift = wind.drift(release, now);
      expect(puffs[k].centre[0] - shell.position[0]).toBeCloseTo(drift[0] * share, 6);
      expect(puffs[k].centre[2] - shell.position[2]).toBeCloseTo(drift[1] * share, 6);
      expect(puffs[k].centre[1] - shell.position[1]).toBeCloseTo(top * share * (1 - Math.exp(-(now - release) / ft.riseS)), 6);
      // The first let out is the highest, and the biggest.
      if (k > 0) {
        expect(puffs[k].centre[1]).toBeLessThan(puffs[k - 1].centre[1]);
        expect(puffs[k].radiusM).toBeLessThan(puffs[k - 1].radiusM);
      }
    }
    const later = columnPuffs(shell, 140, wind, ft);
    expect(later[0].radiusM).toBeGreaterThan(puffs[0].radiusM);
    expect(later[0].alpha).toBeLessThan(puffs[0].alpha);
    expect(columnPuffs(shell, shell.t + ft.smokeS, wind, ft)).toEqual([]);
  });

  it('a puff is out only once let out', () => {
    expect(columnPuffs(shell, shell.t + 0.2, wind, ft)).toHaveLength(1);
    expect(columnPuffs(shell, shell.t - 0.1, wind, ft)).toEqual([]);
  });
});
