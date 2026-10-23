import { describe, expect, it } from 'vitest';
import { Artillery, artilleryTunables, ringSource, type Shell } from '../../src/combat/artillery';
import { Rng } from '../../src/core/rng';
import { loadTunables } from '../../src/core/tunables';

// The front's artillery (the spec's §3, "Shells"): off, light or heavy; each shell announced
// whistle_s before it lands, its radius drawn in 2.2–3.4 m from the stream combat.shells.
const tun = loadTunables();
const t = artilleryTunables(tun);
const DT = 1 / 60;
const TARGET: [number, number, number] = [100, 2, 100];

/** `minutes` of ticks at `intensity`: each shell's announcing tick and landing tick, by id. */
function run(intensity: 'off' | 'light' | 'heavy', minutes: number, seed = 7) {
  const a = new Artillery(t, ringSource(20, 50), Rng.root(seed).derive('combat.shells'));
  a.intensity = intensity;
  const announced = new Map<number, { tick: number; shell: Shell }>();
  const landed = new Map<number, { tick: number; shell: Shell }>();
  for (let tick = 0; tick < minutes * 3600; tick++) {
    const r = a.tick(DT, TARGET);
    for (const s of r.announced) announced.set(s.id, { tick, shell: s });
    for (const s of r.landed) {
      expect(landed.has(s.id)).toBe(false);
      landed.set(s.id, { tick, shell: s });
    }
  }
  return { announced, landed };
}

const gaps = (ticks: number[]) => ticks.slice(1).map((v, i) => (v - ticks[i]) * DT);

describe("the front's artillery", () => {
  it('reads [artillery]', () => {
    expect([t.whistleS, ...t.radiusM, t.lightSectorM[0]]).toEqual([1.5, 2.2, 3.4, 15]);
  });

  it('off fires nothing', () => {
    const { announced } = run('off', 10);
    expect(announced.size).toBe(0);
  });

  it('light lands one shell every light_mean_s or so, never two within light_gap_s', () => {
    const { announced } = run('light', 30);
    const n = announced.size;
    expect(n).toBeGreaterThan((30 * 60) / t.lightMeanS / 1.15);
    expect(n).toBeLessThan((30 * 60) / t.lightMeanS * 1.15);
    const between = gaps([...announced.values()].map((a) => a.tick));
    expect(Math.min(...between)).toBeGreaterThanOrEqual(t.lightGapS - DT);
  });

  it('heavy lands about one a second', () => {
    const { announced } = run('heavy', 10);
    const n = announced.size;
    expect(n).toBeGreaterThan((10 * 60) / t.heavyMeanS / 1.15);
    expect(n).toBeLessThan((10 * 60) / t.heavyMeanS * 1.15);
    expect(Math.min(...gaps([...announced.values()].map((a) => a.tick)))).toBeGreaterThanOrEqual(t.heavyGapS - DT);
  });

  it('each shell is announced whistle_s before it lands, once', () => {
    const { announced, landed } = run('heavy', 3);
    expect(announced.size).toBeGreaterThan(100);
    for (const [id, a] of announced) {
      const l = landed.get(id);
      if (!l) {
        // Still in the air when the run ended.
        expect(a.tick).toBeGreaterThan(3 * 3600 - t.whistleS / DT - 1);
        continue;
      }
      expect(l.tick - a.tick).toBe(Math.round(t.whistleS / DT));
      expect(l.shell).toEqual(a.shell);
    }
  });

  it('radii are drawn across 2.2–3.4 m, and shells land where the source puts them', () => {
    const { announced } = run('heavy', 10);
    const r = [...announced.values()].map((a) => a.shell.radiusM);
    expect(Math.min(...r)).toBeGreaterThanOrEqual(2.2);
    expect(Math.max(...r)).toBeLessThanOrEqual(3.4);
    expect(Math.min(...r)).toBeLessThan(2.3);
    expect(Math.max(...r)).toBeGreaterThan(3.3);
    for (const a of announced.values()) {
      const d = Math.hypot(a.shell.x - TARGET[0], a.shell.z - TARGET[2]);
      expect(d).toBeGreaterThanOrEqual(20 - 1e-9);
      expect(d).toBeLessThanOrEqual(50 + 1e-9);
    }
  });

  it('the same seed draws the same shells', () => {
    const shells = (seed: number) => [...run('light', 10, seed).announced.values()].map((a) => [a.tick, a.shell]);
    expect(shells(3)).toEqual(shells(3));
    expect(shells(3)).not.toEqual(shells(4));
  });
});
