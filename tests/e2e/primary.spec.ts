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
