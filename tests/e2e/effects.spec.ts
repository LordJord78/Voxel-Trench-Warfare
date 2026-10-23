import { expect, test, type Page } from '@playwright/test';
import { hooks, openGame } from './support/app';

// The effects pass: drawn over the sharpened image, hidden where the world is nearer, at the
// frame's internal resolution; and in play, a magazine's tracers, flash, brass and dust.

/** The bay view at dusk, frozen; the camera, its forward, and the world's depth (m) at the image's middle. */
async function atTheBay(page: Page) {
  await hooks(page, async (h) => {
    h.view('bay');
    h.freeze();
    await h.stepFrames(40);
  });
  return hooks(page, async (h) => {
    const c = h.camera();
    const s = h.stats();
    const [depth] = await h.depthAt([[Math.floor(s.res[0] / 2), Math.floor(s.res[1] / 2)]]);
    const y = (c.yaw * Math.PI) / 180;
    const p = (c.pitch * Math.PI) / 180;
    return { position: c.position, forward: [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)], depth };
  });
}

/**
 * The image's mean with a two-metre quad `out` metres along the view, or none: bright, but not so
 * bright (×`particle_glow`) that bloom spreads it over the frame, which it does further at a lower
 * resolution.
 */
async function meanWith(page: Page, at: { position: number[]; forward: number[] }, out: number | null): Promise<number> {
  return hooks(
    page,
    async (h, arg) => {
      const { at, out } = arg as { at: { position: number[]; forward: number[] }; out: number | null };
      h.debugQuads(out === null ? [] : [{ position: at.position.map((v, k) => v + at.forward[k] * out) as [number, number, number], size: 2.0, colour: [0.05, 0.05, 0.05] }]);
      // Frozen, a frame is drawn only when stepped: ask for its picture first.
      const shot = h.snapshot();
      await h.stepFrames(1);
      return (await shot).mean;
    },
    { at, out },
  );
}

test('an effect in front of the wall shows, and one behind it does not', async ({ page }) => {
  const errors = await openGame(page);
  const at = await atTheBay(page);
  expect(at.depth).toBeGreaterThan(4);
  const before = await meanWith(page, at, null);
  const again = await meanWith(page, at, null);
  const front = await meanWith(page, at, at.depth / 2);
  const behind = await meanWith(page, at, at.depth + 2);
  const after = await meanWith(page, at, null);
  // Frame to frame, a frozen view's mean (0 to 1) moves this little.
  const noise = Math.max(Math.abs(again - before), Math.abs(after - again), 1e-4);
  const seen = JSON.stringify({ before, again, front, behind, after });
  expect(front - after, seen).toBeGreaterThan(Math.max(0.01, 20 * noise));
  expect(Math.abs(behind - after), seen).toBeLessThanOrEqual(3 * noise);
  expect(errors).toEqual([]);
});

test('effects follow dynamic resolution', async ({ page }) => {
  const errors = await openGame(page);
  const at = await atTheBay(page);
  const rise = async () => {
    const without = await meanWith(page, at, null);
    return (await meanWith(page, at, at.depth / 2)) - without;
  };
  const full = await rise();
  await hooks(page, (h) => h.setQuality({ dynres: false, scale: 0.5 }));
  await hooks(page, (h) => h.stepFrames(10));
  const half = await rise();
  expect(full).toBeGreaterThan(0.01);
  expect(half / full, JSON.stringify({ full, half })).toBeGreaterThan(0.6);
  expect(half / full, JSON.stringify({ full, half })).toBeLessThan(1.6);
  expect(errors).toEqual([]);
});

test('a magazine on full auto draws tracers, the flash, brass and dust', async ({ page }) => {
  const errors = await openGame(page);
  await hooks(page, (h) => h.play());
  await hooks(page, (h) => {
    const v = h.views.step;
    h.teleport({ position: [v.position[0], v.position[1] - 1.62, v.position[2]], yaw: v.yaw, pitch: -2 });
  });
  await hooks(page, (h) => h.waitFrames(20));
  await hooks(page, (h) => h.trigger(true));
  const most = await hooks(page, async (h) => {
    let billboards = 0;
    let tracers = 0;
    let stars = 0;
    for (let k = 0; k < 90; k++) {
      await h.waitFrames(1);
      const e = h.effects();
      billboards = Math.max(billboards, e.billboards);
      tracers = Math.max(tracers, e.tracers);
      stars = Math.max(stars, e.stars);
    }
    h.trigger(false);
    return { billboards, tracers, stars, errors: h.gpuErrors() };
  });
  expect(most.billboards).toBeGreaterThan(0);
  expect(most.tracers).toBeGreaterThan(0);
  expect(most.stars).toBeGreaterThan(0);
  expect(most.errors).toEqual([]);
  expect(errors).toEqual([]);
});
