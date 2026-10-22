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

test('the LUTs build at load in under 5 ms of GPU time', async ({ page }) => {
  await openHarness(page);
  // The GPU's clocks rise over its first builds, as over a game's first frames: timed at the clocks
  // they settle to, the first build's time reported beside them.
  const r = await runCase<{ first: number | null; ms: number | null; times: number[]; errors: string[] }>(page, 'skyBuild', { warm: 6, runs: 9 });
  expect(r.errors).toEqual([]);
  test.skip(r.ms === null, 'no timestamp queries on this GPU');
  console.log(`LUT build at load: ${r.ms!.toFixed(2)} ms of GPU time, the first build ${r.first!.toFixed(2)} (all: ${r.times.map((t) => t.toFixed(2)).join(', ')})`);
  expect(r.ms!).toBeGreaterThan(0);
  expect(r.ms!).toBeLessThan(5);
});

test('no LUT texel and no sample of the sky is NaN', () => {
  expect(r.compileErrors ?? []).toEqual([]);
  expect(r.bad).toEqual({ transmittance: 0, scattering: 0, skyView: 0 });
  expect(r.radiance.flat(2).every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
});

// Sub-project 1's fog glowed with its hand-keyed horizon colour × 0.9, and 0.08 of the key light
// toward the sun by cos⁴ of the angle: at dusk and night, the colours the haze is to keep.
const APPROVED_FOG = { dusk: [0.855, 0.414, 0.216], night: [0.027, 0.0225, 0.036] };

test('the haze glows as approved: warm all round at dusk and brighter toward the sun, violet at night', async ({ page }) => {
  await openHarness(page);
  // Level views these many degrees round from the key light, then views under it.
  const round = [4, 30, 90, 135, 180];
  const down = [10, 30, 60];
  for (const [time, hours] of [['dusk', 17 + 35 / 60], ['night', 21]] as const) {
    const f = await runCase<{ compileErrors: string[]; values: number[][]; dirs: V3[]; keyDir: V3; keyColour: V3; errors: string[] }>(page, 'skyHaze', { hours, round, down });
    expect(f.compileErrors).toEqual([]);
    expect(f.errors).toEqual([]);
    console.log(`haze at ${time}: ${f.values.map((v) => `[${v.map((c) => c.toFixed(4)).join(' ')}]`).join(' ')}`);
    const want = APPROVED_FOG[time];
    // Away from the key, the approved fog's colour, within a tenth in each channel.
    for (const i of [2, 3, 4]) {
      for (let c = 0; c < 3; c++) expect(Math.abs(f.values[i][c] / want[c] - 1), `${time}, ${round[i]}° round, channel ${c}`).toBeLessThan(0.1);
    }
    const lobe = (i: number) => f.values[i][0] - f.values[4][0];
    if (time === 'dusk') {
      // Toward the sun, its glow on top, as approved.
      for (const i of [0, 1]) {
        const cos = Math.max(0, f.dirs[i][0] * f.keyDir[0] + f.dirs[i][1] * f.keyDir[1] + f.dirs[i][2] * f.keyDir[2]);
        for (let c = 0; c < 3; c++) expect(Math.abs(f.values[i][c] / (want[c] + 0.08 * f.keyColour[c] * cos ** 4) - 1), `dusk, ${round[i]}° round, channel ${c}`).toBeLessThan(0.1);
      }
      // Looking down under the sun the glow fades with the angle from it: no column of it under the sun.
      for (let k = 6; k < 8; k++) expect(lobe(k)).toBeLessThan(lobe(k - 1));
      expect(lobe(7)).toBeLessThan(0.1 * lobe(0));
    } else {
      // A halo round the moon.
      expect(lobe(0)).toBeGreaterThan(0);
    }
  }
});

/** Directions on a square grid `n` across, `halfDeg` either side of `centre`. */
function around(centre: V3, halfDeg: number, n: number): V3[] {
  const e1 = (() => {
    const c: V3 = [centre[2], 0, -centre[0]];
    const l = Math.hypot(...c) || 1;
    return [c[0] / l, c[1] / l, c[2] / l] as V3;
  })();
  const e2: V3 = [centre[1] * e1[2] - centre[2] * e1[1], centre[2] * e1[0] - centre[0] * e1[2], centre[0] * e1[1] - centre[1] * e1[0]];
  const t = Math.tan((halfDeg * Math.PI) / 180);
  const out: V3[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = ((i + 0.5) / n) * 2 - 1;
      const b = ((j + 0.5) / n) * 2 - 1;
      const d: V3 = [centre[0] + t * (a * e1[0] + b * e2[0]), centre[1] + t * (a * e1[1] + b * e2[1]), centre[2] + t * (a * e1[2] + b * e2[2])];
      const l = Math.hypot(...d);
      out.push([d[0] / l, d[1] / l, d[2] / l]);
    }
  }
  return out;
}
const angleDeg = (a: V3, b: V3) => (Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180) / Math.PI;
const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

test('the moon is drawn in its phase: its lit share of the disc is the sunlit share of a sphere', async ({ page }) => {
  await openHarness(page);
  const moon = direction(100, 30);
  const dirs = around(moon, 0.3, 64);
  // Square to the moon, for turning the sun round it.
  const w: V3 = [moon[1] * 0 - moon[2] * 1, moon[2] * 0 - moon[0] * 0, moon[0] * 1 - moon[1] * 0];
  const lw = Math.hypot(...w);
  const unit: V3 = [w[0] / lw, w[1] / lw, w[2] / lw];
  const shares: number[] = [];
  let fullMean = 0;
  for (const phaseDeg of [0, 45, 90, 135, 180]) {
    // The sun stands 180° less the phase angle from the moon (the moon's elongation).
    const e = ((180 - phaseDeg) * Math.PI) / 180;
    const sun: V3 = [Math.cos(e) * moon[0] + Math.sin(e) * unit[0], Math.cos(e) * moon[1] + Math.sin(e) * unit[1], Math.cos(e) * moon[2] + Math.sin(e) * unit[2]];
    const r = await runCase<{ compileErrors: string[]; values: number[][]; errors: string[] }>(page, 'skyBodies', { dirs, sky: { sunDir: sun, moonDir: moon } });
    expect(r.compileErrors).toEqual([]);
    expect(r.errors).toEqual([]);
    // The disc (radius 0.259°): its edge is hard, and these directions are not jittered.
    const inside = dirs.map((d, i) => [angleDeg(d, moon), lum(r.values[i])] as const).filter(([a]) => a < 0.258);
    if (phaseDeg === 0) fullMean = inside.reduce((s, [, l]) => s + l, 0) / inside.length;
    const lit = inside.filter(([, l]) => l > 0.03 * fullMean).length / inside.length;
    shares.push(lit);
    expect(Math.abs(lit - (1 + Math.cos((phaseDeg * Math.PI) / 180)) / 2), `phase ${phaseDeg}°: lit ${lit.toFixed(3)}`).toBeLessThan(0.05);
  }
  // Full is full and new is dark.
  expect(shares[0]).toBeGreaterThan(0.97);
  expect(shares[4]).toBeLessThan(0.03);
});

test("the sun's disc is brightest at its centre, darker at its limb, and sets into the ground", async ({ page }) => {
  await openHarness(page);
  const high = direction(40, 20);
  const r = await runCase<{ compileErrors: string[]; values: number[][]; errors: string[] }>(page, 'skyBodies', {
    dirs: [high, ...around(high, 0.4, 9).map((d) => d)],
    sky: { sunDir: high, moonDir: [0, -1, 0], sunLight: [1, 1, 1] },
  });
  expect(r.compileErrors).toEqual([]);
  const centre = lum(r.values[0]);
  // A point at 0.9 of the disc's radius (0.267°): limb-darkened, about 0.62 of the centre with u = 0.6.
  const near = around(high, 0.4, 9).findIndex((d) => Math.abs(angleDeg(d, high) - 0.24) < 0.03);
  const sky = lum(r.values[1]);
  expect(centre).toBeGreaterThan(1000 * sky);
  if (near >= 0) expect(lum(r.values[1 + near])).toBeLessThan(0.8 * centre);
  // Set: 1° below the horizon from 2 m, no disc, only the sky's afterglow.
  const set = direction(40, -1);
  const below = await runCase<{ values: number[][] }>(page, 'skyBodies', { dirs: [set, direction(45, -1)], sky: { sunDir: set, moonDir: [0, -1, 0], sunLight: [1, 1, 1] } });
  expect(lum(below.values[0])).toBeLessThan(2 * lum(below.values[1]) + 1e-6);
});

test('the aureole: the sky glows a few degrees round the key light, as cos⁹⁰⁰ of the angle from it', async ({ page }) => {
  await openHarness(page);
  // A white key 30° up; the sky itself dark, so what shows is the glow (and, inside 0.27°, the disc, which these miss).
  const key = direction(40, 30);
  const angles = [0.4, 1, 2, 3, 5, 10];
  const dirs = angles.map((a) => {
    const e = ((30 + a) * Math.PI) / 180;
    const z = (40 * Math.PI) / 180;
    return [Math.sin(z) * Math.cos(e), Math.sin(e), Math.cos(z) * Math.cos(e)] as V3;
  });
  const r = await runCase<{ compileErrors: string[]; values: number[][]; errors: string[] }>(page, 'skyBodies', {
    dirs,
    sky: { sunDir: [0, -1, 0], moonDir: [0, -1, 0], keyDir: key, keyColour: [1, 1, 1], aureole: 10 },
  });
  expect(r.compileErrors).toEqual([]);
  expect(r.errors).toEqual([]);
  angles.forEach((a, i) => {
    const want = 10 * Math.cos((a * Math.PI) / 180) ** 900;
    expect(Math.abs(r.values[i][1] - want), `${a}°: ${r.values[i][1]} for ${want}`).toBeLessThanOrEqual(0.01 * want + 1e-6);
  });
});

test('the stars: a field fixed in the sky at night, a few hundred pixels in a 60° patch, none at noon or in civil twilight', async ({ page }) => {
  test.setTimeout(240_000);
  await openHarness(page);
  const r = await runCase<{ night: { stars: number; shift: number; tracked: number }; noon: { stars: number }; twilight: { stars: number }; errors: string[] }>(page, 'skyStars', { frames: 24 });
  expect(r.errors).toEqual([]);
  console.log(`stars: night ${r.night.stars} pixels, ${r.night.tracked} tracked, shift ${r.night.shift.toFixed(2)} px; noon ${r.noon.stars}; civil twilight ${r.twilight.stars}`);
  expect(r.night.stars).toBeGreaterThanOrEqual(150);
  expect(r.night.stars).toBeLessThanOrEqual(600);
  expect(r.noon.stars).toBe(0);
  expect(r.twilight.stars).toBe(0);
  expect(r.night.tracked).toBeGreaterThan(10);
  expect(r.night.shift).toBeLessThanOrEqual(1);
});
