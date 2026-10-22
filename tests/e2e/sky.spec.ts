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
// The moon, for its own sky view: well round from the sun, 25° up.
const MOON = direction(SUN_AZIMUTH + 160, 25);
// The six faces, as faceNormal numbers them: -x, +x, -y, +y, -z, +z.
const FACES: V3[] = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];
// The world draws its own ground out to here (the far field is 4 km square round the map), so
// shading samples the sky view's ground only beyond it.
const WORLD_REACH_KM = 2;

interface Result {
  compileErrors?: string[];
  model: AtmosphereModel;
  /** Per sun and camera height (suns outermost), per direction: RGB. */
  radiance: number[][][];
  /** Per sun and camera height: the six faces' irradiance from the sun, then from the moon (RGBA each). */
  irradiance: number[][];
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
  r = await runCase<Result>(page, 'skyModel', { dirs: DIRS, suns: SUNS, moon: MOON, heightsM: HEIGHTS_M });
  await page.close();
});

test('the sky matches the reference model', () => {
  expect(r.compileErrors ?? []).toEqual([]);
  expect(r.errors).toEqual([]);
  const { table, psi } = reference(r.model);
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

let tables: { table: TransmittanceTable; psi: ScatteringTable } | null = null;
/** The reference's tables for the case's model, built once. */
function reference(m: AtmosphereModel) {
  if (!tables) {
    const table = new TransmittanceTable(m);
    tables = { table, psi: new ScatteringTable(m, table) };
  }
  return tables;
}

/**
 * The reference's light on the six faces (faceNormal's order) from the sky lit from `light`: its
 * radiance over a grid of the sky twice as fine in elevation as the GPU's sky view (and as fine in
 * azimuth), each point the band of sky (and its mirror across the light's vertical plane) it
 * stands for, weighted by its solid angle and the cosine to each face.
 */
function faceIrradiance(m: AtmosphereModel, light: V3, heightKm: number): number[][] {
  const { table, psi } = reference(m);
  const beta = Math.acos(Math.sqrt(heightKm * (2 * m.bottom + heightKm)) / (m.bottom + heightKm));
  const zenithOf = (v: number) => (v < 0.5 ? (Math.PI - beta) * (1 - (1 - 2 * v) ** 2) : Math.PI - beta + beta * (2 * v - 1) ** 2);
  const azimuthOf = (u: number) => Math.acos(Math.max(-1, Math.min(1, 1 - 2 * u * u)));
  const [nu, nv] = [192, 215];
  const flat = Math.hypot(light[0], light[2]);
  const along = flat > 1e-9 ? [light[0] / flat, light[2] / flat] : [1, 0];
  const across = [-along[1], along[0]];
  const out = FACES.map(() => [0, 0, 0]);
  for (let j = 0; j < nv; j++) {
    const v = j / (nv - 1);
    const [v0, v1] = [Math.max(0, v - 0.5 / (nv - 1)), Math.min(1, v + 0.5 / (nv - 1))];
    const zenith = zenithOf(v);
    for (let i = 0; i < nu; i++) {
      const u = i / (nu - 1);
      const [u0, u1] = [Math.max(0, u - 0.5 / (nu - 1)), Math.min(1, u + 0.5 / (nu - 1))];
      const solid = (Math.cos(zenithOf(v0)) - Math.cos(zenithOf(v1))) * (azimuthOf(u1) - azimuthOf(u0));
      const azimuth = azimuthOf(u);
      for (const side of [-1, 1]) {
        const h = [0, 1].map((k) => Math.sin(zenith) * (Math.cos(azimuth) * along[k] + side * Math.sin(azimuth) * across[k]));
        const d: V3 = [h[0], Math.cos(zenith), h[1]];
        const radiance = skyRadiance(m, table, psi, light, d, heightKm, 150);
        FACES.forEach((n, f) => {
          const cos = Math.max(0, n[0] * d[0] + n[1] * d[1] + n[2] * d[2]);
          for (let c = 0; c < 3; c++) out[f][c] += radiance[c] * cos * solid;
        });
      }
    }
  }
  return out;
}

test('the six faces are lit by the sky as its radiance, cosine-weighted, says', () => {
  test.setTimeout(240_000);
  expect(r.compileErrors ?? []).toEqual([]);
  const wrong: string[] = [];
  const worst: string[] = [];
  // The sun from twilight to overhead at both heights, and the moon's own sky at each height.
  const checks: [string, V3, number, number, number][] = [];
  for (const elevation of [-6, 0, 4.5, 45, 90]) {
    const s = ELEVATIONS.indexOf(elevation);
    HEIGHTS_M.forEach((heightM, h) => checks.push([`sun ${elevation}°`, SUNS[s], heightM, s * HEIGHTS_M.length + h, 0]));
  }
  HEIGHTS_M.forEach((heightM, h) => checks.push(['moon', MOON, heightM, h, 6]));
  for (const [name, light, heightM, k, base] of checks) {
    const want = faceIrradiance(r.model, light, heightM / 1000);
    let worstRel = 0;
    FACES.forEach((_, f) => {
      for (let c = 0; c < 3; c++) {
        const got = r.irradiance[k][(base + f) * 4 + c];
        if (want[f][c] > 1e-6) worstRel = Math.max(worstRel, Math.abs(got - want[f][c]) / want[f][c]);
        if (!(Math.abs(got - want[f][c]) <= Math.max(0.03 * want[f][c], 1e-6))) wrong.push(`${name} at ${heightM} m, face ${f}, channel ${c}: gpu ${got.toExponential(3)} ref ${want[f][c].toExponential(3)}`);
      }
    });
    worst.push(`${name} at ${heightM} m ${(worstRel * 100).toFixed(2)}%`);
  }
  console.log(`face irradiance against the reference — ${worst.join('; ')}`);
  expect(wrong.slice(0, 20)).toEqual([]);
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

test("fog scatters each light by the angle a view makes with it: looking down, the low sun's glow fades", async ({ page }) => {
  // Dusk: the sun 4.5° up. Views in its azimuth, from just under the horizon to steeply down, and
  // half round from it.
  const sun = direction(SUN_AZIMUTH, 4.5);
  const elevations = [-1, -10, -30, -60, -85];
  const dirs = [...elevations.map((e) => direction(SUN_AZIMUTH, e)), ...elevations.map((e) => direction(SUN_AZIMUTH + 90, e))];
  await openHarness(page);
  const f = await runCase<{ compileErrors: string[]; values: number[][]; errors: string[] }>(page, 'skyFog', { dirs, sun });
  expect(f.compileErrors).toEqual([]);
  expect(f.errors).toEqual([]);
  // Toward the sun the red glow fades as the view turns from it; no column of it lies under the sun.
  for (let k = 1; k < elevations.length; k++) expect(f.values[k][0]).toBeLessThan(f.values[k - 1][0]);
  expect(f.values[3][0]).toBeLessThan(0.5 * f.values[0][0]);
  // Each is the sky just over the horizon at the same angle from the sun as the view.
  const m = r.model;
  const { table, psi } = reference(m);
  dirs.forEach((d, i) => {
    const cos = d[0] * sun[0] + d[1] * sun[1] + d[2] * sun[2];
    const flat = Math.hypot(sun[0], sun[2]);
    const along = [sun[0] / flat, sun[2] / flat];
    const c = Math.max(-1, Math.min(1, (cos - Math.sin((0.5 * Math.PI) / 180) * sun[1]) / (Math.cos((0.5 * Math.PI) / 180) * flat)));
    const s = Math.sqrt(1 - c * c);
    const h = [c * along[0] - s * along[1], c * along[1] + s * along[0]];
    const e = (0.5 * Math.PI) / 180;
    const want = skyRadiance(m, table, psi, sun, [h[0] * Math.cos(e), Math.sin(e), h[1] * Math.cos(e)], 0.002);
    for (let ch = 0; ch < 3; ch++) expect(Math.abs(f.values[i][ch] - want[ch])).toBeLessThanOrEqual(Math.max(0.03 * want[ch], 1e-6));
  });
});
