import { describe, expect, it } from 'vitest';
import { Weapon, weaponSpec, type WeaponSpec } from '../../src/combat/weapon';
import { Rng } from '../../src/core/rng';
import { loadTunables } from '../../src/core/tunables';

const TICK = 1 / 60;
const RIFLE = weaponSpec(loadTunables(), 'assault_rifle');

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
    expect(RIFLE).toMatchObject({ key: 'assault_rifle', name: '5.45 assault rifle', rpm: 650, magazine: 30, dispersionMoa: 3.2, reloadS: 2.4, automatic: true, tracerEvery: 5 });
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

  it('every fifth shot is a tracer', () => {
    const w = new Weapon({ ...RIFLE, magazine: 100 });
    const flags: boolean[] = [];
    for (let k = 0; k < 400 && flags.length < 20; k++) {
      w.tick(TICK);
      if (w.wants(true)) {
        flags.push(w.tracer());
        w.shot();
      }
    }
    expect(flags).toEqual(Array.from({ length: 20 }, (_, i) => i % 5 === 4));
  });
});
