import { expect, test } from '@playwright/test';
import { P } from '../../src/world/materials';
import type { Region } from './cases/shade';
import { openHarness, runCase } from './support/run';

interface Result {
  results: { got: number[]; want: number[]; fog: number[] }[];
  errors: string[];
}

const POSE = { position: [3.2, 17.6, 3.2] as [number, number, number], yaw: 0, pitch: -10 };
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const region = (mat: number, face: number, depth: number, light: [number, number, number, number], cell: [number, number, number] = [37, 160, 52]): Region => ({ mat, face, cell, depth, light });

async function shade(page: import('@playwright/test').Page, regions: Region[], pose = POSE, sky: Record<string, unknown> = {}) {
  await openHarness(page);
  const r = await runCase<Result>(page, 'shade', { regions, pose, sky });
  expect(r.errors).toEqual([]);
  return r.results;
}

const close = (got: number[], want: number[]) => {
  for (let c = 0; c < 3; c++) expect(Math.abs(got[c] - want[c]), `channel ${c}: ${got} vs ${want}`).toBeLessThanOrEqual(2e-3 * Math.abs(want[c]) + 2e-4);
};

test('surfaces shade to the formula', async ({ page }) => {
  const regions: Region[] = [
    region(P.SOD, 3, 40, [0.1, 0.12, 0.2, 1]),
    region(P.SOD, 3, 40, [0.1, 0.12, 0.2, 0]),
    region(P.BRICK, 4, 120, [0.05, 0.06, 0.09, 0.5], [12, 170, 80]),
    region(P.TIMBER, 1, 60, [0.2, 0.15, 0.1, 1], [5, 150, 9]),
    region(P.TIMBER, 0, 60, [0.2, 0.15, 0.1, 1], [6, 150, 9]),
    region(P.SANDBAG, 5, 30, [0.3, 0.2, 0.1, 0.25], [100, 161, 3]),
    region(P.SANDBAG, 2, 30, [0.02, 0.02, 0.03, 0], [101, 161, 3]),
    region(P.WATER, 3, 300, [0.08, 0.09, 0.12, 1], [64, 125, 300]),
    region(P.LANTERN_GLOW, 4, 25, [0.0, 0.0, 0.0, 0], [8, 130, 8]),
    region(P.SOD, 7, 1e9, [0, 0, 0, 0]),
    region(P.BRICK, 2, 900, [0.1, 0.1, 0.1, 1], [2000, 170, 1500]),
    region(P.SOD, 3, 2000, [0.1, 0.12, 0.2, 1]),
    region(P.MUD, 3, 15, [0.4, 0.3, 0.2, 1], [1, 1, 1]),
    region(P.CLAY, 0, 80, [0.25, 0.2, 0.15, 0.75], [999, 99, 9]),
    region(P.CORRUGATE, 5, 45, [0.2, 0.2, 0.25, 1], [55, 66, 77]),
    region(P.CONCRETE, 1, 70, [0.3, 0.3, 0.3, 0.5], [7, 8, 9]),
  ];
  const results = await shade(page, regions);
  for (const r of results) close(r.got, r.want);
});

test('fog thickens with distance and thins with height', async ({ page }) => {
  const near = region(P.SOD, 3, 100, [0.1, 0.12, 0.2, 1]);
  const far = region(P.SOD, 3, 2000, [0.1, 0.12, 0.2, 1]);
  const low = await shade(page, [near, far, ...Array(14).fill(near)]);
  expect(dist(low[1].got, low[1].fog)).toBeLessThan(dist(low[0].got, low[0].fog));
  const high = await shade(page, [near, far, ...Array(14).fill(near)], { ...POSE, position: [3.2, 47.6, 3.2] });
  expect(dist(high[1].got, high[1].fog)).toBeGreaterThan(dist(low[1].got, low[1].fog));
  for (const r of [...low, ...high]) close(r.got, r.want);
});

test('water reflects more sky at grazing angles', async ({ page }) => {
  // The top row of regions looks out near the horizon, the bottom row steeply down.
  const water = region(P.WATER, 3, 50, [0.05, 0.05, 0.06, 1], [64, 125, 64]);
  const results = await shade(page, Array(16).fill(water), { ...POSE, pitch: -40 }, { fogDensity: 0 });
  const top = results[0].got;
  const bottom = results[12].got;
  expect(top[2]).toBeGreaterThan(bottom[2]);
  for (const r of results) close(r.got, r.want);
});

test('emission shows in the dark', async ({ page }) => {
  const glass = region(P.LANTERN_GLOW, 4, 25, [0, 0, 0, 0], [8, 130, 8]);
  const results = await shade(page, Array(16).fill(glass), POSE, { keyColour: [0, 0, 0], fogDensity: 0, moonColour: [0, 0, 0] });
  for (const r of results) {
    close(r.got, r.want);
    expect(r.got[0]).toBeGreaterThan(1);
  }
});
