import { expect, test } from '@playwright/test';
import { openHarness, runCase } from './support/run';

interface Summary {
  compileErrors?: string[];
  total: number;
  agree: number;
  ties: number;
  wrong: string[];
  pyramidDiffs: number;
  occupancyDiffs: number;
  maxSteps: number;
  grazingStepsOn: number;
  grazingStepsOff: number;
  errors: string[];
}

let r: Summary;

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await openHarness(page);
  r = await runCase<Summary>(page, 'traverse', { count: 8192 });
  await page.close();
});

test('compiles, without GPU errors', () => {
  expect(r.compileErrors ?? []).toEqual([]);
  expect(r.errors).toEqual([]);
});

test('GPU hits match the reference', () => {
  expect(r.wrong).toEqual([]);
  expect(r.agree / r.total).toBeGreaterThanOrEqual(0.999);
});

test('occupancy rays agree with material rays', () => {
  expect(r.occupancyDiffs).toBe(0);
});

test('pyramid skipping changes nothing but the step count', () => {
  expect(r.pyramidDiffs).toBe(0);
  expect(r.grazingStepsOn).toBeLessThanOrEqual(0.6 * r.grazingStepsOff);
});

test('no ray exhausts its steps', () => {
  expect(r.maxSteps).toBeLessThan(2048);
});
