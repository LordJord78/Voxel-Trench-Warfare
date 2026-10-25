import { expect, test, type Page } from '@playwright/test';
import { hooks, openGame } from './support/app';
import { servedBuild } from './support/build';

// Where the game cannot run (the showcase spec's §3): the page shows the game's video in its place,
// says why and what would run it, and costs a visitor who can play nothing.
test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });

/** WebGPU taken from the page before it loads. */
const withoutWebGpu = (page: Page) => page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true }));

/** The fallback's video as the page has it, once it has played half a second. */
async function playing(page: Page) {
  await page.waitForFunction(() => ((document.getElementById('motion') as HTMLVideoElement | null)?.currentTime ?? 0) > 0.5, null, { timeout: 20_000 });
  return page.evaluate(() => {
    const v = document.getElementById('motion') as HTMLVideoElement;
    const r = v.getBoundingClientRect();
    const trace = document.querySelector('#loading .trace') as Element;
    return { muted: v.muted, loop: v.loop, autoplay: v.autoplay, inline: v.playsInline, src: v.currentSrc, poster: v.poster, cover: getComputedStyle(v).objectFit, box: [r.width, r.height], line: document.getElementById('motion-line')?.textContent ?? '', status: document.getElementById('status')?.textContent ?? '', progress: getComputedStyle(trace).display !== 'none' };
  });
}

test('without WebGPU the page shows the video playing, muted and looping, and says why', async ({ page }) => {
  await withoutWebGpu(page);
  await page.goto('/');
  const v = await playing(page);
  expect(v).toMatchObject({ muted: true, loop: true, autoplay: true, inline: true, cover: 'cover', box: [1600, 1000] });
  expect(v.src).toMatch(/\/video\/trenchline\.webm$/);
  expect(v.poster).toMatch(/\/stills\/dusk\.webp$/);
  // The failure names the browsers; the line under it does not again.
  expect(v.status).toContain('WebGPU');
  expect(v.status).toContain('Safari 26');
  expect(v.line).toBe('Here it is in motion.');
  expect(v.progress).toBe(false);
  expect(await hooks(page, (h) => (h as unknown as { fallback?: string }).fallback)).toBe('no-webgpu');
});

test('with no adapter, the same', async ({ page }) => {
  await page.addInitScript(() => {
    if (navigator.gpu) navigator.gpu.requestAdapter = async () => null;
  });
  await page.goto('/');
  const v = await playing(page);
  expect(v.line).toContain('Chrome or Edge, or Safari 26');
  expect(await hooks(page, (h) => (h as unknown as { fallback?: string }).fallback)).toBe('no-adapter');
});

test('on a touch-only device the video shows first, and "Try it anyway" loads the game', async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto('/');
  // The emulated phone has touch and no fine pointer, as a phone has.
  expect(await page.evaluate(() => [matchMedia('(pointer: coarse)').matches, matchMedia('(any-pointer: fine)').matches])).toEqual([true, false]);
  const v = await playing(page);
  expect(v.status).toContain('keyboard and mouse');
  // Nothing loading, no progress.
  expect(v.progress).toBe(false);
  expect(await hooks(page, (h) => (h as unknown as { fallback?: string }).fallback)).toBe('touch');
  // Nothing is generated until asked.
  expect(await hooks(page, (h) => h.ready)).not.toBe(true);
  await page.locator('#anyway').click();
  await page.waitForFunction(() => (window as unknown as { __trenchline?: { ready?: boolean } }).__trenchline?.ready === true, null, { timeout: 90_000 });
  expect(await page.locator('#motion').count()).toBe(0);
  expect(await hooks(page, (h) => h.error)).toBeUndefined();
  await context.close();
});

test('a visitor who can play downloads no video', async ({ page }) => {
  const asked: string[] = [];
  page.on('request', (r) => asked.push(r.url()));
  const errors = await openGame(page);
  await hooks(page, (h) => h.waitFrames(30));
  expect(asked.filter((u) => /\/video\//.test(u))).toEqual([]);
  expect(await page.locator('#motion').count()).toBe(0);
  expect(errors).toEqual([]);
});

test('the built site at a sub-path falls back with its video found', async ({ page }) => {
  test.setTimeout(240_000);
  const site = await servedBuild('/Voxel-Trench-Warfare/', 5333);
  try {
    await withoutWebGpu(page);
    await page.goto(site.url);
    const v = await playing(page);
    expect(v.src).toBe(`${site.url}video/trenchline.webm`);
    expect(v.poster).toBe(`${site.url}stills/dusk.webp`);
  } finally {
    await site.close();
  }
});

test('a device lost while loading falls back to the video', async ({ page }) => {
  await page.addInitScript(() => {
    const request = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (this: GPUAdapter, ...args: Parameters<GPUAdapter['requestDevice']>) {
      const device = await request.apply(this, args);
      device.destroy();
      return device;
    };
  });
  await page.goto('/');
  const v = await playing(page);
  expect(v.status).toContain('could not start');
  expect(await hooks(page, (h) => (h as unknown as { fallback?: string }).fallback)).toBe('failed');
});

test('without WebGPU nothing is generated', async ({ page }) => {
  const workers: string[] = [];
  page.on('worker', (w) => workers.push(w.url()));
  await withoutWebGpu(page);
  await page.goto('/');
  await playing(page);
  expect(workers).toEqual([]);
});

test('the video can be paused and played, and plays only when asked where motion is reduced', async ({ browser }) => {
  for (const reduced of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: reduced ? 'reduce' : 'no-preference' });
    const page = await context.newPage();
    await withoutWebGpu(page);
    await page.goto('/');
    const toggle = page.locator('#motion-toggle');
    await expect(toggle).toBeVisible();
    const paused = () => page.evaluate(() => (document.getElementById('motion') as HTMLVideoElement).paused);
    if (reduced) {
      await page.waitForTimeout(1000);
      expect(await paused()).toBe(true);
      await expect(toggle).toHaveText('Play');
      await toggle.click();
      await page.waitForFunction(() => ((document.getElementById('motion') as HTMLVideoElement).currentTime ?? 0) > 0.3);
      await expect(toggle).toHaveText('Pause');
    } else {
      await playing(page);
      await expect(toggle).toHaveText('Pause');
      await toggle.click();
      expect(await paused()).toBe(true);
      await expect(toggle).toHaveText('Play');
    }
    await context.close();
  }
});

test('where the browser refuses to play it, the video waits on its control', async ({ page }) => {
  // A browser that refuses: play() rejects, and what the autoplay attribute starts is stopped at once.
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = () => Promise.reject(new DOMException('autoplay refused', 'NotAllowedError'));
    document.addEventListener('play', (e) => (e.target as HTMLMediaElement).pause(), true);
  });
  await withoutWebGpu(page);
  await page.goto('/');
  await expect(page.locator('#motion-toggle')).toHaveText('Play');
});
