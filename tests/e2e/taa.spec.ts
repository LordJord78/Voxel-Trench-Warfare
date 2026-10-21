import { expect, test } from '@playwright/test';
import { openHarness, runCase } from './support/run';

test('a still image settles', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ change: number; errors: string[] }>(page, 'taaSettle', { frames: 64 });
  expect(r.errors).toEqual([]);
  expect(r.change).toBeLessThan(0.002);
});

test('a moving edge leaves no trail', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ column: number; trail: number; nowX: number; thenX: number; errors: string[] }>(page, 'taaTrail');
  expect(r.errors).toEqual([]);
  expect(Math.abs(r.nowX - r.thenX)).toBeGreaterThan(10);
  expect(r.column).toBeGreaterThan(0.5);
  expect(r.trail).toBeLessThan(0.05 * r.column);
});

test("the last frame's camera carries the jitter that frame applied", async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ frames: { cam: number[]; prev: number[] }[]; halton: number[][]; errors: string[] }>(page, 'frameJitters');
  expect(r.errors).toEqual([]);
  expect(r.frames.map((f) => f.cam)).toEqual(r.halton);
  // Frame 0 has no past; frames 1 and 2 follow jittered frames; frame 3 follows frame 2, which applied none.
  expect(r.frames.slice(1).map((f) => f.prev)).toEqual([r.halton[0], r.halton[1], [0, 0]]);
});
