import { describe, expect, it } from 'vitest';
import { EARTH, TransmittanceTable, multipleScattering, skyRadiance, sphereQuadrature, transmittanceToTop, uniformSphere, type V3 } from '../support/atmosphere-ref';

const dir = (azimuthDeg: number, elevationDeg: number): V3 => {
  const a = (azimuthDeg * Math.PI) / 180;
  const e = (elevationDeg * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
};

describe('the atmosphere reference', () => {
  it('lets through what the optical depths say, straight up from the ground', () => {
    // Rayleigh 8 km × σR, Mie 1.2 km × 4.44e-3, ozone's tent 15 km × σO.
    const want = [0, 1, 2].map((c) => Math.exp(-(EARTH.rayleigh[c] * 8 * (1 - Math.exp(-100 / 8)) + EARTH.mieExtinction * 1.2 * (1 - Math.exp(-100 / 1.2)) + EARTH.ozone[c] * 15)));
    const got = transmittanceToTop(EARTH, EARTH.bottom, 1, 4000);
    for (let c = 0; c < 3; c++) expect(got[c]).toBeCloseTo(want[c], 5);
  });
  it('lets through less near the horizon, and least in blue', () => {
    const up = transmittanceToTop(EARTH, EARTH.bottom, 1);
    const low = transmittanceToTop(EARTH, EARTH.bottom, 0.05);
    for (let c = 0; c < 3; c++) expect(low[c]).toBeLessThan(up[c]);
    expect(low[2]).toBeLessThan(low[0]);
  });
  it('scatters finitely from the ground and from the top of the atmosphere', () => {
    const table = new TransmittanceTable(EARTH, 16, 64);
    for (const r of [EARTH.bottom, EARTH.top]) {
      for (const muS of [-0.5, 0, 0.5, 1]) {
        const psi = multipleScattering(EARTH, table, r, muS, sphereQuadrature(4, 4), 10);
        for (const c of psi) {
          expect(Number.isFinite(c)).toBe(true);
          expect(c).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
  it('weighs its sphere of directions to one', () => {
    const total = sphereQuadrature(64, 8).reduce((s, q) => s + q.w, 0);
    expect(total).toBeCloseTo(1, 3);
  });
  it('gathers multiple scattering to within 0.3% of a uniform sphere of 32,768 directions, twilight included', { timeout: 60_000 }, () => {
    const table = new TransmittanceTable(EARTH, 128, 1024);
    const dense = uniformSphere(256, 128);
    // Daylight, the horizon, and twilight at the heights and sun angles where 64 uniform directions miss by up to 80%.
    for (const [h, muS] of [[0, 0.6], [0, 0], [1, -0.13], [6, -0.2], [15, -0.16]]) {
      const want = multipleScattering(EARTH, table, EARTH.bottom + h, muS, dense, 30)[1];
      const got = multipleScattering(EARTH, table, EARTH.bottom + h, muS, undefined, 30)[1];
      expect(Math.abs(got - want) / want).toBeLessThan(0.003);
    }
  });
  it('marches the sky finely enough: 400 steps within 0.3% of 1,600', () => {
    const table = new TransmittanceTable(EARTH, 64, 256);
    const psi = { at: () => [1e-3, 1e-3, 1e-3] as [number, number, number] };
    for (const [sunElevation, viewElevation, azimuth, heightKm] of [[45, 70, 0, 0.002], [4.5, 0.3, 0, 0.002], [0, 2, 100, 2], [-6, 0.3, 180, 0.002], [15, -3, 40, 2]]) {
      const sun = dir(0, sunElevation);
      const view = dir(azimuth, viewElevation);
      const fine = skyRadiance(EARTH, table, psi, sun, view, heightKm, 1600);
      const got = skyRadiance(EARTH, table, psi, sun, view, heightKm);
      for (let c = 0; c < 3; c++) expect(Math.abs(got[c] - fine[c]) / fine[c]).toBeLessThan(0.003);
    }
  });
});
