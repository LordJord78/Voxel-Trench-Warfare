import { describe, expect, it } from 'vitest';
import { transmittanceAt } from '../../src/render/atmosphere';
import { EARTH, transmittanceToTop } from '../support/atmosphere-ref';

describe('the transmittance shading reads on the CPU', () => {
  it('matches the reference from the ground and from 2 km, up to the horizon', () => {
    for (const heightKm of [0.002, 2]) {
      for (const mu of [1, 0.5, 0.2, 0.08, 0.02, 0]) {
        const want = transmittanceToTop(EARTH, EARTH.bottom + heightKm, mu, 4000);
        const got = transmittanceAt(EARTH, heightKm, mu);
        for (let c = 0; c < 3; c++) expect(Math.abs(got[c] - want[c]) / want[c]).toBeLessThan(0.005);
      }
    }
  });
  it('lets nothing through from below the horizon', () => {
    expect(transmittanceAt(EARTH, 0.002, -0.05)).toEqual([0, 0, 0]);
  });
});
