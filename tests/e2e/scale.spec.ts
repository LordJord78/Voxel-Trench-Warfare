import { expect, test } from '@playwright/test';
import { openHarness, runCase } from './support/run';

interface ScaleChange {
  before: number;
  after: number;
  keptBefore: number;
  kept: number;
  res: [number, number];
  reset: boolean;
  errors: string[];
}

for (const scale of [0.75, 0.5]) {
  test(`dropping to ${scale * 100}% scale keeps both histories, in place`, async ({ page }) => {
    await openHarness(page);
    const r = await runCase<ScaleChange>(page, 'scaleChange', { scale, frames: 40 });
    expect(r.errors).toEqual([]);
    expect(r.res).toEqual([Math.round(128 * scale), Math.round(96 * scale)]);
    expect(r.reset).toBe(false);
    // Converged: every lighting pixel on the world has history.
    expect(r.keptBefore).toBeGreaterThan(0.99);
    expect(r.kept).toBeGreaterThan(0.9);
    // A history read from the wrong place is clamped toward the new frame, but it still shows at
    // every stripe: read in place it strays 1.2 to 1.7 times as far as a still image does, misplaced 3 to 4.
    expect(r.after).toBeLessThan(2.5 * r.before);
  });
}

test('the present pass shows only the image, not the stale texels around it', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ worst: number; errors: string[] }>(page, 'presentCrop', { c: 0.5, stale: 4 });
  expect(r.errors).toEqual([]);
  expect(r.worst).toBeLessThanOrEqual(1.01);
});
