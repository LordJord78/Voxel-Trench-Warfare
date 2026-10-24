import { describe, expect, it } from 'vitest';
import { Wind, windTunables } from '../../src/battle/wind';
import { Rng } from '../../src/core/rng';
import { loadTunables } from '../../src/core/tunables';

// The wind over the battle (the battle spec's §1): 1–5 m/s, veering a few degrees a minute about a
// prevailing bearing from the enemy's side, gusting; a pure function of time, so a flare's drift is
// its integral and a moment can be sought without stepping to it.
const tun = loadTunables();
const t = windTunables(tun);
const wind = (seed = 7) => new Wind(t, Rng.root(seed).derive('battle.wind'));
/** The bearing the wind blows toward, degrees as yaw (0 = +z, 90 = +x), and its speed. */
const bearing = (v: readonly number[]) => (Math.atan2(v[0], v[1]) * 180) / Math.PI;
const off = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

describe('the wind', () => {
  it('blows 1–5 m/s, within veer_deg of its prevailing bearing', () => {
    const w = wind();
    for (let s = 0; s <= 3600; s += 1) {
      const v = w.at(s);
      const speed = Math.hypot(v[0], v[1]);
      expect(speed, `${s} s`).toBeGreaterThanOrEqual(t.speedMps[0] - 1e-9);
      expect(speed, `${s} s`).toBeLessThanOrEqual(t.speedMps[1] + 1e-9);
      expect(off(bearing(v), t.prevailingDeg), `${s} s`).toBeLessThanOrEqual(t.veerDeg + 1e-9);
    }
  });

  it('veers slowly: a few degrees a minute at most', () => {
    const w = wind();
    let worst = 0;
    for (let s = 0; s + 60 <= 3600; s += 5) worst = Math.max(worst, off(bearing(w.at(s + 60)), bearing(w.at(s))));
    expect(worst).toBeLessThanOrEqual(10);
    expect(worst).toBeGreaterThan(0.5);
  });

  it('a drift is the wind integrated', () => {
    const w = wind();
    const fine = [0, 0];
    for (let s = 100; s < 145; s += 0.001) {
      const v = w.at(s + 0.0005);
      fine[0] += v[0] * 0.001;
      fine[1] += v[1] * 0.001;
    }
    const d = w.drift(100, 145);
    expect(Math.hypot(d[0] - fine[0], d[1] - fine[1])).toBeLessThanOrEqual(0.01 * Math.hypot(fine[0], fine[1]));
    expect(w.drift(100, 100)).toEqual([0, 0]);
  });

  it('the same seed blows the same wind, another seed another', () => {
    const a = wind(7);
    const b = wind(7);
    const c = wind(8);
    for (const s of [0, 17.5, 600, 3599]) expect(a.at(s)).toEqual(b.at(s));
    expect(a.at(600)).not.toEqual(c.at(600));
  });
});
