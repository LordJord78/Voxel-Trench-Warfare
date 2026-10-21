import { expect, test } from '@playwright/test';
import { openHarness, runCase } from './support/run';

test('the synthetic world uploads exactly', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<Record<string, number> & { errors: string[] }>(page, 'worldUpload');
  expect(r).toEqual({ table: 0, sectors: 0, heap: 0, pyramid: 0, errors: [] });
});

test('the heap grows by reallocating, and keeps every record', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ generation: number; table: number; heap: number; errors: string[] }>(page, 'worldGrowth');
  expect(r.generation).toBeGreaterThanOrEqual(1);
  expect({ table: r.table, heap: r.heap, errors: r.errors }).toEqual({ table: 0, heap: 0, errors: [] });
});
