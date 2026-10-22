import { expect, test } from '@playwright/test';
import { openHarness, runCase } from './support/run';

interface Summary {
  compileErrors?: string[];
  total: number;
  agree: number;
  ties: number;
  wrong: string[];
  pyramidDiffs: number;
  blockDiffs: number;
  occupancyDiffs: number;
  maxSteps: number;
  grazingStepsOn: number;
  grazingStepsOff: number;
  grazingStepsBlocksOff: number;
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

test("skipping a dense brick's empty 4³ and 2³ blocks changes nothing but the step count", () => {
  console.log(`grazing rays' steps: ${r.grazingStepsOn.toFixed(1)}, without the blocks ${r.grazingStepsBlocksOff.toFixed(1)}`);
  expect(r.blockDiffs).toBe(0);
  expect(r.grazingStepsOn).toBeLessThanOrEqual(0.9 * r.grazingStepsBlocksOff);
});

test('no ray exhausts its steps', () => {
  expect(r.maxSteps).toBeLessThan(2048);
});
