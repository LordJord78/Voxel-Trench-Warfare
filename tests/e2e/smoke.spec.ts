import { expect, test } from '@playwright/test';
import { hooks, openGame } from './support/app';

test('the world renders', async ({ page }) => {
  const errors = await openGame(page);
  expect(await hooks(page, (h) => h.error ?? null)).toBeNull();
  await hooks(page, (h) => h.waitFrames(10));
  const shot = await hooks(page, (h) => h.snapshot());
  expect(errors).toEqual([]);
  expect(shot.std).toBeGreaterThan(4 / 255);
});
