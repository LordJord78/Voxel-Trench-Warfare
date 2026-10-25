import { expect, test } from '@playwright/test';
import { hooks, openGame } from './support/app';

// Quality tiers (the showcase spec's §4): the visitor's own choice of preset is kept and never
// overridden; a first visit that cannot hold the high preset is moved to low as the world is drawn.
test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });

/** The settings the page keeps between visits. */
const stored = (page: import('@playwright/test').Page) => page.evaluate(() => JSON.parse(localStorage.getItem('trenchline.settings') ?? 'null'));

test("a preset picked in the pause menu is the visitor's own, and kept across a reload", async ({ page }) => {
  await openGame(page);
  await page.locator('#play').click();
  await expect(page.locator('#loading')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('#pause')).toBeVisible();
  await page.locator('#pause input[name="preset"][value="low"]').check();
  expect(await stored(page)).toMatchObject({ preset: 'low', presetChosen: true });
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { __trenchline?: { ready?: boolean } }).__trenchline?.ready === true, null, { timeout: 90_000 });
  expect(await hooks(page, (h) => h.stats().preset)).toBe('low');
  expect(await stored(page)).toMatchObject({ preset: 'low', presetChosen: true });
});

/** The warm-up's 120 frames after the world is first drawn, and a few more. */
const warmedUp = async (page: import('@playwright/test').Page) => {
  await page.waitForFunction(() => (window as unknown as { __trenchline?: { ready?: boolean } }).__trenchline?.ready === true, null, { timeout: 90_000 });
  await hooks(page, (h) => h.waitFrames(150));
};
const NOTE = 'Quality set to Low for this machine — change it in the pause menu (Esc).';

test('with an impossible budget a first visit moves to low as the world is drawn, and says so', async ({ page }) => {
  await page.goto('/?budget=1');
  await warmedUp(page);
  expect(await hooks(page, (h) => h.stats().preset)).toBe('low');
  await expect(page.locator('#note')).toBeVisible();
  await expect(page.locator('#note')).toHaveText(NOTE);
  // For this visit only: nothing kept.
  expect(await stored(page)).toBeNull();
  await expect(page.locator('#note')).toBeHidden({ timeout: 10_000 });
});

test('a visitor who chose high is never moved', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('trenchline.settings', JSON.stringify({ preset: 'high', presetChosen: true })));
  await page.goto('/?budget=1');
  await warmedUp(page);
  expect(await hooks(page, (h) => h.stats().preset)).toBe('high');
  await expect(page.locator('#note')).toBeHidden();
});

test('a machine that holds the budget is never moved', async ({ page }) => {
  await page.goto('/');
  await warmedUp(page);
  expect(await hooks(page, (h) => h.stats().preset)).toBe('high');
  await expect(page.locator('#note')).toBeHidden();
});

test('a preset picked during the warm-up ends it: the pick stands, and is kept', async ({ page }) => {
  await page.goto('/?budget=1');
  await page.waitForFunction(() => (window as unknown as { __trenchline?: { ready?: boolean } }).__trenchline?.ready === true, null, { timeout: 90_000 });
  // Within the warm-up's 120 frames: into play, the menu, Low and then High.
  await page.locator('#play').click();
  await page.keyboard.press('Escape');
  await page.locator('#pause input[name="preset"][value="low"]').check();
  await page.locator('#pause input[name="preset"][value="high"]').check();
  await hooks(page, (h) => h.waitFrames(150));
  expect(await hooks(page, (h) => h.stats().preset)).toBe('high');
  await expect(page.locator('#note')).toBeHidden();
  expect(await stored(page)).toMatchObject({ preset: 'high', presetChosen: true });
});

test('a pause menu left open across the move does not undo it when another setting changes', async ({ page }) => {
  await page.goto('/?budget=1');
  await page.waitForFunction(() => (window as unknown as { __trenchline?: { ready?: boolean } }).__trenchline?.ready === true, null, { timeout: 90_000 });
  await page.locator('#play').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#pause')).toBeVisible();
  // The move, under the open menu; then the field of view changed in it.
  await expect(page.locator('#note')).toBeVisible({ timeout: 30_000 });
  expect(await hooks(page, (h) => h.stats().preset)).toBe('low');
  await page.locator('#fov').fill('80');
  await hooks(page, (h) => h.waitFrames(5));
  expect(await hooks(page, (h) => h.stats().preset)).toBe('low');
  // Kept: the field of view; not the move, nor a choice the visitor did not make.
  expect(await stored(page)).toMatchObject({ preset: 'high', presetChosen: false, fov: 80 });
});

test('after a move the still waits for the world to settle again before it fades', async ({ page }) => {
  await page.goto('/?budget=1');
  await expect(page.locator('#note')).toBeVisible({ timeout: 90_000 });
  const r = await hooks(page, async (h) => {
    const still = document.getElementById('still') as HTMLElement;
    await h.waitFrames(20);
    const early = still.classList.contains('gone');
    await h.waitFrames(30);
    return { early, gone: still.classList.contains('gone') };
  });
  expect(r).toEqual({ early: false, gone: true });
});
