import { expect, test } from '@playwright/test';
import { openHarness, runCase } from './support/run';

interface Cells {
  cells: number;
  mismatched: number[];
  denseMismatched: number[];
  empty: number;
  refEmpty: number;
  crowd: { reaching: number; count: number; same: boolean };
  ms: number | null;
  errors: string[];
}

test('the light cells list, cell for cell, what the reference lists for 1,024 lights over the map; an empty cell none, a crowded one its 32 nearest', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<Cells>(page, 'lightCells', { seed: 7, runs: 31 });
  expect(r.errors).toEqual([]);
  expect(r.cells).toBe(32 * 32);
  expect(r.mismatched).toEqual([]);
  // And where more lights reach a cell than it gathers at once (200 reaching every cell).
  expect(r.denseMismatched).toEqual([]);
  // Cells no light reaches are emptied of the last build's lights.
  expect(r.refEmpty).toBeGreaterThan(64);
  expect(r.empty).toBe(r.refEmpty);
  expect(r.crowd.reaching).toBeGreaterThan(32);
  expect(r.crowd.count).toBe(32);
  expect(r.crowd.same).toBe(true);
  // The build, a thread a cell over every light: within 0.05 ms.
  if (r.ms !== null) expect(r.ms).toBeLessThanOrEqual(0.05);
  console.log(`light cells build: ${r.ms?.toFixed(4)} ms`);
});
