import { describe, expect, it } from 'vitest';
import { CLOCK_KEYS, celestial } from '../../src/core/sky-clock';
import { loadTunables } from '../../src/core/tunables';
import { PROBE_DUSK } from '../../src/render/frame-uniforms';
import { frameSky, skyState } from '../../src/render/sky-state';

const tun = loadTunables();
const dir = (az: number, el: number) => {
  const a = (az * Math.PI) / 180;
  const e = (el * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
};
const angle = (a: readonly number[], b: readonly number[]) => (Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180) / Math.PI;
const lum = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const keyed = (key: string) => tun.get(`sky.${key}`) as number[];

describe('the sky by the clock', () => {
  it("puts the dusk key light within 3° of sub-project 1's dusk, and lights it as approved: warm, its red 3.4", () => {
    const s = skyState(tun, CLOCK_KEYS.dusk);
    expect(s.keyDir).toEqual(s.sunDir);
    expect(angle(s.keyDir, dir(18, 4.5))).toBeLessThan(3);
    expect(Math.abs(s.keyColour[0] - 3.4)).toBeLessThan(0.1);
    expect(s.keyColour[0]).toBeGreaterThan(s.keyColour[1]);
    expect(s.keyColour[1]).toBeGreaterThan(s.keyColour[2]);
  });

  it("lights the night by the moon, as approved: the night key's brightness, and blue", () => {
    const s = skyState(tun, CLOCK_KEYS.night);
    expect(s.keyDir).toEqual(s.moonDir);
    expect(Math.abs(lum(s.keyColour) / lum([0.05, 0.07, 0.12]) - 1)).toBeLessThan(0.05);
    expect(s.keyColour[2]).toBeGreaterThan(s.keyColour[1]);
    expect(s.keyColour[1]).toBeGreaterThan(s.keyColour[0]);
  });

  it('lights the moon by its phase: dark when new, full when full', () => {
    // 1916-10-10 is a day before the full moon; the new moon was some fifteen days before.
    const full = skyState(tun, CLOCK_KEYS.night);
    expect(celestial(tun, CLOCK_KEYS.night).moon.illuminated).toBeGreaterThan(0.99);
    expect(lum(full.moonLight)).toBeGreaterThan(0.08);
    const raw = tun.raw();
    (raw.sky as Record<string, unknown>).date = [1916, 9, 26];
    const newMoon = skyState(new (tun.constructor as new (r: Record<string, unknown>) => typeof tun)(raw), 13);
    expect(lum(newMoon.moonLight)).toBeLessThan(0.001);
  });

  it("hands the key light from the sun to the moon through darkness, over the 2° of the sun's elevation either side of where they cross", () => {
    // Every 10 s of the clock from 17:00 to 22:00, across sunset (about 18:05 on the day).
    const states = Array.from({ length: 5 * 360 + 1 }, (_, i) => skyState(tun, 17 + i / 360));
    const scale = lum(skyState(tun, CLOCK_KEYS.dusk).keyColour);
    // No minute steps the key more than the sun's own light steps as its disc sets: the hand-over
    // adds no step of its own. (That steepest minute is some 6% of the dusk key's brightness.)
    const steepest = (f: (s: (typeof states)[number]) => number) => {
      let worst = 0;
      for (let i = 6; i < states.length; i++) worst = Math.max(worst, Math.abs(f(states[i]) - f(states[i - 6])));
      return worst;
    };
    const sunset = steepest((s) => lum(s.sunColour));
    expect(sunset).toBeLessThan(0.07 * scale);
    expect(steepest((s) => lum(s.keyColour))).toBeLessThan(sunset);
    // Where the sun's light falls to the moon's: 2° of the sun's elevation above it the key is the
    // sun's alone, 2° below the moon's alone; between, the sun's fades out and the moon's in.
    const cross = states.find((s) => lum(s.sunColour) < lum(s.moonColour))!;
    const crossing = cross.sunElevationDeg;
    for (const s of states) {
      if (s.sunElevationDeg > crossing + 2.01) expect(s.keyColour).toEqual(s.sunColour);
      if (s.sunElevationDeg < crossing - 2.01) expect(s.keyColour).toEqual(s.moonColour);
      // The key stands where one of them does, never between.
      expect(s.keyDir === s.sunDir || s.keyDir === s.moonDir).toBe(true);
    }
    // It turns from the sun to the moon once, while it is dark.
    let turns = 0;
    for (let i = 1; i < states.length; i++) {
      if (states[i - 1].keyDir === states[i - 1].sunDir && states[i].keyDir === states[i].moonDir) {
        turns++;
        expect(lum(states[i - 1].keyColour)).toBeLessThan(0.01 * scale);
        expect(lum(states[i].keyColour)).toBeLessThan(0.01 * scale);
      }
    }
    expect(turns).toBe(1);
  });

  it("frames the haze the fog and smoke are: the front's glow as brightly as the flares burn, the rest as tuned", () => {
    // Dusk (no flares), night (all of them), and 01:55, halfway between night's and dawn's.
    for (const hours of [CLOCK_KEYS.dusk, CLOCK_KEYS.night, 1 + 55 / 60]) {
      const s = skyState(tun, hours);
      const f = frameSky(s, tun);
      expect(f.frontGlow).toEqual(keyed('front_glow').map((v) => v * s.flares));
      expect([f.hazeKey, f.hazeForward, f.hazeSky]).toEqual([tun.f('sky.haze_key'), tun.f('sky.haze_forward'), tun.f('sky.haze_sky')]);
      expect([f.smokeDensity, f.smokeHeight]).toEqual([tun.f('sky.smoke_density'), tun.f('sky.smoke_height_m')]);
    }
    expect(skyState(tun, 1 + 55 / 60).flares).toBeCloseTo(0.6, 12);
  });

  it('keeps the probe\'s dusk, which frames are lit by until the app sets a sky, to dusk as the tunables light it', () => {
    const dusk = frameSky(skyState(tun, CLOCK_KEYS.dusk), tun) as unknown as Record<string, unknown>;
    // All but its stars, which stand in for the sidereal clock's.
    for (const [field, value] of Object.entries(PROBE_DUSK)) {
      if (field === 'stars') continue;
      const [got, want] = [[value].flat() as number[], [dusk[field]].flat() as number[]];
      want.forEach((w, i) => expect(Math.abs(got[i] - w), `${field}[${i}]: ${got[i]} for ${w}`).toBeLessThanOrEqual(0.03 * Math.abs(w) + 1e-4));
    }
  });

  it('keeps the fog, the flares and the exposure on their keys, linear between them, round the clock', () => {
    const keys = [CLOCK_KEYS.dawn, CLOCK_KEYS.noon, CLOCK_KEYS.dusk, CLOCK_KEYS.night];
    keys.forEach((hours, k) => {
      const s = skyState(tun, hours);
      expect(s.fogDensity).toBeCloseTo(keyed('fog_density')[k], 12);
      expect(s.flares).toBeCloseTo(keyed('flares')[k], 12);
      expect(s.exposure).toBeCloseTo(keyed('exposure')[k], 12);
    });
    const mid = skyState(tun, (CLOCK_KEYS.dusk + CLOCK_KEYS.night) / 2);
    expect(mid.fogDensity).toBeCloseTo((keyed('fog_density')[2] + keyed('fog_density')[3]) / 2, 12);
    // From night round to the next dawn: 1:55 is halfway.
    const small = skyState(tun, (CLOCK_KEYS.night + 24 + CLOCK_KEYS.dawn) / 2 - 24);
    expect(small.flares).toBeCloseTo((keyed('flares')[3] + keyed('flares')[0]) / 2, 12);
  });
});
