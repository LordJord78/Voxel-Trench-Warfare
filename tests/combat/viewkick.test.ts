import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { recoilProfile } from '../../src/combat/recoil';
import { ViewKick, viewKickProfile } from '../../src/combat/viewkick';
import { Rng } from '../../src/core/rng';
import { loadTunables } from '../../src/core/tunables';

// Ported from reference/python/tests/test_viewkick.py (its particle tests move to milestone 3's
// effects): the cosmetic layer, everything felt and nothing that moves the round.
const TICK = 1 / 60;
const tun = loadTunables();
const profile = viewKickProfile(tun, 'assault_rifle');
const rng = () => Rng.root(11).derive('viewkick');

describe('view kick', () => {
  it('no cosmetic magnitude is written in code', () => {
    const body = readFileSync('src/combat/viewkick.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*/g, '')
      .replace(/'[^']*'|`[^`]*`|"[^"]*"/g, '');
    const suspicious = (body.match(/(?<![\w.])\d+\.\d+/g) ?? []).filter((n) => !['1.0', '0.0', '2.0', '0.2'].includes(n));
    expect(suspicious).toEqual([]);
  });

  it('reads the rifle over the defaults', () => {
    expect(profile).toMatchObject({ punchBackM: 0.034, punchPitchDeg: 1.25, punchRollDeg: 0.55, damping: 0.82, fovPulseDeg: -0.6, settleS: 0.22, aimPitchFollow: 0.9, jitterScale: 0.12 });
  });

  it('the viewmodel is at its peak on the shot tick', () => {
    const k = new ViewKick(profile);
    k.shot(0.34, rng());
    const atShot = Math.abs(k.back);
    for (let t = 0; t < 120; t++) {
      k.tick(TICK);
      expect(Math.abs(k.back)).toBeLessThanOrEqual(atShot);
    }
  });

  it('the viewmodel overshoots on the way back', () => {
    expect(profile.damping).toBeLessThan(1);
    const k = new ViewKick(profile);
    k.shot(0.34, rng());
    let dipped = false;
    for (let t = 0; t < 60; t++) {
      k.tick(TICK);
      if (k.back < 0) dipped = true;
    }
    expect(dipped).toBe(true);
  });

  it('both layers settle together', () => {
    expect(Math.abs(profile.settleS - recoilProfile(tun, 'assault_rifle').settleS)).toBeLessThanOrEqual(0.08);
  });

  it('the viewmodel moves further than the sight picture', () => {
    expect(profile.punchPitchDeg).toBeGreaterThan(2 * recoilProfile(tun, 'assault_rifle').kickPitchDeg);
  });

  it('the two layers are driven by one event: a bigger aim kick, more pitch', () => {
    expect(profile.aimPitchFollow).toBeGreaterThan(0);
    const small = new ViewKick(profile);
    const big = new ViewKick(profile);
    small.shot(0.1, rng());
    big.shot(1.0, rng());
    expect(big.pitch).toBeGreaterThan(small.pitch);
  });

  it('the FOV pulses in and settles', () => {
    const k = new ViewKick(profile);
    k.shot(0.34, rng());
    expect(k.fovOffset).toBeCloseTo(-0.6, 12);
    for (let t = 0; t < Math.round(0.3 / TICK); t++) k.tick(TICK);
    expect(Math.abs(k.fovOffset)).toBeLessThan(0.006);
  });
});
