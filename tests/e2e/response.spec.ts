import { expect, test } from '@playwright/test';
import { openHarness, runCase } from './support/run';

// The camera's response (light milestone 3): bloom, the exposure that adapts, grain.

interface BloomResult {
  worst: number;
  energy: number;
  row: number[];
  bad: number;
  errors: string[];
}

test("the bloom pyramid matches its reference and keeps the image's energy", async ({ page }) => {
  await openHarness(page);
  const r = await runCase<BloomResult>(page, 'bloom', { w: 1024, h: 768, noise: 0.02, point: 30000 });
  expect(r.errors).toEqual([]);
  console.log(`bloom: worst ${r.worst.toFixed(3)} of its tolerance, energy ${r.energy.toFixed(5)}`);
  expect(r.bad).toBe(0);
  expect(r.worst).toBeLessThan(1);
  expect(Math.abs(r.energy - 1)).toBeLessThan(0.01);
});

test('with dynamic resolution only the rendered part blooms, whatever lies beyond it', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<BloomResult>(page, 'bloom', { w: 1024, h: 768, res: [700, 500], noise: 0.02, point: 30000, outside: 60000 });
  expect(r.errors).toEqual([]);
  expect(r.bad).toBe(0);
  expect(r.worst).toBeLessThan(1);
  expect(Math.abs(r.energy - 1)).toBeLessThan(0.01);
});

test("the sun's disc spreads into a halo: falling outward, never negative", async ({ page }) => {
  await openHarness(page);
  const r = await runCase<BloomResult>(page, 'bloom', { w: 1024, h: 768, noise: 0, point: 30000 });
  expect(r.errors).toEqual([]);
  expect(r.bad).toBe(0);
  for (let i = 1; i < r.row.length; i++) expect(r.row[i], `${i} out`).toBeLessThanOrEqual(r.row[i - 1] * 1.002 + 1e-6);
  expect(Math.min(...r.row)).toBeGreaterThanOrEqual(0);
  // Light 48 pixels out (24 at half resolution).
  expect(r.row[24]).toBeGreaterThan(0);
});

test('the meter counts the frame as the CPU does: finite, positive texels only, and only the rendered part', async ({ page }) => {
  await openHarness(page);
  for (const [res, base] of [[undefined, 1], [[154, 92], 1], [undefined, 3.2]] as const) {
    const r = await runCase<{ counts: number[]; ref: number[]; errors: string[] }>(page, 'histogram', { w: 256, h: 160, res, base });
    expect(r.errors).toEqual([]);
    expect(r.counts, `res ${res}, base ${base}`).toEqual(r.ref);
  }
});

test('the exposure adapts at its rates: down three stops a second to a brighter scene, up one to a darker, and a reset lands at once', async ({ page }) => {
  await openHarness(page);
  // The norm at 0 stops, a zone of a stop round it; a scene 3.5 stops over the norm, back to it, and a reset.
  const steps = [
    { stops: 0.0625, frames: 10, reset: true },
    { stops: 3.5625, frames: 70 },
    { stops: 0.0625, frames: 170 },
    { stops: 3.5625, frames: 2, reset: true },
  ];
  const r = await runCase<{ got: { correction: number; want: number; exposure: number }[]; ref: { correction: number; want: number }[]; errors: string[] }>(page, 'adaptation', {
    steps, target: 0, zone: 1, rise: 1, fall: 3, bias: 0.5,
  });
  expect(r.errors).toEqual([]);
  r.got.forEach((g, f) => {
    expect(Math.abs(g.correction - r.ref[f].correction), `frame ${f}`).toBeLessThan(1e-4);
    expect(Math.abs(g.want - r.ref[f].want), `frame ${f}`).toBeLessThan(1e-4);
    // Presented: the hour's bias times the base (1) times 2^correction.
    expect(Math.abs(g.exposure / (0.5 * 2 ** g.correction) - 1), `frame ${f}`).toBeLessThan(1e-5);
  });
  // Down at 3 stops a second: 2.5625 stops in 52 frames, never faster; up again at 1 a second.
  expect(r.got[10 + 25].correction).toBeCloseTo(-26 * 0.05, 4);
  expect(r.got[10 + 52].correction).toBeCloseTo(-2.5625, 4);
  expect(r.got[80 + 59].correction).toBeCloseTo(-2.5625 + 60 / 60, 4);
  expect(r.got[80 + 160].correction).toBeCloseTo(0, 4);
  // A reset lands on the want at once.
  expect(r.got[250].correction).toBeCloseTo(-2.5625, 4);
});

interface Grain {
  key: number;
  a: number[];
  b: number[];
  none: number[];
  errors: string[];
}

const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
const deviation = (x: number[]) => {
  const m = mean(x);
  return Math.sqrt(mean(x.map((v) => (v - m) ** 2)));
};

/** The mean power of a 64 × 64 field's modes whose frequency (cycles across it) lies in (lo, hi]. */
function band(field: number[], lo: number, hi: number): number {
  const n = 64;
  const m = mean(field);
  let sum = 0;
  let modes = 0;
  for (let v = -n / 2; v < n / 2; v++) {
    for (let u = -n / 2; u < n / 2; u++) {
      const r = Math.hypot(u, v);
      if (r <= lo || r > hi) continue;
      let re = 0;
      let im = 0;
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const a = (-2 * Math.PI * (u * x + v * y)) / n;
          const f = field[y * n + x] - m;
          re += f * Math.cos(a);
          im += f * Math.sin(a);
        }
      }
      sum += re * re + im * im;
      modes++;
    }
  }
  return sum / modes;
}

test('grain is blue, keyed to the hour, and moves', async ({ page }) => {
  test.setTimeout(240_000);
  await openHarness(page);
  const shifts = [[13, 41], [50, 7]];
  const night = await runCase<Grain>(page, 'grain', { hours: 21, shifts });
  expect(night.errors).toEqual([]);
  // The grain alone: the same image, dithered the same, less the image without it.
  const a = night.a.map((v, i) => v - night.none[i]);
  const b = night.b.map((v, i) => v - night.none[i]);
  const [low, high] = [band(a, 0, 8), band(a, 24, 32)];
  const ma = mean(a);
  const mb = mean(b);
  const correlation = mean(a.map((v, i) => (v - ma) * (b[i] - mb))) / (deviation(a) * deviation(b));
  console.log(`grain at night: key ${night.key} steps, deviation ${deviation(a).toFixed(2)}; low against high frequencies ${(low / high).toFixed(3)}; two frames correlated ${correlation.toFixed(3)}`);
  expect(Math.abs(deviation(a) / night.key - 1)).toBeLessThan(0.1);
  expect(low / high).toBeLessThan(0.2);
  expect(Math.abs(correlation)).toBeLessThan(0.2);
  // By day, below the dither's step.
  const noon = await runCase<Grain>(page, 'grain', { hours: 12, shifts });
  expect(noon.errors).toEqual([]);
  expect(deviation(noon.a.map((v, i) => v - noon.none[i]))).toBeLessThan(1);
});
