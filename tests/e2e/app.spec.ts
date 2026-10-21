import { expect, test, type Page } from '@playwright/test';
import { hooks, openGame } from './support/app';

/** The high preset's internal image for a canvas: the canvas itself up to 1.5 MP, else 1.5 MP at its aspect. */
function internal(w: number, h: number): [number, number] {
  if (w * h <= 1.5e6) return [w, h];
  const width = Math.round(Math.sqrt((1.5e6 * w) / h));
  return [width, Math.round(width / (w / h))];
}

async function rendersCleanly(page: Page, canvas: [number, number]): Promise<void> {
  // Past the resize's 150 ms debounce, until frames come at the new size.
  await page.waitForFunction(
    ([w, h]) => {
      const s = (window as unknown as { __trenchline: { stats(): { canvas: [number, number] } } }).__trenchline.stats();
      return s.canvas[0] === w && s.canvas[1] === h;
    },
    canvas,
    { timeout: 5_000 },
  );
  await hooks(page, (h) => h.waitFrames(10));
  const s = await hooks(page, (h) => h.stats());
  expect(s.alloc).toEqual(internal(...canvas));
  const shot = await hooks(page, (h) => h.snapshot());
  expect(shot.std, `frame at ${canvas.join('×')}`).toBeGreaterThan(4 / 255);
}

test('resizing keeps rendering cleanly', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const errors = await openGame(page);
  await hooks(page, (h) => h.setQuality({ dynres: false }));
  for (const [w, h] of [[1280, 720], [800, 600], [1440, 900]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await rendersCleanly(page, [w, h]);
  }
  expect(errors).toEqual([]);

  // Twice the device pixels: a 2560 × 1440 canvas, so the internal image is the high preset's 1.5 MP.
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  const retina = await context.newPage();
  const retinaErrors = await openGame(retina);
  await hooks(retina, (h) => h.setQuality({ dynres: false }));
  await rendersCleanly(retina, [2560, 1440]);
  expect(retinaErrors).toEqual([]);
  await context.close();
});

test('no WebGPU shows the message', async ({ page }) => {
  await page.addInitScript(() => {
    delete (Navigator.prototype as unknown as { gpu?: unknown }).gpu;
  });
  await openGame(page);
  await expect(page.locator('#status')).toContainText('TRENCHLINE needs WebGPU: use Chrome, Edge or Safari 26.');
  // At once, not after generating a world nothing can draw.
  expect(await hooks(page, (h) => h.ms)).toBeLessThan(1500);
});

test('a lost device shows the message', async ({ page }) => {
  await openGame(page);
  await hooks(page, (h) => h.waitFrames(5));
  await hooks(page, (h) => h.loseDevice());
  await expect(page.locator('#status')).toContainText('The graphics device was lost (destroyed). Reload the page to continue.');
  const frames = await hooks(page, (h) => h.frames());
  await page.waitForTimeout(500);
  expect(await hooks(page, (h) => h.frames())).toBe(frames);
});

test('a paused tab resumes cleanly', async ({ page }) => {
  const errors = await openGame(page);
  await hooks(page, (h) => h.waitFrames(5));
  expect(await hooks(page, (h) => h.stats().reset)).toBe(false);
  const resumed = await hooks(page, async (h) => {
    h.simulateGap(2000);
    await h.waitFrames(1);
    return h.stats().reset;
  });
  expect(resumed).toBe(true);
  expect(await hooks(page, async (h) => (await h.waitFrames(1), h.stats().reset))).toBe(false);
  const shot = await hooks(page, (h) => h.snapshot());
  expect(shot.std).toBeGreaterThan(4 / 255);
  expect(errors).toEqual([]);
});

test('dynamic resolution gives way to an impossible budget, and comes back', async ({ page }) => {
  const errors = await openGame(page);
  expect(await hooks(page, (h) => h.stats().dynres)).toBe(true);
  await hooks(page, (h) => h.setQuality({ budgetMs: 0.5 }));
  await hooks(page, (h) => h.waitFrames(120));
  const low = await hooks(page, (h) => h.stats());
  expect(low.scale).toBe(0.5);
  expect(low.res).toEqual([Math.round(low.alloc[0] / 2), Math.round(low.alloc[1] / 2)]);
  expect((await hooks(page, (h) => h.snapshot())).std).toBeGreaterThan(4 / 255);
  await hooks(page, (h) => h.setQuality({ budgetMs: 1000 }));
  await hooks(page, (h) => h.waitFrames(120));
  expect(await hooks(page, (h) => h.stats().scale)).toBeGreaterThan(0.5);
  expect(errors).toEqual([]);
});
