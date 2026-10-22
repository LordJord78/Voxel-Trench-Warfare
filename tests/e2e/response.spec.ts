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
