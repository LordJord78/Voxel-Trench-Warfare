import { describe, expect, it } from 'vitest';
import { CLOCK_KEYS, celestial } from '../../src/core/sky-clock';
import { loadTunables } from '../../src/core/tunables';
import { skyState } from '../../src/render/sky-state';

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

  it("hands the key light from the sun to the moon without a jump, crossfaded over 2° of the sun's elevation", () => {
    // Every 10 s of the clock from 17:00 to 22:00, across sunset (about 17:50 on the day).
    const states = Array.from({ length: 5 * 360 + 1 }, (_, i) => skyState(tun, 17 + i / 360));
    const scale = lum(skyState(tun, CLOCK_KEYS.dusk).keyColour);
    for (let i = 6; i < states.length; i += 6) {
      const [a, b] = [states[i - 6], states[i]];
      // A minute's change is never more than 5% of the dusk key's brightness, nor a swing of 30°.
      expect(Math.abs(lum(b.keyColour) - lum(a.keyColour))).toBeLessThan(0.05 * scale);
      expect(angle(a.keyDir, b.keyDir)).toBeLessThan(30);
    }
    // Where the sun's light falls to the moon's: the key is the sun's 1° of the sun's elevation
    // above it, and the moon's 1° below, crossfaded between.
    const cross = states.find((s) => lum(s.sunColour) < lum(s.moonColour))!;
    const crossing = cross.sunElevationDeg;
    for (const s of states) {
      if (s.sunElevationDeg > crossing + 1.01) expect(s.keyWeight).toBe(1);
      if (s.sunElevationDeg < crossing - 1.01) expect(s.keyWeight).toBe(0);
      if (s.keyWeight === 1) expect(s.keyDir).toEqual(s.sunDir);
      if (s.keyWeight === 0) expect(s.keyDir).toEqual(s.moonDir);
    }
    expect(states.some((s) => s.keyWeight > 0.1 && s.keyWeight < 0.9)).toBe(true);
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
