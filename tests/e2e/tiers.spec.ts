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
