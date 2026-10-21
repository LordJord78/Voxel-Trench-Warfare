import { expect, test } from '@playwright/test';
import { hooks, openGame } from './support/app';

// 1600 × 1000 CSS pixels at a device scale of 1: a 1.6 MP canvas, so the
// internal image is the high preset's 1.5 MP.
test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });

const VIEWS = ['bay', 'step', 'nml-night', 'overview', 'dugout', 'hamlet'];
const BUDGET_MS = 14;

test('every standard view renders within the GPU budget at 1.5 MP', async ({ page }) => {
  const errors = await openGame(page);
  // Measured at the high preset's full 1.5 MP: dynamic resolution would hide a slow view.
  await hooks(page, (h) => h.setQuality({ preset: 'high', dynres: false }));
  const first = await hooks(page, (h) => h.stats());
  test.skip(first.gpuMs === null && (await hooks(page, async (h) => (await h.waitFrames(30), h.stats().gpuMs))) === null, 'no timestamp queries on this GPU');
  const timings: Record<string, number> = {};
  for (const name of VIEWS) {
    await hooks(page, (h, n) => h.view(n as string), name);
    await hooks(page, (h) => h.waitFrames(90));
    const s = await hooks(page, (h) => h.stats());
    expect(s.res[0] * s.res[1]).toBeGreaterThan(1.48e6);
    timings[name] = s.gpuMs!;
  }
  console.log(`GPU ms per view: ${JSON.stringify(Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, +v.toFixed(2)])))}`);
  expect(errors).toEqual([]);
  for (const name of VIEWS) expect(timings[name], name).toBeLessThanOrEqual(BUDGET_MS);
});
