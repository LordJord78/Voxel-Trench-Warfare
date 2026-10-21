import { expect, test } from '@playwright/test';
import { openHarness, runCase } from './support/run';

interface Summary {
  compared: number;
  agree: number;
  ties: number;
  sky: number;
  hits: number;
  wrong: string[];
  motionError: number;
  errors: string[];
}

let r: Summary;

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await openHarness(page);
  r = await runCase<Summary>(page, 'primary');
  await page.close();
});

test('the G-buffer matches reference rays', () => {
  expect(r.errors).toEqual([]);
  expect(r.wrong).toEqual([]);
  expect(r.sky).toBeGreaterThan(20);
  expect(r.hits).toBeGreaterThan(200);
  expect(r.agree / r.compared).toBeGreaterThanOrEqual(0.99);
});

test('motion vectors match the camera move', () => {
  expect(r.motionError).toBeLessThan(0.05);
});

test('the beam changes where rays start, never what they hit', async ({ page }) => {
  await openHarness(page);
  const b = await runCase<{ compared: number; differ: number; beyond: number; insideNonZero: number; elevatedStart: number; firstDiffs: string[]; errors: string[] }>(page, 'beamIdentity');
  expect(b.errors).toEqual([]);
  expect(b.compared).toBe(4 * 128 * 128);
  expect(b.firstDiffs).toEqual([]);
  expect(b.differ).toBe(0);
  expect(b.beyond).toBe(0);
  // Standing in the roofed box, below every column top: the beam must not move any start.
  expect(b.insideNonZero).toBe(0);
  // From 7 m over the field, rays begin most of the way down: the beam is doing something.
  expect(b.elevatedStart).toBeGreaterThan(40);
});
