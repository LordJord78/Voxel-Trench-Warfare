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

test('a browser that refuses sound still starts play, takes the pointer and resumes, silent', async ({ page }) => {
  // The review's case: a context that throws threw out of the click that starts play, before the
  // pointer was locked.
  await page.addInitScript(() => {
    const refuse = function () {
      throw new DOMException('sound refused', 'NotSupportedError');
    };
    Object.defineProperty(window, 'AudioContext', { value: refuse, configurable: true, writable: true });
  });
  const errors = await openGame(page);
  await page.locator('#play').click();
  await page.waitForFunction(() => document.pointerLockElement !== null, null, { timeout: 5000 });
  expect(await hooks(page, (h) => h.mode())).toBe('playing');
  await hooks(page, async (h) => {
    h.trigger(true);
    await h.waitFrames(3);
    h.trigger(false);
    await h.waitFrames(3);
  });
  expect(await hooks(page, (h) => h.audio())).toEqual({ state: 'none', voices: 0 });
  await page.keyboard.press('Escape');
  await expect(page.locator('#pause')).toBeVisible();
  await page.locator('#resume').click();
  await page.waitForFunction(() => document.pointerLockElement !== null, null, { timeout: 5000 });
  expect(await hooks(page, (h) => h.mode())).toBe('playing');
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

test('shells are heard: their whistles, then their blasts', async ({ page }) => {
  const errors = await openGame(page);
  await page.locator('#play').click();
  await hooks(page, (h) => h.waitFrames(10));
  const before = (await hooks(page, (h) => h.audio())).voices;
  // Shelling alone, heavy: about a shell a second, each a whistle and 1.5 s on a blast.
  await hooks(page, async (h) => {
    h.setShelling('heavy');
    await new Promise((resolve) => setTimeout(resolve, 3500));
    h.setShelling('off');
  });
  const after = (await hooks(page, (h) => h.audio())).voices;
  expect(after - before).toBeGreaterThanOrEqual(2);
  expect(errors).toEqual([]);
});
