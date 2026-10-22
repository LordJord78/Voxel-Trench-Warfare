import { expect, test } from '@playwright/test';
import { openHarness, runCase } from './support/run';

test('a still view converges without bias', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ worst: number; change: number; errors: string[] }>(page, 'denoiseConverge', { frames: 96, reference: 1024 });
  expect(r.errors).toEqual([]);
  expect(r.worst).toBeLessThanOrEqual(0.05);
  expect(r.change).toBeLessThan(0.01);
});

test("the sky's history, traced every other frame, averages its samples without bias", async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ compared: number; bias: number; mae: number; errors: string[] }>(page, 'skyHistory', { frames: 96, reference: 512 });
  expect(r.errors).toEqual([]);
  expect(r.compared).toBeGreaterThan(500);
  expect(Math.abs(r.bias)).toBeLessThan(0.01);
  // A history of 16 sky samples of a visibility near one half wanders by about 0.09.
  expect(r.mae).toBeLessThan(0.1);
});

test("the key light's history, traced every other frame, averages its samples without bias", async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ compared: number; bias: number; mae: number; errors: string[] }>(page, 'keyHistory', { frames: 96, reference: 512 });
  expect(r.errors).toEqual([]);
  expect(r.compared).toBeGreaterThan(500);
  expect(Math.abs(r.bias)).toBeLessThan(0.01);
  // As the sky's: some 16 samples of a visibility near one half wander by about 0.09.
  expect(r.mae).toBeLessThan(0.1);
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

test('the à-trous filter gives the same image however it reads its tile', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ colourUlps: number; varianceRel: number; errors: string[] }>(page, 'atrousIdentity');
  expect(r.errors).toEqual([]);
  expect(r.colourUlps).toBeLessThanOrEqual(1);
  expect(r.varianceRel).toBeLessThan(1e-5);
});

test('far off, the filter blends a pixel\'s ground with nothing from a wall or the sky beside it, though their planes have the same number', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ worst: number; errors: string[] }>(page, 'atrousFarFaces');
  expect(r.errors).toEqual([]);
  expect(r.worst).toBe(0);
});

test('the history takes a pixel\'s rough ground far off as one surface, but never the sky or the far field', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ answers: Record<string, boolean>; errors: string[] }>(page, 'sameSpotFaces');
  expect(r.errors).toEqual([]);
  expect(r.answers).toEqual({
    'same face and plane, near': true,
    'the next plane, near': false,
    'two planes off, far': true,
    'another face, far': true,
    'another face, near': false,
    'the far field, far': false,
    'the sky, far': false,
  });
});
