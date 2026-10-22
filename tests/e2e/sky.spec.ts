import { expect, test } from '@playwright/test';
import { groundHit, multipleScattering, ScatteringTable, scatteringMu, skyRadiance, TransmittanceTable, transmittanceToTop, type AtmosphereModel } from '../support/atmosphere-ref';
import { openHarness, runCase } from './support/run';

type V3 = [number, number, number];

/** Azimuth from +z toward +x and elevation, in degrees, as a unit vector with y up. */
function direction(azimuthDeg: number, elevationDeg: number): V3 {
  const a = (azimuthDeg * Math.PI) / 180;
  const e = (elevationDeg * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
}

const SUN_AZIMUTH = 30;
const ELEVATIONS = [-18, -6, 0, 4.5, 15, 45, 90];
const HEIGHTS_M = [2, 2000];
// 64 views: eight elevations, from the ground near the camera to near the zenith, each at eight
// azimuths from the sun's own to its opposite.
const VIEW_ELEVATIONS = [-25, -3, -0.5, 0.3, 2, 8, 25, 70];
const VIEW_AZIMUTHS = [0, 15, 40, 70, 100, 130, 160, 180];
const DIRS: V3[] = VIEW_ELEVATIONS.flatMap((e) => VIEW_AZIMUTHS.map((a) => direction(SUN_AZIMUTH + a, e)));
const SUNS: V3[] = ELEVATIONS.map((e) => direction(SUN_AZIMUTH, e));
// The world draws its own ground out to here (the far field is 4 km square round the map), so
// shading samples the sky view's ground only beyond it.
const WORLD_REACH_KM = 2;

interface Result {
  compileErrors?: string[];
  model: AtmosphereModel;
  /** Per sun and camera height (suns outermost), per direction: RGB. */
  radiance: number[][][];
  /** The transmittance (256 × 64) and multiple-scattering (64 × 32, ln Ψms) LUTs: RGBA, row by row. */
  transmittance: number[];
  scattering: number[];
  bad: { transmittance: number; scattering: number; skyView: number };
  errors: string[];
}

let r: Result;

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await openHarness(page);
  r = await runCase<Result>(page, 'skyModel', { dirs: DIRS, suns: SUNS, heightsM: HEIGHTS_M });
  await page.close();
});

test('the sky matches the reference model', () => {
  expect(r.compileErrors ?? []).toEqual([]);
  expect(r.errors).toEqual([]);
  const table = new TransmittanceTable(r.model);
  const psi = new ScatteringTable(r.model, table);
  const wrong: string[] = [];
  const worst: string[] = [];
  let unseen = 0;
  ELEVATIONS.forEach((elevation, s) => {
    let worstRel = 0;
    HEIGHTS_M.forEach((heightM, h) => {
      const got = r.radiance[s * HEIGHTS_M.length + h];
      DIRS.forEach((d, i) => {
        const ground = groundHit(r.model, [0, r.model.bottom + heightM / 1000, 0], d);
        if (ground >= 0 && ground < WORLD_REACH_KM) {
          unseen++;
          return;
        }
        const want = skyRadiance(r.model, table, psi, SUNS[s], d, heightM / 1000);
        for (let c = 0; c < 3; c++) {
          const err = Math.abs(got[i][c] - want[c]);
          if (want[c] > 1e-6) worstRel = Math.max(worstRel, err / want[c]);
          if (!(err <= Math.max(0.03 * want[c], 1e-6))) {
            const v = VIEW_ELEVATIONS[Math.floor(i / VIEW_AZIMUTHS.length)];
            const a = VIEW_AZIMUTHS[i % VIEW_AZIMUTHS.length];
            wrong.push(`sun ${elevation}° at ${heightM} m, view ${v}° up ${a}° round, channel ${c}: gpu ${got[i][c].toExponential(3)} ref ${want[c].toExponential(3)}`);
          }
        }
      });
    });
    worst.push(`sun ${elevation}°: worst ${(worstRel * 100).toFixed(2)}%`);
  });
  console.log(`sky against the reference — ${worst.join('; ')}`);
  expect(wrong.slice(0, 20)).toEqual([]);
  // Left out: the 24 views below the horizon from 2 m, at each sun, whose ground the world covers.
  expect(unseen).toBe(24 * ELEVATIONS.length);
});

test('the transmittance LUT holds the transmittance to the top at every texel', () => {
  const m = r.model;
  const big = Math.sqrt(m.top * m.top - m.bottom * m.bottom);
  let worst = 0;
  for (let j = 0; j < 64; j++) {
    for (let i = 0; i < 256; i++) {
      // Bruneton's parametrisation, inverted: the height and the distance to the top along the ray.
      const rho = (big * j) / 63;
      const radius = Math.sqrt(rho * rho + m.bottom * m.bottom);
      const dMin = m.top - radius;
      const d = dMin + (i / 255) * (rho + big - dMin);
      const mu = d === 0 ? 1 : Math.max(-1, Math.min(1, (big * big - rho * rho - d * d) / (2 * radius * d)));
      const want = transmittanceToTop(m, radius, mu, 2000);
      for (let c = 0; c < 3; c++) {
        if (want[c] > 1e-4) worst = Math.max(worst, Math.abs(r.transmittance[(j * 256 + i) * 4 + c] - want[c]) / want[c]);
      }
    }
  }
  expect(worst).toBeLessThan(0.01);
});

test('the multiple-scattering LUT holds Ψms at every texel', () => {
  const m = r.model;
  const table = new TransmittanceTable(m);
  let worst = 0;
  for (let j = 0; j < 32; j++) {
    for (let i = 0; i < 64; i++) {
      const want = multipleScattering(m, table, m.bottom + 100 * (j / 31) ** 2, scatteringMu(i / 63), undefined, 60);
      for (let c = 0; c < 3; c++) {
        if (want[c] > 1e-8) worst = Math.max(worst, Math.abs(Math.exp(r.scattering[(j * 64 + i) * 4 + c]) - want[c]) / want[c]);
      }
    }
  }
  // The sky's own bound. The texels nearest it (2%) are 65 to 100 km up with the sun 18° down,
  // where the air is a hundred-thousandth as dense as at the ground.
  expect(worst).toBeLessThan(0.03);
});

test('no LUT texel and no sample of the sky is NaN', () => {
  expect(r.compileErrors ?? []).toEqual([]);
  expect(r.bad).toEqual({ transmittance: 0, scattering: 0, skyView: 0 });
  expect(r.radiance.flat(2).every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
});
