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

// The range's exclusion (the ledger's ruling for G2's Task 3): with the range up, no shell lands
// within range_shell_clear_m of a spot. A shell drawn inside a circle is drawn again from the same
// stream, as a source draws again for a point it may not send, so the draws stay deterministic.
describe("the front's artillery with an exclusion", () => {
  /** Circles of 6 m (a range spot's) every 30° on the ring the source lands in, and one of 10 m (a mover's walk): about a fifth of its area. */
  const CIRCLES = [
    ...Array.from({ length: 12 }, (_, k) => ({ x: TARGET[0] + 35 * Math.cos((k * Math.PI) / 6), z: TARGET[2] + 35 * Math.sin((k * Math.PI) / 6), r: 6 })),
    { x: TARGET[0] + 25, z: TARGET[2] + 25, r: 10 },
  ];
  const inside = (s: Shell) => CIRCLES.some((c) => Math.hypot(s.x - c.x, s.z - c.z) < c.r);
  /** The first `n` shells announced at heavy from seed 7, with their ticks; the artillery's exclusion set by `exclude` first. */
  const shells = (n: number, exclude?: (a: Artillery) => void) => {
    const a = new Artillery(t, ringSource(20, 50), Rng.root(7).derive('combat.shells'));
    a.intensity = 'heavy';
    exclude?.(a);
    const out: (Shell & { tick: number })[] = [];
    for (let tick = 0; out.length < n; tick++) for (const s of a.tick(DT, TARGET).announced) out.push({ tick, ...s });
    return out.slice(0, n);
  };

  it('with an exclusion set, 500 drawn shells land outside every circle', () => {
    const kept = shells(500, (a) => a.setExclusion(CIRCLES));
    expect(kept.filter(inside)).toEqual([]);
    // Drawn again where the source puts them: on its ring still.
    for (const s of kept) expect(Math.hypot(s.x - TARGET[0], s.z - TARGET[2])).toBeGreaterThanOrEqual(20 - 1e-9);
    for (const s of kept) expect(Math.hypot(s.x - TARGET[0], s.z - TARGET[2])).toBeLessThanOrEqual(50 + 1e-9);
    // The circles matter: without them, many of the same stream's shells land inside.
    expect(shells(500).filter(inside).length).toBeGreaterThan(50);
    // Deterministic: the same seed and circles draw the same shells.
    expect(shells(100, (a) => a.setExclusion(CIRCLES))).toEqual(kept.slice(0, 100));
  });

  it("with none, today's sequence is unchanged", () => {
    // Seed 7's first six shells at heavy as the artillery drew them before it had an exclusion.
    const today = [
      { tick: 50, id: 1, x: 132.7449757147872, z: 76.74214864287727, radiusM: 2.798940823007821, seed: 2131439357 },
      { tick: 237, id: 2, x: 138.23275023156975, z: 116.5129446873717, radiusM: 3.2371610441936802, seed: 1644116327 },
      { tick: 277, id: 3, x: 124.44306195157476, z: 87.2482345504702, radiusM: 3.268632479505901, seed: 2016636397 },
      { tick: 343, id: 4, x: 105.08659551657348, z: 149.69968574606213, radiusM: 2.8156622346181037, seed: 4209190567 },
      { tick: 366, id: 5, x: 75.50173020151581, z: 108.94107865542603, radiusM: 3.177604097870229, seed: 2075114806 },
      { tick: 518, id: 6, x: 86.92052141112667, z: 76.19010651740282, radiusM: 3.3809054376713688, seed: 1190089113 },
    ];
    expect(shells(6)).toEqual(today);
    expect(new Artillery(t, ringSource(20, 50), Rng.root(7)).exclusion).toEqual([]);
    // Set and cleared (the range raised and lowered), or set where no shell lands: the same draws.
    expect(
      shells(6, (a) => {
        a.setExclusion(CIRCLES);
        a.setExclusion([]);
      }),
    ).toEqual(today);
    expect(shells(6, (a) => a.setExclusion([{ x: 1000, z: 1000, r: 6 }]))).toEqual(today);
  });
});

