import { expect, test } from '@playwright/test';
import { hooks } from './support/app';

// The page's first impression (the showcase spec's §2): until the click the live world is drawn from
// the firing step's view over the parapet at dusk, the page's still is that view, and it gives way to
// the live world at the same view.
test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });

type Pose = { position: number[]; yaw: number; pitch: number };

test('until the click the world is drawn from the firing step over the parapet, and the click starts play at the spawn', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { __trenchline?: { ready?: boolean } }).__trenchline?.ready === true, null, { timeout: 90_000 });
  const before = await hooks(page, async (h) => {
    await h.waitFrames(2);
    return { camera: h.camera() as Pose, step: h.views.step as Pose };
  });
  for (let k = 0; k < 3; k++) expect(before.camera.position[k]).toBeCloseTo(before.step.position[k], 6);
  expect(before.camera.yaw).toBeCloseTo(before.step.yaw, 6);
  expect(before.camera.pitch).toBeCloseTo(before.step.pitch, 6);
  await page.locator('#play').click();
  await expect(page.locator('#loading')).toBeHidden();
  const after = await hooks(page, async (h) => {
    await h.waitFrames(2);
    const p = h.session.player.position;
    return { camera: h.camera() as Pose, feet: [p.x, p.y, p.z] };
  });
  // Playing: the eye over the player's feet at the spawn.
  expect(Math.hypot(after.camera.position[0] - after.feet[0], after.camera.position[2] - after.feet[2])).toBeLessThan(0.5);
  expect(errors).toEqual([]);
});

/** The ready flag the page sets once the world is first drawn. */
const ready = (page: import('@playwright/test').Page) =>
  page.waitForFunction(() => (window as unknown as { __trenchline?: { ready?: boolean } }).__trenchline?.ready === true, null, { timeout: 90_000 });

test('the still is painted within 1 s of navigation', async ({ page }) => {
  test.setTimeout(240_000);
  const { servedBuild } = await import('./support/build');
  const site = await servedBuild('/Voxel-Trench-Warfare/', 5332);
  try {
    await page.goto(site.url);
    // By Element Timing: a full-viewport image is never a largest contentful paint (Chrome takes it
    // for a background), so the still is marked (elementtiming="still") and its paint read; 3 s at most.
    const painted = await page.evaluate(
      () =>
        new Promise<{ at: number; url: string } | null>((resolve) => {
          new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
              const p = e as PerformanceEntry & { identifier: string; renderTime: number; url: string };
              if (p.identifier === 'still') resolve({ at: p.renderTime, url: p.url });
            }
          }).observe({ type: 'element', buffered: true });
          setTimeout(() => resolve(null), 3000);
        }),
    );
    console.log(`the still painted: ${JSON.stringify(painted)}`);
    expect(painted).not.toBeNull();
    expect(painted!.url).toMatch(/\/Voxel-Trench-Warfare\/stills\/dusk\.webp$/);
    expect(painted!.at).toBeLessThanOrEqual(1000);
  } finally {
    await site.close();
  }
});

test.describe('at the still\'s own size', () => {
  test.use({ viewport: { width: 1920, height: 1200 }, deviceScaleFactor: 1 });

  test('when the world is drawn the still fades out over 0.8 s, and the live world is the same view', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/');
    await ready(page);
    const faded = await page.evaluate(async () => {
      const still = document.getElementById('still') as HTMLImageElement;
      const gone = still.classList.contains('gone');
      const duration = getComputedStyle(still).transitionDuration;
      await new Promise((r) => setTimeout(r, 1200));
      return { gone, duration, hidden: still.hidden };
    });
    expect(faded).toEqual({ gone: true, duration: '0.8s', hidden: true });
    // The live view as the still was taken (tools/stills.mjs): the loading screen hidden, the high
    // preset at its full image, its histories settled.
    await hooks(page, async (h) => {
      h.setQuality({ preset: 'high', dynres: false });
      document.getElementById('loading')!.hidden = true;
      await h.waitFrames(240);
    });
    const live = (await page.screenshot()).toString('base64');
    // Each image as a 16 × 10 grid of mean luma, and how alike the two are.
    const match = await page.evaluate(async (png) => {
      const grid = async (src: string) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        // Fitted to the window's width and centred, as the page shows it.
        const c = new OffscreenCanvas(1920, 1200);
        const g = c.getContext('2d')!;
        const h = (img.naturalHeight * 1920) / img.naturalWidth;
        g.drawImage(img, 0, (1200 - h) / 2, 1920, h);
        const d = g.getImageData(0, 0, 1920, 1200).data;
        const cells = new Array(160).fill(0);
        for (let y = 0; y < 1200; y += 2) {
          for (let x = 0; x < 1920; x += 2) {
            const i = (y * 1920 + x) * 4;
            cells[Math.floor(y / 120) * 16 + Math.floor(x / 120)] += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          }
        }
        return cells.map((v) => v / (60 * 60 * 255));
      };
      const a = await grid('./stills/dusk.webp');
      const b = await grid(`data:image/png;base64,${png}`);
      const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
      const [ma, mb] = [mean(a), mean(b)];
      let ab = 0;
      let aa = 0;
      let bb = 0;
      for (let k = 0; k < a.length; k++) {
        ab += (a[k] - ma) * (b[k] - mb);
        aa += (a[k] - ma) ** 2;
        bb += (b[k] - mb) ** 2;
      }
      return { correlation: ab / Math.sqrt(aa * bb), still: ma, live: mb };
    }, live);
    console.log(`the still against the live view: correlation ${match.correlation.toFixed(4)}, mean luma ${match.still.toFixed(4)} against ${match.live.toFixed(4)}`);
    expect(match.correlation).toBeGreaterThanOrEqual(0.95);
    expect(Math.abs(match.live - match.still) / match.still).toBeLessThanOrEqual(0.1);
  });
});

test('with the still blocked the game loads, the title over the night', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/stills/dusk.webp', (route) => route.abort());
  await page.goto('/');
  await ready(page);
  await expect(page.locator('#loading h1')).toBeVisible();
  await expect(page.locator('#play')).toBeVisible();
  expect(await page.evaluate(() => (document.getElementById('still') as HTMLImageElement).naturalWidth)).toBe(0);
  expect(errors).toEqual([]);
});

test('the failure sheet reads over the still', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true });
  });
  await page.goto('/');
  await expect(page.locator('#loading.failed #status')).toContainText('WebGPU');
  const still = await page.evaluate(async () => {
    const s = document.getElementById('still') as HTMLImageElement;
    await s.decode().catch(() => undefined);
    return { hidden: s.hidden, gone: s.classList.contains('gone'), width: s.naturalWidth, opacity: getComputedStyle(s).opacity };
  });
  expect(still).toEqual({ hidden: false, gone: false, width: 1920, opacity: '1' });
});
