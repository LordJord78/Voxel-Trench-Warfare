import { expect, test, type Page } from '@playwright/test';
import { hooks, openGame } from './support/app';

// Fullscreen while in the browser (ui/fullscreen.ts): the start screen's and the pause menu's
// Fullscreen buttons, and Alt+Enter, take the whole page fullscreen (the menus with it, not the
// canvas alone) and back, and each button says which way a click goes. Where this browser cannot go
// fullscreen at all, the tests say so and skip.

/** Whether the whole page is fullscreen: the document's root, not the canvas. */
const pageFullscreen = (page: Page) => page.evaluate(() => document.fullscreenElement === document.documentElement);
/** Whether nothing is fullscreen. */
const nothingFullscreen = (page: Page) => page.evaluate(() => document.fullscreenElement === null);

/** Skipped where the browser has no fullscreen to give. */
async function needFullscreen(page: Page): Promise<void> {
  const enabled = await page.evaluate(() => document.fullscreenEnabled);
  test.skip(!enabled, 'this browser cannot go fullscreen here: document.fullscreenEnabled is false');
}

test("the start screen's Fullscreen button takes the page fullscreen, and back", async ({ page }) => {
  const errors = await openGame(page);
  await needFullscreen(page);
  const button = page.locator('#start-fullscreen');
  await expect(button).toBeVisible();
  await expect(button).toHaveText(/^Fullscreen · /);
  await button.click();
  await expect.poll(() => pageFullscreen(page), { timeout: 2_000 }).toBe(true);
  await expect(button).toHaveText(/^Leave fullscreen · /);
  // The page went fullscreen, so the start screen is still over the world.
  await expect(page.locator('#play')).toBeVisible();
  expect(await hooks(page, (h) => h.mode())).toBe('ready');
  await button.click();
  await expect.poll(() => nothingFullscreen(page), { timeout: 2_000 }).toBe(true);
  await expect(button).toHaveText(/^Fullscreen · /);
  expect(errors).toEqual([]);
});

test("the pause menu's Fullscreen button takes the page fullscreen, and back, the menu open throughout", async ({ page }) => {
  const errors = await openGame(page);
  await needFullscreen(page);
  await page.locator('#play').click();
  await expect(page.locator('#loading')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('#pause')).toBeVisible();
  const button = page.locator('#pause-fullscreen');
  await expect(button).toHaveText(/^Fullscreen · /);
  await button.click();
  await expect.poll(() => pageFullscreen(page), { timeout: 2_000 }).toBe(true);
  await expect(button).toHaveText(/^Leave fullscreen · /);
  await expect(page.locator('#pause')).toBeVisible();
  expect(await hooks(page, (h) => h.mode())).toBe('paused');
  await button.click();
  await expect.poll(() => nothingFullscreen(page), { timeout: 2_000 }).toBe(true);
  await expect(button).toHaveText(/^Fullscreen · /);
  await expect(page.locator('#pause')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Alt+Enter takes the page fullscreen, and back, from the start screen without starting play', async ({ page }) => {
  const errors = await openGame(page);
  await needFullscreen(page);
  await page.keyboard.press('Alt+Enter');
  await expect.poll(() => pageFullscreen(page), { timeout: 2_000 }).toBe(true);
  await expect(page.locator('#start-fullscreen')).toHaveText(/^Leave fullscreen · /);
  // Play has the focus, but Alt+Enter is fullscreen's alone.
  expect(await hooks(page, (h) => h.mode())).toBe('ready');
  await page.keyboard.press('Alt+Enter');
  await expect.poll(() => nothingFullscreen(page), { timeout: 2_000 }).toBe(true);
  expect(errors).toEqual([]);
});
