import { expect, test } from '@playwright/test';
import { openHarness, runCase } from './support/run';

interface Result {
  mean: number[];
  keyMin: number;
  skyUp: number[];
  lit: number[][];
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
  for (let c = 0; c < 3; c++) expect(Math.abs(r.mean[c] - r.skyUp[c])).toBeLessThanOrEqual(0.01 * r.skyUp[c] + 1e-3);
});

test('under a roof is in shadow', async ({ page }) => {
  const r = await run(page, { scene: 'roof', frames: 64, keyElevation: 80 });
  expect(r.mean[3]).toBe(0);
});

test('a sealed box sees no sky', async ({ page }) => {
  const r = await run(page, { scene: 'box', frames: 64 });
  for (let c = 0; c < 3; c++) expect(Math.abs(r.mean[c] - 0.1 * r.skyUp[c])).toBeLessThanOrEqual(0.002 * r.skyUp[c] + 1e-3);
  expect(r.mean[3]).toBe(0);
});

test('a lantern behind a wall lights nothing; in the open it follows the falloff', async ({ page }) => {
  const r = await run(page, { scene: 'lantern', frames: 256, keyElevation: 80 });
  const sky = r.skyUp;
  // The middle pixel is open floor: sky plus the visible lantern only.
  for (let c = 0; c < 3; c++) {
    const want = sky[c] + r.lit[1][c];
    expect(Math.abs(r.mean[c] - want)).toBeLessThanOrEqual(0.05 * r.lit[1][c]);
  }
});

test('light picks follow the weights and the estimate is unbiased', async ({ page }) => {
  const r = await run(page, { scene: 'pair', frames: 1024 });
  for (let c = 0; c < 3; c++) {
    const want = r.skyUp[c] + r.lit[0][c] + r.lit[1][c];
    expect(Math.abs(r.mean[c] - want)).toBeLessThanOrEqual(0.03 * (r.lit[0][c] + r.lit[1][c]));
  }
});
