import { expect, test } from '@playwright/test';
import { openHarness, runCase } from './support/run';

test('a still view converges without bias', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ worst: number; change: number; errors: string[] }>(page, 'denoiseConverge', { frames: 96, reference: 1024 });
  expect(r.errors).toEqual([]);
  expect(r.worst).toBeLessThanOrEqual(0.05);
  expect(r.change).toBeLessThan(0.01);
});

test('history restarts where the view uncovers', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ hidden: number; hiddenFresh: number; seen: number; seenOld: number; errors: string[] }>(page, 'denoiseDisocclusion');
  expect(r.errors).toEqual([]);
  expect(r.hidden).toBeGreaterThan(10);
  expect(r.hiddenFresh / r.hidden).toBeGreaterThan(0.95);
  expect(r.seenOld / r.seen).toBeGreaterThan(0.95);
});

test('filters do not bleed across faces', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ worstWall: number; wallNearFloor: number; errors: string[] }>(page, 'denoiseEdges');
  expect(r.errors).toEqual([]);
  expect(r.wallNearFloor).toBeGreaterThan(10);
  expect(r.worstWall).toBeLessThan(0.05);
});

test('a reset clears the history', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ surfaces: number; longest: number; errors: string[] }>(page, 'denoiseReset');
  expect(r.errors).toEqual([]);
  expect(r.surfaces).toBeGreaterThan(100);
  expect(r.longest).toBe(1);
});

test('a fresh history in a penumbra is filtered by its neighbours, not left as raw 0s and 1s', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ penumbra: number; binary: number; error: number; errors: string[] }>(page, 'denoiseFresh');
  expect(r.errors).toEqual([]);
  expect(r.penumbra).toBeGreaterThan(30);
  // Unfiltered, every one was a raw 0 or 1, 0.45 from the converged value on average.
  expect(r.binary / r.penumbra).toBeLessThan(0.3);
  expect(r.error).toBeLessThan(0.35);
});
