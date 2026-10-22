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

test('ReSTIR\'s point light over the floor, 64 frames of it, has the mean of the lights\' own sum, within 5%, colour by colour', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ mean: number[]; want: number[]; errors: string[] }>(page, 'restirMean', { frames: 64 });
  console.log(`ReSTIR mean over the floor: ${r.mean.map((v, c) => (v / r.want[c]).toFixed(4)).join(', ')} of the sum`);
  expect(r.errors).toEqual([]);
  for (let c = 0; c < 3; c++) expect(Math.abs(r.mean[c] / r.want[c] - 1)).toBeLessThanOrEqual(0.05);
});

test('a light moved between frames is weighed where it is now: its light the next frame is its light from there, and none once out of reach', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ there: number[]; want: number[]; gone: number[]; errors: string[] }>(page, 'restirMoved');
  expect(r.errors).toEqual([]);
  for (let c = 0; c < 3; c++) expect(Math.abs(r.there[c] / r.want[c] - 1)).toBeLessThanOrEqual(0.01);
  expect(r.gone).toEqual([0, 0, 0]);
});

test('a light that comes within reach is lit in full the frame it arrives, though no history had it', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ arrived: number[]; want: number[]; errors: string[] }>(page, 'restirArrived');
  expect(r.errors).toEqual([]);
  console.log(`arrived: ${r.arrived.map((v, c) => (v / r.want[c]).toFixed(4)).join(', ')} of a floor lit by both from the start`);
  for (let c = 0; c < 3; c++) expect(Math.abs(r.arrived[c] / r.want[c] - 1)).toBeLessThanOrEqual(0.05);
});

test('each lighting pixel keeps a reservoir from frame to frame: 8 candidates a frame, its history capped at 160, started afresh on a reset', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ seen: { light: number; weight: number; count: number }[]; sound: boolean; errors: string[] }>(page, 'restirReservoirs', { frames: 40, reset: 30 });
  expect(r.errors).toEqual([]);
  expect(r.sound).toBe(true);
  const counts = r.seen.map((s) => s.count);
  // The first frame has no history; then each adds its 8 to a history of at most 160.
  expect(counts.slice(0, 4)).toEqual([8, 16, 24, 32]);
  expect(counts.slice(25, 30)).toEqual([168, 168, 168, 168, 168]);
  expect(counts.slice(30, 33)).toEqual([8, 16, 24]);
  for (const s of r.seen) {
    expect(s.light).toBeGreaterThanOrEqual(0);
    expect(s.weight).toBeGreaterThan(0);
  }
});
