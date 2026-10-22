import { describe, expect, it } from 'vitest';
import { horizontal, julianDay, moonEquatorial, moonIllumination, siderealTimeDeg, sunEquatorial, toWorld } from '../../src/core/ephemeris';

// Reference values are Jean Meeus's worked examples, Astronomical Algorithms (2nd ed., 1998).
const near = (got: number, want: number, eps: number) => expect(Math.abs(got - want), `${got} vs ${want}`).toBeLessThanOrEqual(eps);
const degrees = (h: number, m: number, s: number) => (h + m / 60 + s / 3600) * 15;

describe('the ephemeris', () => {
  it('counts Julian days (example 7.a: 1957 October 4.81)', () => {
    near(julianDay(1957, 10, 4.81), 2436116.31, 1e-6);
  });

  it('gives sidereal time (examples 12.a and 12.b)', () => {
    near(siderealTimeDeg(julianDay(1987, 4, 10)), degrees(13, 10, 46.3668), 1e-4);
    near(siderealTimeDeg(julianDay(1987, 4, 10 + (19 + 21 / 60) / 24)), degrees(8, 34, 57.0896), 1e-4);
  });

  it('places the sun (example 25.a: 1992 October 13.0 TD)', () => {
    const s = sunEquatorial(2448908.5);
    near(s.ra, 198.38083, 0.001);
    near(s.dec, -7.78507, 0.001);
  });

  it('places the moon (example 47.a: 1992 April 12.0 TD)', () => {
    const m = moonEquatorial(2448724.5);
    near(m.lambda, 133.162655, 0.02);
    near(m.beta, -3.229126, 0.02);
    near(m.distanceKm, 368409.7, 50);
    near(m.ra, 134.68847, 0.02);
    near(m.dec, 13.768368, 0.02);
  });

  it('lights the moon (example 48.a: 1992 April 12.0 TD)', () => {
    const k = moonIllumination(2448724.5);
    near(k.phaseAngleDeg, 69.0756, 0.2);
    near(k.illuminated, 0.6786, 0.003);
  });

  it('turns equatorial to horizontal (example 13.b: Venus over Washington, 1987 April 10 19:21 UT)', () => {
    const lat = 38 + 55 / 60 + 17 / 3600;
    const lonEast = -(77 + 3 / 60 + 56 / 3600);
    const h = horizontal(degrees(23, 9, 16.641), -(6 + 43 / 60 + 11.61 / 3600), lat, lonEast, julianDay(1987, 4, 10 + (19 + 21 / 60) / 24));
    near(h.elevationDeg, 15.1249, 0.001);
    // Meeus measures azimuth from the south, westward; this one is a compass bearing.
    near(h.azimuthDeg, 68.0337 + 180, 0.001);
  });

  it('sees no NaN at new or full moon, whatever the phase', () => {
    for (let jd = 2421000; jd < 2421060; jd += 0.25) {
      const k = moonIllumination(jd);
      expect(Number.isFinite(k.phaseAngleDeg) && Number.isFinite(k.illuminated)).toBe(true);
      expect(k.illuminated).toBeGreaterThanOrEqual(0);
      expect(k.illuminated).toBeLessThanOrEqual(1);
    }
  });

  it('puts the noon sun 40° up at 50° N on the September equinox', () => {
    // 1916 September 23 at local apparent noon, 2.7° E: mean noon there is 11:49 UT, and the
    // equation of time (+7.5 min in late September) brings the sun to the meridian at 11:42.
    const jd = julianDay(1916, 9, 23 + (11 + 42 / 60) / 24);
    const s = sunEquatorial(jd);
    const h = horizontal(s.ra, s.dec, 50, 2.7, jd);
    near(h.elevationDeg, 40, 0.6);
    near(h.azimuthDeg, 180, 1);
  });

  it('turns a compass bearing into the world, +z along the map bearing and +x to its right', () => {
    const v = toWorld(100, 0, 90);
    near(v[2], Math.cos((10 * Math.PI) / 180), 1e-9);
    near(v[0], Math.sin((10 * Math.PI) / 180), 1e-9);
    near(v[1], 0, 1e-12);
    const up = toWorld(0, 90, 0);
    near(up[1], 1, 1e-12);
  });
});
