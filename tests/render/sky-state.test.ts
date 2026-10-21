import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../src/core/tunables';
import { skyState } from '../../src/render/sky-state';

const tun = loadTunables();
const dir = (az: number, el: number) => {
  const a = (az * Math.PI) / 180;
  const e = (el * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
};
const near = (a: readonly number[], b: readonly number[], eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) <= eps);
const lum = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

describe('the time of day', () => {
  it('is the probe\'s dusk at 0', () => {
    const s = skyState(tun, 0);
    expect(near(s.sunDir, dir(18, 4.5))).toBe(true);
    expect(near(s.keyDir, s.sunDir)).toBe(true);
    expect(s.keyColour).toEqual([3.4, 1.45, 0.6]);
    expect(s.zenith).toEqual([0.1, 0.13, 0.27]);
    expect(s.horizon).toEqual([0.95, 0.46, 0.24]);
    expect([s.ambient, s.fogDensity, s.exposure, s.flares]).toEqual([0.55, 0.012, 1.0, 0]);
  });
  it('is lit by the moon at night', () => {
    const s = skyState(tun, 1);
    expect(near(s.keyDir, dir(215, 32))).toBe(true);
    expect(s.keyColour).toEqual([0.05, 0.07, 0.12]);
    expect(s.exposure).toBe(3.2);
    expect(s.flares).toBe(1);
  });
  it('runs linearly between keys and clamps outside them', () => {
    const s = skyState(tun, 0.25);
    expect(s.ambient).toBeCloseTo(0.65, 12);
    expect(s.exposure).toBeCloseTo(1.5, 12);
    expect(s.fogDensity).toBeCloseTo(0.014, 12);
    expect(skyState(tun, -1)).toEqual(skyState(tun, 0));
    expect(skyState(tun, 2)).toEqual(skyState(tun, 1));
  });
  it('hands the key light from the sun to the moon while both are dim', () => {
    let previous = skyState(tun, 0);
    let switched = 0;
    for (let i = 1; i <= 1000; i++) {
      const s = skyState(tun, i / 1000);
      if (near(previous.keyDir, previous.sunDir) && near(s.keyDir, s.moonDir)) {
        switched++;
        expect(lum(previous.keyColour)).toBeLessThan(0.03);
        expect(lum(s.keyColour)).toBeLessThan(0.03);
      }
      previous = s;
    }
    expect(switched).toBe(1);
  });
});
