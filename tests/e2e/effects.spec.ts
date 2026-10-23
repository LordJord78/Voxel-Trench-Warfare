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

/** The step view at night, frozen: its camera and forward. */
async function atNight(page: Page) {
  await hooks(page, async (h) => {
    h.view('step');
    h.setTimeOfDay(23);
    h.freeze();
    await h.stepFrames(40);
  });
  return hooks(page, (h) => {
    const c = h.camera();
    const y = (c.yaw * Math.PI) / 180;
    const p = (c.pitch * Math.PI) / 180;
    return { position: c.position, forward: [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)] };
  });
}

/** The image's mean with a shot's light 1.2 m along the view, or none. */
async function meanLit(page: Page, at: { position: number[]; forward: number[] }, lit: boolean): Promise<number> {
  return hooks(
    page,
    async (h, arg) => {
      const { at, lit } = arg as { at: { position: number[]; forward: number[] }; lit: boolean };
      const position = at.position.map((v, k) => v + at.forward[k] * 1.2) as [number, number, number];
      h.debugLights(lit ? [{ position, radiusM: 6, colour: [1.0, 0.72, 0.4], intensity: 40 }] : []);
      const shot = h.snapshot();
      await h.stepFrames(1);
      return (await shot).mean;
    },
    { at, lit },
  );
}

test("a shot's light lights the trench, and leaves nothing behind once gone", async ({ page }) => {
  const errors = await openGame(page);
  const at = await atNight(page);
  const before = await meanLit(page, at, false);
  const lit = await meanLit(page, at, true);
  const still = await meanLit(page, at, true);
  const gone = await meanLit(page, at, false);
  const seen = JSON.stringify({ before, lit, still, gone });
  expect(lit / before, seen).toBeGreaterThan(1.02);
  // In no history: whole on its first frame (a denoised light would show a thirtieth of itself)
  // and gone on the first frame after (one would linger for half a second, here some 80% over).
  // Within the exposure's adaptation to the two lit frames, a percent and a half each.
  expect(Math.abs(lit - still) / still, seen).toBeLessThan(0.03);
  expect(Math.abs(gone - before) / before, seen).toBeLessThan(0.06);
  expect(errors).toEqual([]);
});

test("a shot's light lights the trench at the low preset's light scale too", async ({ page }) => {
  const errors = await openGame(page);
  await hooks(page, (h) => h.setQuality({ preset: 'low' }));
  const at = await atNight(page);
  const before = await meanLit(page, at, false);
  const lit = await meanLit(page, at, true);
  expect(lit / before, JSON.stringify({ before, lit })).toBeGreaterThan(1.02);
  expect(errors).toEqual([]);
});

test("a shot's flash and light last two frames", async ({ page }) => {
  const errors = await openGame(page);
  await hooks(page, (h) => h.play());
  await hooks(page, (h) => {
    const v = h.views.step;
    h.teleport({ position: [v.position[0], v.position[1] - 1.62, v.position[2]], yaw: v.yaw, pitch: -2 });
  });
  const seen = await hooks(page, async (h) => {
    await h.waitFrames(20);
    h.freeze();
    h.trigger(true);
    const out: [number, number][] = [];
    for (let k = 0; k < 4; k++) {
      await h.stepFrames(1);
      if (k === 0) h.trigger(false);
      const e = h.effects();
      out.push([e.stars, e.lights]);
    }
    return out;
  });
  expect(seen).toEqual([[3, 1], [3, 1], [0, 0], [0, 0]]);
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
