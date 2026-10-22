import { expect, test } from '@playwright/test';
import { openHarness, runCase } from './support/run';

interface Result {
  /** The point light (rgb) and key visibility (a), each frame's, averaged. */
  mean: number[];
  keyMin: number;
  /** The sky samples the pixel traced, averaged, and how many. */
  skyMean: number;
  skyTraced: number;
  /** The history's colour after the last frame: sky and point light (rgb), key visibility (a). */
  history: number[];
  skyUp: number[];
  lit: number[][];
  /** Every lighting pixel's point light, over every frame, averaged; whether all were numbers; the lights the reservoirs held (-1 none). */
  imageMean: number[];
  finite: boolean;
  chosen: number[];
  errors: string[];
}

const run = async (page: import('@playwright/test').Page, args: Record<string, unknown>) => {
  await openHarness(page);
  const r = await runCase<Result>(page, 'lighting', args);
  expect(r.errors).toEqual([]);
  return r;
};

test('open ground is lit and sees the sky', async ({ page }) => {
  const r = await run(page, { scene: 'open', frames: 64 });
  expect(Math.abs(r.mean[3] - 1)).toBeLessThanOrEqual(0.001);
  // The sky ray every other frame, and every one finds the sky.
  expect(r.skyTraced).toBe(32);
  expect(r.skyMean).toBe(1);
  for (let c = 0; c < 3; c++) expect(r.mean[c]).toBe(0);
  for (let c = 0; c < 3; c++) expect(Math.abs(r.history[c] - r.skyUp[c])).toBeLessThanOrEqual(0.01 * r.skyUp[c] + 1e-3);
});

test('under a roof is in shadow', async ({ page }) => {
  const r = await run(page, { scene: 'roof', frames: 64, keyElevation: 80 });
  expect(r.mean[3]).toBe(0);
});

test('a sealed box sees no sky', async ({ page }) => {
  const r = await run(page, { scene: 'box', frames: 64 });
  expect(r.skyTraced).toBe(32);
  expect(r.skyMean).toBe(0);
  expect(r.mean[3]).toBe(0);
  // What sky light a face keeps when its ray finds none.
  for (let c = 0; c < 3; c++) expect(Math.abs(r.history[c] - 0.1 * r.skyUp[c])).toBeLessThanOrEqual(0.002 * r.skyUp[c] + 1e-3);
});

test('a lantern behind a wall lights nothing; in the open it follows the falloff', async ({ page }) => {
  const r = await run(page, { scene: 'lantern', frames: 256, keyElevation: 80 });
  const sky = r.skyUp;
  // The middle pixel is open floor: it sees the sky, and of the lanterns only the visible one.
  expect(r.skyMean).toBe(1);
  for (let c = 0; c < 3; c++) expect(Math.abs(r.mean[c] - r.lit[1][c])).toBeLessThanOrEqual(0.05 * r.lit[1][c]);
  for (let c = 0; c < 3; c++) expect(Math.abs(r.history[c] - (sky[c] + r.lit[1][c]))).toBeLessThanOrEqual(0.1 * r.lit[1][c]);
});

test('light picks follow the weights and the estimate is unbiased', async ({ page }) => {
  const r = await run(page, { scene: 'pair', frames: 1024 });
  for (let c = 0; c < 3; c++) {
    const want = r.lit[0][c] + r.lit[1][c];
    expect(Math.abs(r.mean[c] - want)).toBeLessThanOrEqual(0.03 * want);
  }
});

test('a light with no finite weight is never chosen, and the rest are lit as if it were not there', async ({ page }) => {
  const broken = await run(page, { scene: 'broken', frames: 64 });
  const alone = await run(page, { scene: 'single', frames: 64 });
  expect(broken.finite).toBe(true);
  // Light 1 is the one with no finite weight; light 0 is the single scene's.
  expect(broken.chosen).not.toContain(1);
  expect(broken.chosen).toContain(0);
  for (let c = 0; c < 3; c++) expect(Math.abs(broken.imageMean[c] / alone.imageMean[c] - 1)).toBeLessThanOrEqual(0.03);
  expect(broken.mean[3]).toBe(alone.mean[3]);
});

test('a frame takes as many as 1,024 lights, and the last of them lights as it would alone', async ({ page }) => {
  const crowd = await run(page, { scene: 'crowd', frames: 64 });
  const alone = await run(page, { scene: 'single', frames: 64 });
  expect(crowd.lit).toHaveLength(1024);
  expect(alone.mean[0]).toBeGreaterThan(0);
  for (let c = 0; c < 4; c++) expect(crowd.mean[c]).toBe(alone.mean[c]);
});

test('half the lighting pixels trace the sky each frame, in bands of four rows that take turns', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ broken: number; traced: number[]; pixels: number; errors: string[] }>(page, 'skyBands');
  expect(r.errors).toEqual([]);
  expect(r.broken).toBe(0);
  for (const n of r.traced) expect(Math.abs(n / r.pixels - 0.5)).toBeLessThan(0.07);
});

test("a lantern does not frame itself in its own shadow", async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ ring: number; ratio: number; errors: string[] }>(page, 'lanternFrame');
  expect(r.errors).toEqual([]);
  expect(r.ring).toBeGreaterThan(8);
  expect(r.ratio).toBeGreaterThan(0.5);
});
