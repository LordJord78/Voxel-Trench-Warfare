import { describe, expect, it } from 'vitest';
import { flareAt, flareTunables, type Launch } from '../../src/battle/flares';
import { Wind, windTunables } from '../../src/battle/wind';
import { Rng } from '../../src/core/rng';
import { loadTunables } from '../../src/core/tunables';

// A flare's flight (the battle spec's §2): fired from its post, it climbs without drag to its burst
// height at its apogee, catches over 0.5 s, drifts with the wind under its parachute sinking 0.3 m/s,
// burns 40 s and gutters over the last 5; a pure function of its launch and the time.
const tun = loadTunables();
const ft = flareTunables(tun);
const wind = new Wind(windTunables(tun), Rng.root(7).derive('battle.wind'));
const launch = (over: Partial<Launch> = {}): Launch => ({ id: 1, post: [40, 6, 20], t0: 100, bearing: 0.3, elevation: (80 * Math.PI) / 180, burstM: 40, colour: [1, 0.88, 0.7], ...over });
/** Seconds from launch to apogee: v0 sin(elevation) / g, with v0 chosen for the burst height. */
const apogee = (l: Launch) => Math.sqrt((2 * l.burstM) / ft.gravity);

describe("a flare's flight", () => {
  it('climbs to its burst height at its apogee', () => {
    for (const l of [launch(), launch({ bearing: 2.4, elevation: (70 * Math.PI) / 180, burstM: 50 }), launch({ elevation: (85 * Math.PI) / 180, burstM: 30 })]) {
      const tb = l.t0 + apogee(l);
      const top = flareAt(l, tb, wind, ft);
      expect(top.position[1]).toBeCloseTo(l.post[1] + l.burstM, 2);
      const rising = flareAt(l, l.t0 + apogee(l) / 2, wind, ft);
      expect(rising.stage).toBe('climb');
      expect(rising.glow).toBe(0);
      expect(rising.position[1]).toBeGreaterThan(l.post[1]);
      expect(rising.position[1]).toBeLessThan(top.position[1]);
      // Out toward its bearing as it climbs.
      expect((top.position[0] - l.post[0]) * Math.sin(l.bearing) + (top.position[2] - l.post[2]) * Math.cos(l.bearing)).toBeGreaterThan(0);
    }
  });

  it('catches over 0.5 s, burns 40 s, and gutters over the last 5', () => {
    const l = launch();
    const tb = l.t0 + apogee(l);
    expect(flareAt(l, tb + ft.igniteS / 2, wind, ft).glow).toBeCloseTo(0.5, 6);
    expect(flareAt(l, tb + 20, wind, ft).glow).toBe(1);
    expect(flareAt(l, tb + ft.burnS - ft.fadeS / 2, wind, ft).glow).toBeCloseTo(0.5, 6);
    expect(flareAt(l, tb + 20, wind, ft).stage).toBe('burning');
    expect(flareAt(l, tb + ft.burnS + 0.01, wind, ft).stage).toBe('out');
    expect(ft.burnS).toBe(40);
    expect(ft.fadeS).toBe(5);
    expect(ft.igniteS).toBe(0.5);
  });

  it('burning, it drifts with the wind and sinks 0.3 m/s', () => {
    const l = launch();
    const tb = l.t0 + apogee(l);
    const burst = flareAt(l, tb, wind, ft).position;
    for (const s of [5, 20, 39]) {
      const at = flareAt(l, tb + s, wind, ft).position;
      const d = wind.drift(tb, tb + s);
      expect(at[0] - burst[0]).toBeCloseTo(d[0], 6);
      expect(at[2] - burst[2]).toBeCloseTo(d[1], 6);
      expect(burst[1] - at[1]).toBeCloseTo(ft.sinkMps * s, 6);
    }
    expect(ft.sinkMps).toBe(0.3);
  });

  it('out after its burn, and nowhere before its launch', () => {
    const l = launch();
    for (const t of [l.t0 - 1, l.t0 + apogee(l) + ft.burnS + 1]) {
      const f = flareAt(l, t, wind, ft);
      expect(f.stage).toBe('out');
      expect(f.glow).toBe(0);
    }
  });

  it('a flare is a pure function of its launch and the time', () => {
    const l = launch({ id: 9 });
    const late = flareAt(l, 130, wind, ft);
    flareAt(l, 110, wind, ft);
    expect(flareAt(l, 130, wind, ft)).toEqual(late);
    expect(late.id).toBe(9);
  });
});
