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

test('the page loads to a click-to-play prompt over the world, and a teleport starts the image afresh', async ({ page }) => {
  const errors = await openGame(page);
  await expect(page.locator('#play')).toBeVisible();
  expect(await hooks(page, (h) => h.mode())).toBe('ready');
  expect(await hooks(page, (h) => h.phases.length)).toBeGreaterThanOrEqual(3);
  await page.locator('#play').click();
  await expect(page.locator('#loading')).toBeHidden();
  expect(await hooks(page, (h) => h.mode())).toBe('playing');
  await hooks(page, (h) => h.waitFrames(5));
  const reset = await hooks(page, async (h) => {
    const spawn = h.world.spawn.position;
    h.teleport({ position: [spawn[0], spawn[1], spawn[2]], yaw: 0, pitch: 0 });
    await h.waitFrames(1);
    return h.stats().reset;
  });
  expect(reset).toBe(true);
  expect(errors).toEqual([]);
});

test('the lights move with their own clock, frame by frame, and stop for the pause menu', async ({ page }) => {
  const errors = await openGame(page);
  // Held, as every other test has them: as planned, frame after frame.
  const rest = await hooks(page, (h) => h.lights());
  await hooks(page, (h) => h.waitFrames(5));
  expect(await hooks(page, (h) => h.lights())).toEqual(rest);
  const lanterns = rest.flatMap((l, i) => (l.kind === 'lantern' ? [i] : []));
  expect(lanterns.length).toBeGreaterThan(0);
  expect(rest.some((l) => l.kind === 'flare')).toBe(true);
  // Running, over the free camera at night, the front heavy: every lantern's light wavers from one
  // moment to the next, and the battle's flares in the air move (each followed by its id).
  const [a, b] = await hooks(page, async (h) => {
    h.view('dugout');
    h.setTimeOfDay(21);
    h.setIntensity('heavy');
    h.runLights();
    await h.waitFrames(60 * 25);
    const first = h.lights();
    await h.waitFrames(20);
    return [first, h.lights()];
  });
  for (const i of lanterns) {
    expect(a[i].position).toEqual(rest[i].position);
    expect(b[i].intensity).not.toBe(a[i].intensity);
  }
  const flown = a.filter((l) => l.kind === 'flare' && l.id !== undefined && b.some((m) => m.id === l.id));
  expect(flown.length).toBeGreaterThan(0);
  for (const l of flown) expect(b.find((m) => m.id === l.id)!.position).not.toEqual(l.position);
  // Paused, they wait.
  await page.keyboard.press('Escape');
  expect(await hooks(page, (h) => h.mode())).toBe('paused');
  const paused = await hooks(page, async (h) => {
    await h.waitFrames(2);
    const first = h.lights();
    await h.waitFrames(10);
    return [first, h.lights()];
  });
  expect(paused[1]).toEqual(paused[0]);
  expect(errors).toEqual([]);
});

test('an exception in the frame loop stops the game and says so', async ({ page }) => {
  await openGame(page);
  await hooks(page, (h) => h.waitFrames(3));
  await page.evaluate(() => {
    const r = (window as unknown as { __trenchline: { renderer: { render: () => void } } }).__trenchline.renderer;
    r.render = () => {
      throw new Error('a test broke the renderer');
    };
  });
  await expect(page.locator('#status')).toContainText('TRENCHLINE stopped: a test broke the renderer');
  const frames = await hooks(page, (h) => h.frames());
  await page.waitForTimeout(300);
  expect(await hooks(page, (h) => h.frames())).toBe(frames);
});

for (const paused of [false, true]) {
  test(`a failure while ${paused ? 'paused' : 'playing'} shows its message, not the pause menu`, async ({ page }) => {
    await openGame(page);
    await page.locator('#play').click();
    await hooks(page, (h) => h.waitFrames(5));
    if (paused) {
      await page.keyboard.press('Escape');
      await expect(page.locator('#pause')).toBeVisible();
    }
    await hooks(page, (h) => h.loseDevice());
    await expect(page.locator('#status')).toContainText('The graphics device was lost');
    await expect(page.locator('#status')).toBeVisible();
    await expect(page.locator('#pause')).toBeHidden();
    await expect(page.locator('#controls')).toBeHidden();
  });
}

test('glide moves the flying camera without starting its histories afresh, where flying to a pose starts them', async ({ page }) => {
  const errors = await openGame(page);
  const r = await hooks(page, async (h) => {
    const v = h.views.step;
    h.flyTo({ position: v.position, yaw: v.yaw, pitch: v.pitch });
    await h.waitFrames(1);
    const flown = h.stats().reset;
    await h.waitFrames(5);
    const moved = { position: [v.position[0] + 0.05, v.position[1], v.position[2]] as [number, number, number], yaw: v.yaw + 0.5, pitch: v.pitch };
    h.glide(moved);
    await h.waitFrames(1);
    return { flown, glided: h.stats().reset, camera: h.camera(), moved };
  });
  expect(r.flown).toBe(true);
  expect(r.glided).toBe(false);
  expect(r.camera.position[0]).toBeCloseTo(r.moved.position[0], 6);
  expect(r.camera.yaw).toBeCloseTo(r.moved.yaw, 6);
  expect(errors).toEqual([]);
});
