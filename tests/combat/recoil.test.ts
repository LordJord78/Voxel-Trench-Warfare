import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Recoil, recoilProfile } from '../../src/combat/recoil';
import { advanceSpring } from '../../src/combat/spring';
import { Rng } from '../../src/core/rng';
import { loadTunables, Tunables } from '../../src/core/tunables';

// Ported from reference/python/tests/test_recoil.py: the rifle's brief — a tiny kick, a fast
// recovery, a quick vertical climb that plateaus, a mild rightward drift after about six rounds —
// as numbers, against the tuning file.
const TICK = 1 / 60;
const WEAPON = 'assault_rifle';
const tun = loadTunables();

function make(seed = 11): { recoil: Recoil; rng: Rng } {
  return { recoil: new Recoil(recoilProfile(tun, WEAPON)), rng: Rng.root(seed).derive('recoil') };
}

/** Hold the trigger at `rpm`: (round, pitch, yaw) at each shot. */
function burst(r: { recoil: Recoil; rng: Rng }, rounds: number, rpm = 650): [number, number, number][] {
  const interval = 60 / rpm;
  const out: [number, number, number][] = [];
  let t = 0;
  let next = 0;
  let fired = 0;
  while (fired < rounds) {
    if (t >= next) {
      r.recoil.shot(r.rng);
      fired++;
      next += interval;
      out.push([fired, r.recoil.pitch, r.recoil.yaw]);
    }
    r.recoil.tick(TICK);
    t += TICK;
  }
  return out;
}

/** The kick over `ticks` ticks after a shot. */
function kickTrace(recoil: Recoil, ticks = 120): number[] {
  const seen: number[] = [];
  for (let k = 0; k < ticks; k++) {
    recoil.tick(TICK);
    seen.push(recoil.kickPitch);
  }
  return seen;
}

describe('recoil', () => {
  describe('is all data', () => {
    it('no recoil magnitude is written in code', () => {
      for (const file of ['src/combat/recoil.ts', 'src/combat/spring.ts']) {
        const body = readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*/g, '')
          .replace(/'[^']*'|`[^`]*`|"[^"]*"/g, '')
          .replace(/SETTLE_CONSTANT = [\d.]+/, '');
        const suspicious = (body.match(/(?<![\w.])\d+\.\d+/g) ?? []).filter((n) => !['1.0', '0.0', '2.0', '0.02'].includes(n));
        expect(suspicious, file).toEqual([]);
      }
    });

    it('every recoil table resolves', () => {
      for (const key of tun.sections('recoil')) {
        if (key === 'defaults') continue;
        const p = recoilProfile(tun, key);
        expect(p.settleS).toBeGreaterThan(0);
        expect(p.climbCeilingDeg).toBeGreaterThan(0);
      }
    });

    it('a profile missing a field says which', () => {
      const broken = new Tunables({ recoil: { defaults: { kick_pitch_deg: 0.3 }, broken: {} } });
      expect(() => recoilProfile(broken, 'broken')).toThrow(/settle_time_s/);
    });

    it('the rifle defines itself only where it differs', () => {
      const text = readFileSync('data/tunables.toml', 'utf8');
      expect(text).toContain('[recoil.defaults]');
      expect(text).toContain(`[recoil.${WEAPON}]`);
    });
  });

  describe('the kick', () => {
    it('peaks at the angle it was tuned to', () => {
      const { recoil, rng } = make();
      recoil.shot(rng);
      expect(Math.abs(recoil.kickPitch / 0.34 - 1)).toBeLessThanOrEqual(0.25);
    });

    it('is at its peak on the tick the round leaves', () => {
      const { recoil, rng } = make();
      recoil.shot(rng);
      const atShot = recoil.kickPitch;
      expect(atShot).toBeGreaterThanOrEqual(Math.max(...kickTrace(recoil)));
    });

    it('only ever decays', () => {
      const { recoil, rng } = make();
      recoil.shot(rng);
      const trace = kickTrace(recoil);
      expect(trace).toEqual([...trace].sort((a, b) => b - a));
    });

    it('is tiny', () => {
      const { recoil, rng } = make();
      recoil.shot(rng);
      expect(Math.max(...kickTrace(recoil))).toBeLessThan(0.6);
    });

    it('is gone within its settling time', () => {
      const { recoil, rng } = make();
      recoil.shot(rng);
      const trace = kickTrace(recoil);
      const peak = Math.max(...trace);
      expect(Math.abs(trace[Math.ceil(0.2 / TICK)])).toBeLessThan(0.05 * peak);
    });

    it('a critically damped kick does not bounce', () => {
      const { recoil, rng } = make();
      expect(Math.abs(recoilProfile(tun, WEAPON).damping - 1)).toBeLessThanOrEqual(0.05);
      recoil.shot(rng);
      const trace = kickTrace(recoil);
      expect(Math.min(...trace)).toBeGreaterThan(-0.02 * Math.max(...trace));
    });
  });

  describe('the climb', () => {
    it('rises fast and then plateaus', () => {
      const pitches = burst(make(), 30).map(([, p]) => p);
      const early = pitches[4] - pitches[0];
      const late = pitches[29] - pitches[25];
      expect(early).toBeGreaterThan(0);
      expect(late).toBeLessThan(early * 0.25);
      expect(pitches[29]).toBeLessThanOrEqual(1.65 * 1.35);
    });

    it('never points you at the sky', () => {
      const shots = burst(make(), 120);
      expect(shots[shots.length - 1][1]).toBeLessThan(1.65 * 1.5);
    });

    it('bleeds off when you stop', () => {
      const r = make();
      burst(r, 12);
      const held = r.recoil.climbPitch;
      expect(held).toBeGreaterThan(0);
      for (let k = 0; k < Math.floor(1.5 / TICK); k++) r.recoil.tick(TICK);
      expect(r.recoil.climbPitch).toBeLessThan(held * 0.2);
    });

    it('a gap in fire restarts the pattern', () => {
      const r = make();
      burst(r, 10);
      expect(r.recoil.shots).toBe(10);
      for (let k = 0; k < Math.floor((0.28 + 0.1) / TICK); k++) r.recoil.tick(TICK);
      r.recoil.shot(r.rng);
      expect(r.recoil.shots).toBe(1);
    });

    it('nothing jumps when firing stops mid-climb, through a reload, a stance change and a rest', () => {
      const r = make();
      burst(r, 20);
      const held = [r.recoil.pitch, r.recoil.yaw];
      let last = held;
      let worst = 0;
      for (let k = 0; k < Math.round((2.4 + 2) / TICK); k++) {
        if (k === 50) r.recoil.scale = 0.72;
        r.recoil.tick(TICK);
        const now = [r.recoil.pitch, r.recoil.yaw];
        worst = Math.max(worst, Math.abs(now[0] - last[0]), Math.abs(now[1] - last[1]));
        last = now;
      }
      expect(worst).toBeLessThanOrEqual(0.15);
      expect(Math.abs(last[0])).toBeLessThan(0.01 * held[0]);
      expect(Math.abs(last[1])).toBeLessThan(0.01 * Math.max(held[1], 1e-9) + 1e-9);
    });
  });

  describe('the drift', () => {
    it('is rightward and late', () => {
      const onset = recoilProfile(tun, WEAPON).driftOnsetShots;
      const byRound = new Map(burst(make(), 24).map(([n, , y]) => [n, y]));
      expect(Math.abs(byRound.get(onset)!)).toBeLessThan(0.12);
      expect(byRound.get(24)!).toBeGreaterThan(0.3);
      expect(byRound.get(24)!).toBeGreaterThan(byRound.get(onset + 4)!);
      expect(byRound.get(onset + 4)!).toBeGreaterThan(byRound.get(onset)!);
      expect(byRound.get(24)!).toBeLessThan(3);
    });

    it('is the only horizontal term', () => {
      expect(recoilProfile(tun, WEAPON).kickYawDeg).toBe(0);
    });
  });

  describe('the spring', () => {
    it('is stepped exactly, not integrated, so the tick rate does not matter', () => {
      const coarse = make();
      const fine = make();
      coarse.recoil.shot(coarse.rng);
      fine.recoil.shot(fine.rng);
      for (let k = 0; k < 30; k++) {
        coarse.recoil.tick(TICK);
        for (let j = 0; j < 8; j++) fine.recoil.tick(TICK / 8);
      }
      expect(Math.abs(coarse.recoil.kickPitch - fine.recoil.kickPitch)).toBeLessThanOrEqual(2e-3);
    });

    it('always returns to rest', () => {
      for (const zeta of [0.4, 1.0, 1.8]) {
        let [x, v] = [0, 12];
        for (let k = 0; k < 400; k++) [x, v] = advanceSpring(x, v, 30, zeta, TICK);
        expect(Math.abs(x)).toBeLessThan(1e-3);
        expect(Math.abs(v)).toBeLessThan(1e-2);
      }
    });

    it('underdamped, it overshoots; critically damped, it does not', () => {
      const trace = (zeta: number) => {
        let [x, v] = [0, 12];
        const out: number[] = [];
        for (let k = 0; k < 120; k++) {
          [x, v] = advanceSpring(x, v, 30, zeta, TICK);
          out.push(x);
        }
        return out;
      };
      expect(Math.min(...trace(0.35))).toBeLessThan(-0.01);
      expect(Math.min(...trace(1.0))).toBeGreaterThan(-1e-6);
    });
  });

  describe('stance and determinism', () => {
    it('a tighter stance shoulders more of it', () => {
      const standing = make();
      const prone = make();
      prone.recoil.scale = tun.f('stance.prone.sway_scale');
      burst(standing, 10);
      burst(prone, 10);
      expect(prone.recoil.pitch).toBeLessThan(standing.recoil.pitch);
    });

    it('the same seed gives the same pattern, and another seed another', () => {
      const pattern = (seed: number) => burst(make(seed), 20).map(([, p, y]) => [p.toFixed(9), y.toFixed(9)].join());
      expect(pattern(4)).toEqual(pattern(4));
      expect(pattern(5)).not.toEqual(pattern(4));
    });
  });
});
