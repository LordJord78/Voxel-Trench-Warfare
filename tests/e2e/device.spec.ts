import { expect, test } from '@playwright/test';
import { openHarness, runCase } from './support/run';

test('a compute shader runs and reads back', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ values: number[]; errors: string[] }>(page, 'device');
  expect(r.values).toEqual(Array.from({ length: 64 }, (_, i) => i * i));
  expect(r.errors).toEqual([]);
});
