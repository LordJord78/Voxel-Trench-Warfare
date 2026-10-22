import { expect, test } from '@playwright/test';
import { openHarness, runCase } from './support/run';

interface Summary {
  compileErrors?: string[];
  count: number;
  agree: number;
  hits: number;
  worstT: number;
  worstAngle: number;
  insideHits: number;
  wrong: string[];
  errors: string[];
}

let r: Summary;

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await openHarness(page);
  r = await runCase<Summary>(page, 'farfield', { count: 4096 });
  await page.close();
});

test('far hits match the reference march', () => {
  expect(r.compileErrors ?? []).toEqual([]);
  expect(r.errors).toEqual([]);
  expect(r.hits).toBeGreaterThan(1000);
  expect(r.agree / r.count).toBeGreaterThanOrEqual(0.995);
  expect(r.worstT).toBeLessThan(2.5);
  expect(r.worstAngle).toBeLessThan(3);
});

test('the far field is empty inside the map', () => {
  expect(r.insideHits).toBe(0);
});

test('the far field shades smoothly across its patches', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ worst: number; tilt: number; edgeBad: number; errors: string[] }>(page, 'farSmoothness');
  expect(r.errors).toEqual([]);
  // The ground does slope (it is not flat): the test measures smoothness, not flatness.
  expect(r.tilt).toBeGreaterThan(3);
  // Bilinear patches' slopes jump 1.8° at their edges here; a smooth surface's change 0.2°.
  expect(r.worst).toBeLessThan(0.5);
  // Beside the map's hole, where the stencil reaches samples with no ground, normals stay sane.
  expect(r.edgeBad).toBe(0);
});

test('beside a step, the far field is not shaded as if the ground fell toward it', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ reversed: number; errors: string[] }>(page, 'farStep');
  expect(r.errors).toEqual([]);
  expect(r.reversed).toBeLessThan(1);
});
