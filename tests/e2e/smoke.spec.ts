import { expect, test } from '@playwright/test';
import { hooks, openGame } from './support/app';
import { openHarness, runCase } from './support/run';

test('the world renders', async ({ page }) => {
  const errors = await openGame(page);
  expect(await hooks(page, (h) => h.error ?? null)).toBeNull();
  await hooks(page, (h) => h.waitFrames(10));
  const shot = await hooks(page, (h) => h.snapshot());
  expect(errors).toEqual([]);
  expect(shot.std).toBeGreaterThan(4 / 255);
});

test('the world renders at night', async ({ page }) => {
  const errors = await openGame(page);
  await hooks(page, (h) => h.view('nml-night'));
  await hooks(page, (h) => h.waitFrames(30));
  const shot = await hooks(page, (h) => h.snapshot());
  expect(errors).toEqual([]);
  // Flares and moonlight: not a black frame.
  expect(shot.std).toBeGreaterThan(4 / 255);
});

interface Gathered {
  compared: number;
  through: number;
  full: number;
  maxError: number;
  wrong: string[];
  crowded: { count: number; gathered: number; every: number; nearestSixteen: number };
  errors: string[];
}

test("the haze's smoke is the same gathered once a column as slice by slice", async ({ page }) => {
  await openHarness(page);
  const r = await runCase<Gathered>(page, 'smokeGather');
  console.log(`smoke gathered: ${r.compared} compared (${r.through} through smoke, ${r.full} columns full), worst ${r.maxError.toExponential(2)}`);
  expect(r.errors).toEqual([]);
  expect(r.wrong).toEqual([]);
  expect(r.through).toBeGreaterThan(200);
  expect(r.compared).toBeGreaterThan(3500);
  expect(r.maxError).toBeLessThan(1e-4);
  // Twenty puffs on one ray: it takes the nearest sixteen, and leaves the farthest four's smoke out.
  expect(r.crowded.count).toBe(16);
  expect(Math.abs(r.crowded.gathered - r.crowded.nearestSixteen) / r.crowded.nearestSixteen).toBeLessThan(1e-4);
  expect(r.crowded.every - r.crowded.gathered).toBeGreaterThan(0.5);
});

test('the haze takes 64 puffs a frame on high, 32 on low', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ high: number; low: number; errors: string[] }>(page, 'smokePresets');
  expect(r.errors).toEqual([]);
  expect(r.high).toBe(64);
  expect(r.low).toBe(32);
});
