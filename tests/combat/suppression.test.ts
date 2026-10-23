import { describe, expect, it } from 'vitest';
import { segmentDistance, Suppression, suppressionTunables } from '../../src/combat/suppression';
import { Rng } from '../../src/core/rng';
import { loadTunables } from '../../src/core/tunables';

// Ported from reference/python/tests/test_suppression.py's module cases: being shot at, with
// nothing hitting you.
const TICK = 1 / 60;
const T = suppressionTunables(loadTunables());
const R = T.crackRadiusM;
const fresh = () => ({ s: new Suppression(T), rng: Rng.root(7).derive('combat.suppression') });

describe('suppression', () => {
  describe('measures a near miss along the flight path', () => {
    it('a round passing by: its closest approach', () => {
      expect(segmentDistance([0, 0, -20], [0, 0, 20], [0.5, 0, 0])).toBeCloseTo(0.5, 12);
    });
    it('a round that stops short is not a near miss', () => {
      expect(segmentDistance([0, 0, -20], [0, 0, -10], [0, 0, 0])).toBeCloseTo(10, 12);
    });
    it('a degenerate segment is a point', () => {
      expect(segmentDistance([0, 0, 0], [0, 0, 0], [3, 0, 0])).toBeCloseTo(3, 12);
    });
  });

  describe('the level', () => {
    it('closer is worse, and not linearly', () => {
      const at = (d: number) => {
        const { s, rng } = fresh();
        s.crack(d, rng);
        return s.level;
      };
      expect(at(0.5 * R)).toBeGreaterThan(at(0.9 * R));
      expect(at(0.05)).toBeGreaterThan(at(0.5 * R));
      expect(at(0.05)).toBeGreaterThan(1.8 * at(0.5 * R));
    });

    it('a round outside the radius does nothing', () => {
      const { s, rng } = fresh();
      s.crack(R + 0.01, rng);
      expect([s.level, s.cracks]).toEqual([0, 0]);
    });

    it('a crack counts for more than an impact', () => {
      expect(T.crackAmount).toBeGreaterThan(T.impactAmount);
    });

    it('a burst pins you, and then it wears off', () => {
      const { s, rng } = fresh();
      for (let k = 0; k < 6; k++) {
        s.crack(1, rng);
        for (let t = 0; t < 9; t++) s.tick(TICK);
      }
      expect(s.level).toBeGreaterThan(0.7);
      let ticks = 0;
      while (s.level > 0.01) {
        s.tick(TICK);
        ticks++;
      }
      expect(ticks * TICK).toBeGreaterThanOrEqual(1);
      expect(ticks * TICK).toBeLessThanOrEqual(6);
    });

    it('holds briefly, so a burst does not bleed off mid-burst', () => {
      const { s, rng } = fresh();
      s.crack(1, rng);
      const held = s.level;
      for (let t = 0; t < Math.floor(T.holdS / TICK) - 2; t++) {
        s.tick(TICK);
        expect(s.level).toBe(held);
      }
    });

    it('is capped', () => {
      const { s, rng } = fresh();
      for (let k = 0; k < 50; k++) s.crack(0, rng);
      expect(s.level).toBe(T.maxLevel);
    });
  });

  describe('what it costs', () => {
    it('being pinned takes your movement', () => {
      const { s, rng } = fresh();
      for (let k = 0; k < 20; k++) s.crack(0.2, rng);
      expect(s.speedScale).toBeLessThan(0.5);
    });

    it('…and your aim', () => {
      const { s, rng } = fresh();
      for (let k = 0; k < 20; k++) s.crack(0.2, rng);
      expect(s.swayScale).toBeGreaterThan(3);
    });

    it('a near miss drags the muzzle, and lets go', () => {
      const { s, rng } = fresh();
      s.crack(0.3, rng);
      const flinch = s.flinchPitch;
      expect(flinch).toBeGreaterThan(0);
      for (let t = 0; t < 120; t++) s.tick(TICK);
      expect(s.flinchPitch).toBeLessThan(0.1 * flinch);
    });

    it('enough fire takes the parapet away from you', () => {
      const { s, rng } = fresh();
      expect(s.pinned).toBe(false);
      for (let k = 0; k < 4; k++) s.crack(0.3, rng);
      expect(s.pinned).toBe(true);
    });

    it('the visual layer tracks the level and nothing else', () => {
      const { s, rng } = fresh();
      expect([s.desaturation, s.vignette, s.shake.pitch, s.shake.roll]).toEqual([0, 0, 0, 0]);
      s.crack(0.5, rng);
      expect(s.desaturation).toBeGreaterThan(0);
      expect(s.vignette).toBeGreaterThan(0);
      s.tick(TICK);
      expect(Math.abs(s.shake.pitch) + Math.abs(s.shake.roll)).toBeGreaterThan(0);
    });
  });

  it('is deterministic', () => {
    const run = (seed: number) => {
      const s = new Suppression(T);
      const rng = Rng.root(seed).derive('combat.suppression');
      for (let k = 0; k < 40; k++) {
        if (k % 3 === 0) s.crack((k % 7) * 0.4, rng);
        if (k % 5 === 0) s.impact((k % 4) * 1.1);
        s.tick(TICK);
      }
      return [s.level, s.flinchPitch, s.flinchYaw, s.cracks, s.impacts];
    };
    expect(run(7)).toEqual(run(7));
    expect(run(8)).not.toEqual(run(7));
  });
});
