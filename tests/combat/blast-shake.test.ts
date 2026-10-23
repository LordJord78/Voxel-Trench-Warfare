import { describe, expect, it } from 'vitest';
import { BlastShake, blastShakeTunables } from '../../src/combat/blast-shake';
import { Suppression, suppressionTunables } from '../../src/combat/suppression';
import { loadTunables } from '../../src/core/tunables';

// A shell's blast shakes the view by how near it landed, and dies away; and near enough, it
// suppresses (milestone 4's plan, ruling 8).
const tun = loadTunables();
const t = blastShakeTunables(tun);
const DT = 1 / 60;

/** The largest pitch or roll over the `seconds` after a blast `distanceM` off. */
function peak(distanceM: number, seconds = 0.3, from = 0): number {
  const s = new BlastShake(t);
  s.kick(distanceM);
  let most = 0;
  for (let k = 0; k < (from + seconds) / DT; k++) {
    s.tick(DT);
    if (k * DT >= from) most = Math.max(most, Math.abs(s.pitch), Math.abs(s.roll));
  }
  return most;
}

describe("a blast's shake", () => {
  it('reads [artillery]', () => {
    expect([t.deg, t.radiusM, t.decayS, t.hz]).toEqual([2.5, 60, 0.35, 11]);
  });

  it('a blast nearer shakes harder, past shake_radius_m not at all, and dies away in shake_decay_s', () => {
    const near = peak(10);
    const far = peak(40);
    expect(near).toBeGreaterThan(t.deg * 0.4);
    expect(near).toBeLessThanOrEqual(t.deg);
    expect(far).toBeGreaterThan(0);
    expect(far).toBeLessThan(near / 3);
    expect(peak(t.radiusM + 1)).toBe(0);
    // After five of its decay times, under 1% of its start.
    expect(peak(10, 0.5, 5 * t.decayS)).toBeLessThan(near * 0.01);
  });

  it('a second, farther blast does not cut short the shake of a nearer one', () => {
    const s = new BlastShake(t);
    s.kick(10);
    s.tick(DT);
    const before = s.amplitude;
    s.kick(50);
    expect(s.amplitude).toBe(before);
    s.kick(5);
    expect(s.amplitude).toBeGreaterThan(before);
  });
});

describe("a blast's suppression", () => {
  it('a blast within blast_radius_m suppresses, by nearness; one beyond does not', () => {
    const at = (d: number) => {
      const s = new Suppression(suppressionTunables(tun));
      s.blast(d);
      return s.level;
    };
    const r = tun.f('suppression.blast_radius_m');
    expect(at(3)).toBeGreaterThan(at(12));
    expect(at(12)).toBeGreaterThan(at(20));
    expect(at(20)).toBeGreaterThan(0);
    expect(at(r + 1)).toBe(0);
    // Light's nearest, 15 m, does not pin alone.
    expect(at(15)).toBeLessThan(tun.f('suppression.eject_from_step_at') / 3);
  });
});
