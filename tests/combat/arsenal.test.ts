import { describe, expect, it } from 'vitest';
import { aimedMoa, armSpec, cleanLoadout, defaultLoadout, fitOf, GUN_DEFS, gunStats, PRIMARY_GUNS, SECONDARY_GUNS } from '../../src/combat/arsenal';
import { gunModel, MODEL_VOXELS_MAX, shovelModel } from '../../src/combat/gun-models';
import { rifleModel, type RifleModel } from '../../src/combat/rifle-model';
import { loadTunables, Tunables } from '../../src/core/tunables';
import { BARE, DAMAGE_SCALE, GUNS, SHOT_SHARES, shareStep, type Fit, type GunKey } from '../../src/net/gear';

// The loadout's guns (combat/arsenal.ts) and their voxels (combat/gun-models.ts).
const tun = loadTunables();

/** Every fit `gun` takes. */
function fits(gun: GunKey): Fit[] {
  const f = GUN_DEFS[gun].fits;
  return f.optic.flatMap((optic) => f.muzzle.flatMap((muzzle) => f.under.flatMap((under) => f.side.map((side) => ({ optic, muzzle, under, side })))));
}

/** The palette id at a point in a model's metres, 0 outside its grid. */
function at(m: RifleModel, p: readonly number[]): number {
  const c = [0, 1, 2].map((k) => Math.floor(p[k] / m.voxelM + m.origin[k]));
  if (c.some((v, k) => v < 0 || v >= m.dims[k])) return 0;
  return m.voxels[c[0] + m.dims[0] * (c[1] + m.dims[1] * c[2])];
}

describe('the arsenal', () => {
  it('has long guns and pistols, the M4 among them', () => {
    expect(PRIMARY_GUNS).toContain('m4');
    expect(PRIMARY_GUNS.length).toBeGreaterThanOrEqual(5);
    expect(SECONDARY_GUNS.length).toBeGreaterThanOrEqual(2);
    expect([...PRIMARY_GUNS, ...SECONDARY_GUNS].sort()).toEqual([...GUNS].sort());
  });

  it('makes every gun with every fit it takes, small enough for the renderers and their walk', () => {
    for (const gun of GUNS) {
      for (const fit of fits(gun)) {
        const m = gunModel(gun, fit);
        expect(m.voxels.length, `${gun} ${JSON.stringify(fit)}`).toBeLessThanOrEqual(MODEL_VOXELS_MAX);
        // rifle.wgsl walks at most 160 voxels, soldiers.wgsl 160: a grid's three sides together less.
        expect(m.dims[0] + m.dims[1] + m.dims[2]).toBeLessThan(160);
        // Its muzzle is at its front, on the bore.
        expect(m.muzzle[2]).toBeGreaterThan(0.1);
        expect(at(m, [0, 0, m.muzzle[2] - 0.0075])).not.toBe(0);
      }
    }
    expect(shovelModel().voxels.length).toBeLessThanOrEqual(MODEL_VOXELS_MAX);
  });

  it("makes the bare AK as rifle-model.ts does, voxel for voxel", () => {
    const old = rifleModel();
    const made = gunModel('ak74', BARE);
    const v = old.voxelM;
    for (let k = 0; k < old.dims[2]; k++) {
      for (let j = 0; j < old.dims[1]; j++) {
        for (let i = 0; i < old.dims[0]; i++) {
          const p = [(i + 0.5 - old.origin[0]) * v, (j + 0.5 - old.origin[1]) * v, (k + 0.5 - old.origin[2]) * v];
          expect(at(made, p), p.map((x) => x.toFixed(4)).join()).toBe(old.voxels[i + old.dims[0] * (j + old.dims[1] * k)]);
        }
      }
    }
  });

  it("puts each optic's window on its sight line, open through", () => {
    for (const gun of GUNS) {
      for (const optic of GUN_DEFS[gun].fits.optic) {
        if (optic === 'iron' || optic === 'scope') continue;
        const fit = { ...BARE, optic };
        const m = gunModel(gun, fit);
        const spec = armSpec(tun, gun, fit);
        // Along the sight's line through the optic's middle: nothing in the way.
        expect(at(m, [0, spec.sight.y, GUN_DEFS[gun].mounts.opticZ]), `${gun} ${optic}`).toBe(0);
      }
    }
  });

  it("is each gun's own numbers bare, and its fit's terms with attachments", () => {
    const bare = armSpec(tun, 'm4', BARE);
    expect([bare.hipSpread, bare.flash, bare.report, bare.move]).toEqual([1, 1, 1, 1]);
    // Iron sights magnify a little, aimed ([attachment.iron]).
    expect(bare.zoom).toBeCloseTo(tun.f('attachment.iron.zoom'), 12);
    expect(bare.weapon.rpm).toBe(800);
    expect(bare.suppressed).toBe(false);
    const kitted = armSpec(tun, 'm4', { optic: 'reddot', muzzle: 'suppressor', under: 'vertical', side: 'laser' });
    expect(kitted.suppressed).toBe(true);
    expect(kitted.flash).toBeLessThan(0.5);
    expect(kitted.zoom).toBeGreaterThan(1);
    expect(kitted.recoil.climbPerShotDeg).toBeLessThan(bare.recoil.climbPerShotDeg);
    expect(kitted.hipSpread * kitted.laserSpread).toBeLessThan(1);
    expect(kitted.muzzle[2]).toBeGreaterThan(bare.muzzle[2]);
    expect(bare.weapon.tracerEvery).toBe(1);
    expect(armSpec(tun, 'm870', BARE).weapon.pellets).toBe(9);
  });

  it("gives a shotgun's aimed figure as its pattern: the gun's cone times its aimed share's step, as the session throws it", () => {
    // A bullet's: its cone times its share aimed. A pellet gun's: the pattern its pellets fly about the
    // aim, standing and aimed, the share put to the step its shot's word carries (net/gear.ts).
    for (const gun of GUNS) {
      for (const optic of GUN_DEFS[gun].fits.optic) {
        const a = armSpec(tun, gun, { ...BARE, optic });
        const share = a.weapon.pellets > 1 ? SHOT_SHARES[shareStep(a.adsSpread)] : a.adsSpread;
        expect(aimedMoa(a), `${gun} ${optic}`).toBeCloseTo(a.weapon.dispersionMoa * share, 12);
      }
    }
    // The M870's 160 MOA aimed through its irons (0.8), the holo or the red dot (0.72, 0.736): 0.7.
    for (const optic of GUN_DEFS.m870.fits.optic) expect(aimedMoa(armSpec(tun, 'm870', { ...BARE, optic })), optic).toBeCloseTo(112, 9);
    expect(aimedMoa(armSpec(tun, 'm4', BARE))).toBeCloseTo(3.0 * 0.38, 12);
    // No bar moves. The old figure (a quarter of 160 × 0.8, 32 MOA) was four times the bar's 8 MOA span
    // and the pattern's 112 is further past: the shotgun's accuracy was at the floor and stays there.
    // The rifles' and pistols' figures are as they were.
    for (const optic of GUN_DEFS.m870.fits.optic) expect(gunStats(tun, armSpec(tun, 'm870', { ...BARE, optic }), DAMAGE_SCALE.m870).accuracy).toBe(0.04);
    const accuracy = (gun: GunKey) => gunStats(tun, armSpec(tun, gun, BARE), DAMAGE_SCALE[gun]).accuracy;
    expect(GUNS.map((g) => accuracy(g).toFixed(4))).toEqual(GUNS.map((g) => Math.max(0.04, Math.min(1, 1 - (g === 'm870' ? 32 : armSpec(tun, g, BARE).weapon.dispersionMoa * armSpec(tun, g, BARE).adsSpread) / 8)).toFixed(4)));
  });

  it("keeps the loadout's control bars where they stood before the heavier recoil: each within 0.03, their spread kept", () => {
    // Recoil control is 1 − (kick + 2 × climb per shot) / [loadout] control_span, from the gun's own
    // [recoil.*] table, held to 0.04–1. The shots spec's §3 raised every gun's kick + 2 × climb about
    // 1.24 times, and the span with it (4.5 to 5.6): the bars compare the guns, and the heavier table
    // is felt, not shown. Each bar as it stood, over the table before §3 (kick, climb per shot) and 4.5:
    const before: Record<GunKey, [number, number]> = {
      ak74: [0.34, 0.27], m4: [0.3, 0.22], mp5: [0.18, 0.13], svd: [1.6, 0.9],
      m249: [0.32, 0.17], m870: [3.0, 1.5], m17: [0.9, 0.55], pm: [1.05, 0.6],
    };
    const was = (gun: GunKey) => Math.max(0.04, Math.min(1, 1 - (before[gun][0] + 2 * before[gun][1]) / 4.5));
    const control = (gun: GunKey, t = tun) => gunStats(t, armSpec(t, gun, BARE), DAMAGE_SCALE[gun]).control;
    // The AK's 0.804, the M4's 0.836, the MP5's 0.902, the SVD's 0.244, the M249's 0.853, the M870 at
    // the floor, the M17's 0.556 and the PM's 0.500.
    expect(GUNS.map((g) => was(g).toFixed(3))).toEqual(['0.804', '0.836', '0.902', '0.244', '0.853', '0.040', '0.556', '0.500']);
    expect(tun.f('loadout.control_span')).toBe(5.6);
    for (const gun of GUNS) expect(Math.abs(control(gun) - was(gun)), gun).toBeLessThanOrEqual(0.03);
    // In the same order, the shotgun's at the floor and the SVD's well clear of it.
    const order = (f: (g: GunKey) => number) => [...GUNS].sort((a, b) => f(a) - f(b));
    expect(order(control)).toEqual(order(was));
    expect(control('m870')).toBe(0.04);
    expect(control('svd')).toBeGreaterThan(0.2);
    // The span is the tunable's: at the old 4.5 every bar off the floor drops, the SVD's nearly to it.
    const raw = tun.raw();
    (raw.loadout as Record<string, unknown>).control_span = 4.5;
    const old = new Tunables(raw);
    for (const gun of GUNS) if (gun !== 'm870') expect(control(gun, old), gun).toBeLessThan(control(gun) - 0.02);
    expect(control('svd', old)).toBeLessThan(0.1);
  });

  it("every bar of every gun's loadout card stands where it did, each against its [loadout] span", () => {
    // The bars as they stood with their spans written into gunStats: each gun bare, and with each muzzle it takes.
    const old = (gun: GunKey, fit = BARE) => {
      const a = armSpec(tun, gun, fit);
      const w = a.weapon;
      const clamp = (v: number) => Math.max(0.04, Math.min(1, v));
      return {
        damage: clamp((DAMAGE_SCALE[gun] * w.pellets) / 2.2),
        rate: clamp(w.rpm / 900),
        accuracy: clamp(1 - aimedMoa(a) / 8),
        control: clamp(1 - (a.recoil.kickPitchDeg + a.recoil.climbPerShotDeg * 2) / 5.6),
        range: clamp(w.projectile.muzzleVelocity / 950),
        handling: clamp(1 - (a.adsTimeS - 0.1) / 0.45 - (w.reloadS - 1.5) / 12),
        mobility: clamp((a.move - 0.75) / 0.35),
      };
    };
    for (const gun of GUNS) {
      for (const muzzle of GUN_DEFS[gun].fits.muzzle) {
        const fit = { ...BARE, muzzle };
        expect(gunStats(tun, armSpec(tun, gun, fit), DAMAGE_SCALE[gun]), `${gun} ${muzzle}`).toEqual(old(gun, fit));
      }
    }
    // Each span, and the bars' floor, is the tunable's.
    const spans: Record<string, number> = {
      bar_floor: 0.04, damage_span: 2.2, rate_span_rpm: 900, accuracy_span_moa: 8, control_span: 5.6, range_span_mps: 950,
      handling_ads_from_s: 0.1, handling_ads_span_s: 0.45, handling_reload_from_s: 1.5, handling_reload_span_s: 12, mobility_from: 0.75, mobility_span: 0.35,
    };
    expect(tun.section('loadout')).toEqual(spans);
    const bars = (key: string, value: number, gun: GunKey = 'm4') => {
      const raw = tun.raw();
      (raw.loadout as Record<string, unknown>)[key] = value;
      const t2 = new Tunables(raw);
      return gunStats(t2, armSpec(t2, gun, BARE), DAMAGE_SCALE[gun]);
    };
    const m4 = gunStats(tun, armSpec(tun, 'm4', BARE), DAMAGE_SCALE.m4);
    expect(bars('damage_span', 4.4).damage).toBeCloseTo(m4.damage / 2, 12);
    expect(bars('rate_span_rpm', 1800).rate).toBeCloseTo(m4.rate / 2, 12);
    expect(bars('range_span_mps', 1900).range).toBeCloseTo(m4.range / 2, 12);
    expect(bars('accuracy_span_moa', 4).accuracy).toBeLessThan(m4.accuracy);
    expect(bars('handling_ads_span_s', 0.2).handling).toBeLessThan(m4.handling);
    expect(bars('handling_ads_from_s', 0.2).handling).toBeGreaterThan(m4.handling);
    expect(bars('handling_reload_span_s', 4).handling).not.toBeCloseTo(m4.handling, 6);
    expect(bars('handling_reload_from_s', 3).handling).toBeGreaterThan(m4.handling);
    expect(bars('mobility_span', 0.7).mobility).toBeCloseTo(m4.mobility / 2, 12);
    expect(bars('mobility_from', 0.8).mobility).toBeLessThan(m4.mobility);
    expect(bars('bar_floor', 0.1, 'm870').control).toBe(0.1);
  });

  it('cleans a loadout: anything not one is the default, a fit only what its gun takes', () => {
    expect(cleanLoadout(null)).toEqual(defaultLoadout());
    expect(defaultLoadout()).toEqual({ primary: 'ak74', secondary: 'm17', fits: {} });
    expect(cleanLoadout({ primary: 'm17', secondary: 'svd' })).toEqual(defaultLoadout());
    const l = cleanLoadout({ primary: 'svd', secondary: 'pm', fits: { svd: { optic: 'holo', muzzle: 'suppressor', under: 'vertical' } } });
    expect(l.primary).toBe('svd');
    // A stored tracer choice from before is ignored.
    const fits = { svd: { optic: 'holo', muzzle: 'suppressor', under: 'vertical' } };
    expect(cleanLoadout({ primary: 'svd', secondary: 'pm', tracer: 'green', fits })).toEqual(cleanLoadout({ primary: 'svd', secondary: 'pm', fits }));
    expect('tracer' in cleanLoadout({ tracer: 'red' })).toBe(false);
    expect(fitOf(l, 'svd')).toEqual({ optic: 'scope', muzzle: 'suppressor', under: 'none', side: 'none' });
  });
});
