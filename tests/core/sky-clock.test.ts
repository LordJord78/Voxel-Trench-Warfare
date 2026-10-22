import { describe, expect, it } from 'vitest';
import { celestial, CLOCK_KEYS, clockHours, clockText } from '../../src/core/sky-clock';
import { loadTunables } from '../../src/core/tunables';

const tun = loadTunables();
const angle = (a: readonly number[], b: readonly number[]) => (Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180) / Math.PI;
/** A sub-project 1 key direction: degrees round from +z toward +x, and up. */
const keyed = (turn: number, elevation: number) => {
  const t = (turn * Math.PI) / 180;
  const e = (elevation * Math.PI) / 180;
  return [Math.sin(t) * Math.cos(e), Math.sin(e), Math.cos(t) * Math.cos(e)];
};

describe('the sky clock', () => {
  it('names dusk, night, dawn and noon by the hour', () => {
    expect(CLOCK_KEYS).toEqual({ dawn: 6 + 50 / 60, noon: 12, dusk: 17 + 35 / 60, night: 21 });
  });
  it('puts the dusk sun where sub-project 1 keyed it, so the approved composition stands', () => {
    const c = celestial(tun, CLOCK_KEYS.dusk);
    expect(angle(c.sun.dir, keyed(18, 4.5))).toBeLessThan(3);
  });
  it('hangs a bright moon high over the night, near where sub-project 1 put it', () => {
    const c = celestial(tun, CLOCK_KEYS.night);
    expect(c.moon.elevationDeg).toBeGreaterThan(25);
    expect(c.moon.illuminated).toBeGreaterThan(0.95);
    expect(angle(c.moon.dir, keyed(215, 32))).toBeLessThan(35);
    expect(c.sun.elevationDeg).toBeLessThan(-18);
  });
  it('raises the sun at dawn and holds it high at noon', () => {
    expect(celestial(tun, CLOCK_KEYS.dawn).sun.elevationDeg).toBeLessThan(0);
    expect(celestial(tun, CLOCK_KEYS.dawn + 0.5).sun.elevationDeg).toBeGreaterThan(0);
    expect(celestial(tun, CLOCK_KEYS.noon).sun.elevationDeg).toBeGreaterThan(30);
  });
  it('moves the sun smoothly: under a degree a minute', () => {
    for (let h = 0; h < 24; h += 1 / 60) {
      expect(angle(celestial(tun, h).sun.dir, celestial(tun, h + 1 / 60).sun.dir)).toBeLessThan(1);
    }
  });
  it('runs the night on unbroken through midnight: the day turns at noon', () => {
    const angle = (a: number[], b: number[]) => (Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180) / Math.PI;
    const before = celestial(tun, 24 - 1 / 60);
    const after = celestial(tun, 1 / 60);
    // Two minutes of the moon's and the stars' turning, not a day's.
    expect(angle(before.moon.dir, after.moon.dir)).toBeLessThan(1);
    expect(angle(before.stars[2], after.stars[2])).toBeLessThan(0.1);
    expect(angle(before.stars[0], after.stars[0])).toBeLessThan(1);
  });
  it('reads a time on the clock, HH:MM, as hours, and writes it back', () => {
    expect(clockHours('17:35')).toBeCloseTo(17 + 35 / 60, 12);
    expect(clockHours('04:30')).toBe(4.5);
    expect(clockText(clockHours('06:20'))).toBe('06:20');
    expect(() => clockHours('24:00')).toThrow();
    expect(() => clockHours('6:5')).toThrow();
  });
});
