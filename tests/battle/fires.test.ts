import { describe, expect, it } from 'vitest';
import { fireChance, fireFlames, firePlume, fireStrength, fireTunables, hamletFireSites, type Fire } from '../../src/battle/fires';
import { Wind, windTunables } from '../../src/battle/wind';
import { Rng } from '../../src/core/rng';
import { loadTunables } from '../../src/core/tunables';
import { genParams } from '../../src/world/generation/params';
import { planWorld } from '../../src/world/generation/plan';
import { structureFootprints } from '../../src/world/generation/props';
import { P } from '../../src/world/materials';

// A fire (the battle spec's §5): it grows over 20 s, burns 2–6 minutes and dies down over a minute;
// timber, cloth and duckboards catch a third of the time, a hull a fifth; its flames rise and fade,
// its embers drift with the wind, its plume of six puffs leans with it; the hamlet's stand on its
// buildings' floors. A pure function of its start and the time.
const tun = loadTunables();
const ft = fireTunables(tun);
const wind = new Wind(windTunables(tun), Rng.root(7).derive('battle.wind'));
const fire = (over: Partial<Fire> = {}): Fire => ({ id: 3, at: [100, 16, 110], t0: 50, burnS: 180, size: 0.8, hamlet: false, ...over });

describe('a fire', () => {
  it('grows over 20 s, burns its 2–6 minutes and dies down over a minute', () => {
    const f = fire();
    expect(fireStrength(f, 49, ft)).toBe(0);
    expect(fireStrength(f, 50 + ft.growS / 2, ft)).toBeCloseTo(0.5, 9);
    expect(fireStrength(f, 50 + ft.growS + 100, ft)).toBe(1);
    const down = 50 + ft.growS + f.burnS;
    expect(fireStrength(f, down + ft.dieS / 2, ft)).toBeCloseTo(0.5, 9);
    expect(fireStrength(f, down + ft.dieS + 0.01, ft)).toBe(0);
    // Put out early: dying down from then.
    expect(fireStrength(fire({ out: 120 }), 120 + ft.dieS / 2, ft)).toBeCloseTo(0.5, 9);
    // The hamlet's burn on until put out.
    expect(fireStrength(fire({ hamlet: true }), 50 + 3600, ft)).toBe(1);
    expect([ft.growS, ft.burnS, ft.dieS]).toEqual([20, [120, 360], 60]);
  });

  it('timber, cloth and duckboards catch a third of the time, a hull a fifth, soil never', () => {
    for (const p of [P.TIMBER, P.TIMBER_DARK, P.CLOTH, P.DUCKBOARD]) expect(fireChance(p, ft)).toBeCloseTo(1 / 3, 3);
    expect(fireChance(P.HULL, ft)).toBeCloseTo(0.2, 9);
    for (const p of [P.SOD, P.MUD, P.SANDBAG, P.BRICK, P.CONCRETE, P.CORRUGATE]) expect(fireChance(p, ft)).toBe(0);
  });

  it('its flames rise and fade over their cycle, its embers drift with the wind', () => {
    const f = fire();
    const t = 50 + ft.growS + 30;
    const all = fireFlames(f, t, wind, ft);
    const flames = all.filter((q) => !q.ember);
    const embers = all.filter((q) => q.ember);
    expect(flames).toHaveLength(ft.flames);
    expect(embers).toHaveLength(ft.embers);
    for (const q of flames) {
      expect(q.centre[1]).toBeGreaterThanOrEqual(f.at[1] - 1e-9);
      expect(q.centre[1]).toBeLessThanOrEqual(f.at[1] + ft.flameRiseM * f.size + 1e-9);
      expect(Math.hypot(q.centre[0] - f.at[0], q.centre[2] - f.at[2])).toBeLessThan(1);
    }
    // A flame higher up is smaller and dimmer.
    const [low, high] = [...flames].sort((a, b) => a.centre[1] - b.centre[1]).filter((_, i, a) => i === 0 || i === a.length - 1);
    expect(high.sizeM).toBeLessThan(low.sizeM);
    expect(high.glow).toBeLessThan(low.glow);
    // An ember well up has been carried downwind.
    const up = embers.reduce((a, b) => (b.centre[1] > a.centre[1] ? b : a));
    const w = wind.at(t);
    expect((up.centre[0] - f.at[0]) * w[0] + (up.centre[2] - f.at[2]) * w[1]).toBeGreaterThan(0);
    // None before it starts, or once out.
    expect(fireFlames(f, 40, wind, ft)).toEqual([]);
    expect(fireFlames(f, 50 + ft.growS + f.burnS + ft.dieS + 1, wind, ft)).toEqual([]);
  });

  it('a fire put out while it grows only dies down from there', () => {
    const f = fire({ out: 55 });
    const atOut = fireStrength(f, 55, ft);
    expect(atOut).toBeGreaterThan(0);
    for (const t of [56, 60, 70, 80, 100]) expect(fireStrength(f, t, ft)).toBeLessThanOrEqual(atOut);
    expect(fireStrength(f, 55 + ft.dieS + 0.01, ft)).toBe(0);
  });

  it('its plume is six puffs rising and leaning with the wind, thinning with its strength', () => {
    const f = fire();
    const t = 50 + ft.growS + 30;
    const puffs = firePlume(f, t, wind, ft);
    expect(puffs).toHaveLength(6);
    for (let k = 1; k < 6; k++) expect(puffs[k].centre[1]).toBeGreaterThan(puffs[k - 1].centre[1]);
    const w = wind.at(t);
    const top = puffs[5];
    expect((top.centre[0] - f.at[0]) * w[0] + (top.centre[2] - f.at[2]) * w[1]).toBeGreaterThan(0);
    expect(top.radiusM).toBeGreaterThan(puffs[0].radiusM);
    const half = firePlume(f, 50 + ft.growS / 2, wind, ft);
    expect(half[0].density).toBeCloseTo(puffs[0].density / 2, 6);
    // Drawn too, covering by its strength.
    expect(puffs[0].alpha).toBeCloseTo(ft.plumeAlpha, 9);
    expect(half[0].alpha).toBeCloseTo(puffs[0].alpha / 2, 6);
  });

  it("the hamlet's fires stand on its buildings' floors, 2–4 of them", () => {
    const p = genParams(tun);
    const plan = planWorld(p, 7);
    const v = p.voxel;
    const buildings = structureFootprints(plan).filter((b) => b.kind === 'hamlet');
    for (let seed = 1; seed <= 20; seed++) {
      const sites = hamletFireSites(plan, Rng.root(seed).derive('battle.fires.hamlet'), ft);
      expect(sites.length).toBeGreaterThanOrEqual(2);
      expect(sites.length).toBeLessThanOrEqual(4);
      for (const s of sites) {
        const inside = buildings.find((b) => s[0] / v > b.x0 && s[0] / v < b.x1 && s[2] / v > b.z0 && s[2] / v < b.z1);
        expect(inside, JSON.stringify(s)).toBeDefined();
        expect(s[1] / v).toBeGreaterThan(inside!.underY!);
      }
      expect(new Set(sites.map((s) => buildings.findIndex((b) => s[0] / v > b.x0 && s[0] / v < b.x1 && s[2] / v > b.z0 && s[2] / v < b.z1))).size).toBe(sites.length);
    }
  });
});
