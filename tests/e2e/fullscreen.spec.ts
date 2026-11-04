import { expect, test, type Page } from '@playwright/test';
import { hooks, openGame } from './support/app';

// Fullscreen while in the browser (ui/fullscreen.ts): the start screen's and the pause menu's
// Fullscreen buttons, and Alt+Enter, take the whole page fullscreen (the menus with it, not the
// canvas alone) and back, each button saying which way a click goes and leaving the focus on Play
// or Resume. Fullscreen where the keyboard can be locked (Chrome), Esc still pauses and the page
// stays fullscreen; held down, it leaves. The game stopping leaves fullscreen. Where this browser
// cannot go fullscreen at all, the tests say why and skip.

/** Whether the whole page is fullscreen: the document's root, not the canvas. */
const pageFullscreen = (page: Page) => page.evaluate(() => document.fullscreenElement === document.documentElement);
/** Whether nothing is fullscreen. */
const nothingFullscreen = (page: Page) => page.evaluate(() => document.fullscreenElement === null);

/**
 * Skipped where this browser gives the page no fullscreen, as the browser itself answers and not the
 * game, whose faults must fail: none at all, or a request refused or left unanswered for 2 s (as
 * headless Chrome may, while it says fullscreen is enabled). Playwright's evaluate counts as the
 * click a request needs. First, the page must be this branch's: playwright.config.ts reuses a dev
 * server already on :5320, which may be another checkout's.
 */
async function needFullscreen(page: Page): Promise<void> {
  await expect(page.locator('#start-fullscreen'), "the page served has no Fullscreen button: is the dev server on :5320 another checkout's?").toHaveCount(1);
  const refused = await page.evaluate(async () => {
    if (!document.fullscreenEnabled) return 'document.fullscreenEnabled is false';
    const asked = document.documentElement.requestFullscreen().then(
      () => null,
      (e: unknown) => `a request was refused (${String(e)})`,
    );
    const unanswered = new Promise<string>((resolve) => setTimeout(() => resolve('a request went unanswered for 2 s'), 2_000));
    const why = await Promise.race([asked, unanswered]);
    if (why === null) await document.exitFullscreen().catch(() => {});
    return why;
  });
  test.skip(refused !== null, `this browser cannot go fullscreen here: ${refused}`);
  await expect.poll(() => nothingFullscreen(page), { timeout: 2_000 }).toBe(true);
  // The game has seen the page go and come back.
  await expect(page.locator('#start-fullscreen')).toHaveText(/^Fullscreen · /);
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
  // The page went fullscreen, so the start screen is still over the world, and Play keeps the
  // focus: Enter or Space still plays.
  await expect(page.locator('#play')).toBeVisible();
  await expect(page.locator('#play')).toBeFocused();
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
  // Resume keeps the focus: Enter or Space still resumes.
  await expect(page.locator('#resume')).toBeFocused();
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

test('fullscreen where the keyboard can be locked, Esc pauses and the page stays fullscreen; held down, Esc leaves', async ({ page }) => {
  const errors = await openGame(page);
  await needFullscreen(page);
  const lockable = await page.evaluate(() => typeof navigator.keyboard?.lock === 'function');
  test.skip(!lockable, 'this browser has no keyboard lock (navigator.keyboard.lock): its Esc leaves fullscreen, as it should');
  await page.locator('#start-fullscreen').click();
  await expect.poll(() => pageFullscreen(page), { timeout: 2_000 }).toBe(true);
  await page.locator('#play').click();
  await expect(page.locator('#loading')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('#pause')).toBeVisible();
  expect(await hooks(page, (h) => h.mode())).toBe('paused');
  // A browser that took that Esc for itself would have the page out of fullscreen by now.
  await page.waitForTimeout(1_000);
  expect(await pageFullscreen(page)).toBe(true);
  await expect(page.locator('#pause-fullscreen')).toHaveText(/^Leave fullscreen · /);
  // Held down (the browser's rule: a second and a half), Esc leaves fullscreen, the menu still open.
  await page.keyboard.down('Escape');
  await page.waitForTimeout(2_500);
  await page.keyboard.up('Escape');
  await expect.poll(() => nothingFullscreen(page), { timeout: 2_000 }).toBe(true);
  await expect(page.locator('#pause-fullscreen')).toHaveText(/^Fullscreen · /);
  await expect(page.locator('#pause')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the game stopping while fullscreen (the graphics device lost) leaves fullscreen: its buttons are gone, and Esc is the browser’s again', async ({ page }) => {
  await openGame(page);
  await needFullscreen(page);
  await page.locator('#start-fullscreen').click();
  await expect.poll(() => pageFullscreen(page), { timeout: 2_000 }).toBe(true);
  await hooks(page, (h) => h.loseDevice());
  await expect(page.locator('#status')).toContainText('The graphics device was lost');
  await expect.poll(() => nothingFullscreen(page), { timeout: 2_000 }).toBe(true);
});
