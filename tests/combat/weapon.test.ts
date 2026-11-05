import { describe, expect, it } from 'vitest';
import { GUN_DEFS } from '../../src/combat/arsenal';
import type { GunKey } from '../../src/net/gear';
import { Weapon, weaponSpec, type WeaponSpec } from '../../src/combat/weapon';
import { Rng } from '../../src/core/rng';
import { loadTunables } from '../../src/core/tunables';

const TICK = 1 / 60;
const tun = loadTunables();
const RIFLE = weaponSpec(tun, 'assault_rifle');

/** Tick a weapon with the trigger as `held(tick)` says, firing whenever it wants: the ticks that fired. */
function run(w: Weapon, ticks: number, held: (k: number) => boolean): number[] {
  const fired: number[] = [];
  for (let k = 0; k < ticks; k++) {
    w.tick(TICK);
    if (w.wants(held(k))) {
      w.shot();
      fired.push(k);
    }
  }
  return fired;
}

describe('the rifle', () => {
  it('reads the reference rifle from its tables', () => {
    expect(RIFLE).toMatchObject({ key: 'assault_rifle', name: '5.45 assault rifle', rpm: 650, magazine: 30, dispersionMoa: 3.2, reloadS: 2.4, automatic: true, tracerEvery: 1 });
    expect(RIFLE.projectile.muzzleVelocity).toBe(880);
  });

  it('a held trigger fires 650 a minute, 5 and 6 ticks apart in turn', () => {
    const fired = run(new Weapon({ ...RIFLE, magazine: 1000 }), 600, () => true);
    expect(Math.abs(fired.length - 108)).toBeLessThanOrEqual(1);
    const gaps = new Set(fired.slice(1).map((k, i) => k - fired[i]));
    expect([...gaps].sort()).toEqual([5, 6]);
  });

  it('a fresh pull fires at once, with no catch-up after a rest', () => {
    const fired = run(new Weapon(RIFLE), 140, (k) => k >= 120);
    expect(fired[0]).toBe(120);
    expect([5, 6]).toContain(fired[1] - fired[0]);
  });

  it('the magazine empties and stays empty until reloaded', () => {
    const w = new Weapon(RIFLE);
    const fired = run(w, 600, () => true);
    expect(fired).toHaveLength(30);
    expect(w.rounds).toBe(0);
    w.tick(TICK);
    expect(w.wants(true)).toBe(false);
  });

  it('a reload takes 2.4 s and refills, and nothing fires while it runs', () => {
    const w = new Weapon(RIFLE);
    run(w, 400, () => true);
    expect(w.beginReload()).toBe(true);
    expect(w.reloading).toBe(true);
    expect(run(w, 143, () => true)).toEqual([]);
    expect(w.reloading).toBe(true);
    for (let k = 0; k < 2; k++) w.tick(TICK);
    expect(w.reloading).toBe(false);
    expect(w.rounds).toBe(30);
  });

  it('R while full or reloading is refused, and loses no round', () => {
    const w = new Weapon(RIFLE);
    expect(w.beginReload()).toBe(false);
    expect(w.rounds).toBe(30);
    run(w, 25, () => true);
    const left = w.rounds;
    expect(w.beginReload()).toBe(true);
    expect(w.beginReload()).toBe(false);
    expect(w.rounds).toBe(left);
  });

  it('the trigger held through a reload fires when it ends; semi-automatic needs a new press', () => {
    for (const automatic of [true, false]) {
      const w = new Weapon({ ...RIFLE, automatic });
      // Empty it: automatic by holding, semi-automatic by pressing every 8 ticks.
      run(w, 400, (k) => automatic || k % 8 < 4);
      expect(w.rounds).toBe(0);
      w.beginReload();
      const after = run(w, 150, () => true);
      // The reload ends in its 144th tick (2.4 s), and a held trigger fires in it.
      if (automatic) expect(after[0]).toBe(143);
      else {
        expect(after).toEqual([]);
        expect(run(w, 2, (k) => k === 1)).toEqual([1]);
      }
    }
  });

  it('semi-automatic fires once per press', () => {
    const w = new Weapon({ ...RIFLE, automatic: false });
    expect(run(w, 60, () => true)).toHaveLength(1);
    expect(run(w, 20, (k) => k >= 10)).toEqual([10]);
  });

  it('dispersion is a cone, not a square', () => {
    const w = new Weapon(RIFLE);
    const rng = Rng.root(7).derive('combat.dispersion');
    const limit = 3.2 / 60;
    const offsets: number[] = [];
    for (let k = 0; k < 2000; k++) {
      const [x, y, z] = w.aim(0, 0, 1, rng);
      const yaw = (Math.atan2(x, z) * 180) / Math.PI;
      const pitch = (Math.asin(y) * 180) / Math.PI;
      offsets.push(Math.hypot(yaw, pitch));
    }
    offsets.sort((a, b) => a - b);
    expect(offsets[offsets.length - 1]).toBeLessThanOrEqual(1.45 * limit);
    expect(Math.abs(offsets[1000] / (0.707 * limit) - 1)).toBeLessThanOrEqual(0.15);
  });

  it('the same seed puts the same burst on the same aims, and another seed elsewhere', () => {
    const burst = (seed: number) => {
      const w = new Weapon(RIFLE);
      const rng = Rng.root(seed).derive('combat.dispersion');
      return Array.from({ length: 12 }, () => w.aim(10, -2, 1, rng));
    };
    expect(burst(5)).toEqual(burst(5));
    expect(burst(6)).not.toEqual(burst(5));
  });

  it('the shotgun reloads 1 shell in 1.0 s and 7 in 4.0 s', () => {
    // Shell by shell ([weapon.m870] reload_base_s 0.5, then reload_per_round_s 0.5 a shell missing),
    // but the tube fills only at the end, as every gun's magazine does: no shell is kept early.
    const M870 = weaponSpec(tun, 'm870');
    expect(M870).toMatchObject({ magazine: 7, reloadS: 4, reloadBaseS: 0.5, reloadPerRoundS: 0.5 });
    const takes = (missing: number) => {
      const w = new Weapon(M870);
      w.rounds = M870.magazine - missing;
      expect(w.beginReload()).toBe(true);
      expect(w.reloadShells).toBe(missing);
      let ticks = 0;
      while (w.reloading) {
        expect(w.rounds).toBe(M870.magazine - missing);
        w.tick(TICK);
        ticks++;
      }
      expect(w.rounds).toBe(M870.magazine);
      return ticks;
    };
    expect(takes(1)).toBe(60);
    expect(takes(4)).toBe(150);
    expect(takes(7)).toBe(240);
    // Every other gun reloads a magazine at a time: its reload_time_s, however many are missing.
    expect(RIFLE).toMatchObject({ reloadBaseS: 0, reloadPerRoundS: 0 });
    for (const missing of [1, 30]) {
      const w = new Weapon(RIFLE);
      w.rounds = 30 - missing;
      w.beginReload();
      let ticks = 0;
      for (; w.reloading; ticks++) w.tick(TICK);
      expect(ticks).toBe(144);
    }
  });

  it('reloadPhase runs 0 → 1 over the reload and is null otherwise', () => {
    for (const [spec, missing, seconds] of [[RIFLE, 12, 2.4], [weaponSpec(tun, 'm870'), 3, 2]] as const) {
      const w = new Weapon(spec);
      // Full, or empty with none begun: no reload, no phase.
      expect(w.reloadPhase).toBeNull();
      expect(w.reloadShells).toBe(0);
      w.rounds = spec.magazine - missing;
      w.tick(TICK);
      expect(w.reloadPhase).toBeNull();
      w.beginReload();
      expect(w.reloadPhase).toBe(0);
      const phases: number[] = [];
      while (w.reloading) {
        w.tick(TICK);
        if (w.reloadPhase !== null) phases.push(w.reloadPhase);
      }
      // A tick's share of the reload each tick, up to the last tick's before its end; then none.
      const n = Math.round(seconds / TICK);
      expect(phases).toHaveLength(n - 1);
      phases.forEach((p, k) => expect(p).toBeCloseTo((k + 1) / n, 12));
      expect(w.reloadPhase).toBeNull();
      expect(w.reloadShells).toBe(0);
      // Put away mid-reload: none, and the magazine as it was.
      w.rounds = spec.magazine - missing;
      w.beginReload();
      for (let k = 0; k < 30; k++) w.tick(TICK);
      expect(w.reloadPhase).toBeCloseTo(30 / n, 12);
      expect(w.reloadShells).toBe(missing);
      w.cancelReload();
      expect(w.reloadPhase).toBeNull();
      expect(w.reloadShells).toBe(0);
      expect(w.rounds).toBe(spec.magazine - missing);
    }
  });

  it("sinceShot is the shot's clock: from the last shot, held at one interval while the trigger rests", () => {
    const w = new Weapon(weaponSpec(tun, 'm870'));
    const interval = 60 / 75;
    expect(w.sinceShot).toBe(interval);
    w.tick(TICK);
    expect(w.wants(true)).toBe(true);
    w.shot();
    // The pull's tick carried in it: a tick on from the interval it waited for.
    expect(w.sinceShot).toBeCloseTo(TICK, 12);
    for (let k = 0; k < 12; k++) {
      w.tick(TICK);
      w.wants(true);
    }
    expect(w.sinceShot).toBeCloseTo(13 * TICK, 12);
    // Let go, it is held at the interval: a fresh pull fires at once.
    for (let k = 0; k < 90; k++) {
      w.tick(TICK);
      w.wants(false);
    }
    expect(w.sinceShot).toBe(interval);
    // Read only.
    expect(() => {
      (w as unknown as { sinceShot: number }).sinceShot = 0;
    }).toThrow(TypeError);
  });

  it('every shot of every gun is a tracer', () => {
    for (const key of Object.keys(GUN_DEFS) as GunKey[]) {
      const w = new Weapon(weaponSpec(tun, GUN_DEFS[key].table));
      const flags: boolean[] = [];
      for (let i = 0; i < 12; i++) { flags.push(w.tracer()); w.shot(); }
      expect(flags.every(Boolean), key).toBe(true);
    }
  });
});
