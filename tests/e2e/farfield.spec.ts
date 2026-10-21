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
