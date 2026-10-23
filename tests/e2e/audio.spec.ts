import { expect, test } from '@playwright/test';
import { hooks, openGame } from './support/app';

// Sound starts with the click that starts play (no context before: the browser would refuse it),
// a shot is heard, and the pause menu silences the game.

test('sound starts with the click that starts play, and a shot is heard', async ({ page }) => {
  const errors = await openGame(page);
  expect((await hooks(page, (h) => h.audio())).state).toBe('none');
  await page.locator('#play').click();
  await hooks(page, (h) => h.waitFrames(10));
  const started = await hooks(page, (h) => h.audio());
  expect(started.state).toBe('running');
  await hooks(page, async (h) => {
    h.trigger(true);
    await h.waitFrames(3);
    h.trigger(false);
    await h.waitFrames(3);
  });
  const after = await hooks(page, (h) => h.audio());
  expect(after.voices).toBeGreaterThan(started.voices);
  expect(errors).toEqual([]);
});

test('paused, the sound is suspended, and comes back on resuming', async ({ page }) => {
  const errors = await openGame(page);
  await page.locator('#play').click();
  await hooks(page, (h) => h.waitFrames(10));
  await page.keyboard.press('Escape');
  await hooks(page, (h) => h.waitFrames(10));
  expect((await hooks(page, (h) => h.audio())).state).toBe('suspended');
  await page.locator('#resume').click();
  await hooks(page, (h) => h.waitFrames(10));
  expect((await hooks(page, (h) => h.audio())).state).toBe('running');
  expect(errors).toEqual([]);
});
