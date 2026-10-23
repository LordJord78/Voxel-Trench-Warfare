import { expect, test, type Page } from '@playwright/test';
import { hooks, openGame } from './support/app';

// The rifle, traced and shaded in its own pass: where the CPU's trace of the model meets it, the
// G-buffer's depth is the rifle's; a wall nearer than it hides it; it is not drawn in fly mode or
// through the periscope; and it is lit by the world's light and its own flash.

/** Playing at a view's foot, still, jitter off (so the pixels' rays are the CPU's). */
async function holding(page: Page, view: 'bay' | 'step', yaw = 0) {
  await hooks(page, (h) => h.play());
  await hooks(
    page,
    (h, arg) => {
      const { view, yaw } = arg as { view: 'bay' | 'step'; yaw: number };
      const v = h.views[view];
      h.teleport({ position: [v.position[0], v.position[1] - 1.62, v.position[2]], yaw: v.yaw + yaw, pitch: 0 });
      h.jitter(false);
    },
    { view, yaw },
  );
  await hooks(page, (h) => h.waitFrames(30));
}

/** The rifle check, and the world's own depth at its pixels with the rifle put down for a frame. */
async function checkAgainstWorld(page: Page, n: number) {
  const r = await hooks(page, (h, n) => h.rifleCheck(n as number), n);
  const world = await hooks(
    page,
    async (h, px) => {
      h.showRifle(false);
      await h.waitFrames(2);
      const depths = await h.depthAt(px as [number, number][]);
      h.showRifle(true);
      await h.waitFrames(2);
      return depths;
    },
    r.samples.map((s) => s.px),
  );
  return { visible: r.visible, samples: r.samples.map((s, k) => ({ ...s, world: world[k] })) };
}

test("the rifle's pass agrees with a CPU trace of the model", async ({ page }) => {
  const errors = await openGame(page);
  await holding(page, 'bay');
  const r = await checkAgainstWorld(page, 12);
  expect(r.visible).toBe(true);
  let drawn = 0;
  for (const s of r.samples) {
    // The rifle where it is nearer than the world, exactly where the CPU's trace meets it; the world elsewhere.
    if (s.cpu !== null && s.cpu < s.world) {
      expect(Math.abs(s.gpu - s.cpu), JSON.stringify(s)).toBeLessThan(1e-3);
      drawn++;
    } else {
      expect(Math.abs(s.gpu - s.world), JSON.stringify(s)).toBeLessThan(1e-4);
    }
  }
  expect(drawn).toBeGreaterThan(8);
  expect(errors).toEqual([]);
});

test('a wall the rifle is pushed into hides what is behind it', async ({ page }) => {
  const errors = await openGame(page);
  // Turned to the trench's side and walked into it: the rifle reaches past the wall's face.
  await holding(page, 'bay', 90);
  await page.keyboard.down('KeyW');
  await hooks(page, (h) => h.waitFrames(120));
  await page.keyboard.up('KeyW');
  await hooks(page, (h) => h.waitFrames(20));
  const r = await hooks(page, (h) => h.rifleCheck(12));
  const hits = r.samples.filter((s) => s.cpu !== null);
  // Never drawn farther than the rifle is; where the rifle is behind the wall, the wall is drawn.
  for (const s of hits) expect(s.gpu, JSON.stringify(s)).toBeLessThanOrEqual(s.cpu! + 1e-3);
  expect(hits.filter((s) => s.gpu < s.cpu! - 0.05).length, JSON.stringify(r.samples)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('no rifle through the periscope or in fly mode', async ({ page }) => {
  const errors = await openGame(page);
  await holding(page, 'step');
  const held = await hooks(page, (h) => h.rifleCheck(12));
  expect(held.visible).toBe(true);
  const on = held.samples.find((s) => s.cpu !== null)!;
  await page.keyboard.press('KeyQ');
  await hooks(page, (h) => h.waitFrames(60));
  expect((await hooks(page, (h) => h.player())).stance).toBe(4);
  const through = await hooks(page, (h, px) => Promise.all([h.rifleVisible(), h.depthAt([px as [number, number]])]), on.px);
  expect(through[0]).toBe(false);
  expect(through[1][0]).toBeGreaterThan(1.3);
  await hooks(page, async (h) => {
    h.view('bay');
    await h.waitFrames(10);
  });
  expect(await hooks(page, (h) => h.rifleVisible())).toBe(false);
  expect(errors).toEqual([]);
});

test('on the firing step the rifle is raised over the parapet, and drawn', async ({ page }) => {
  const errors = await openGame(page);
  await holding(page, 'step');
  const r = await checkAgainstWorld(page, 12);
  expect(r.visible).toBe(true);
  const drawn = r.samples.filter((s) => s.cpu !== null && s.cpu < s.world && Math.abs(s.gpu - s.cpu) < 1e-3);
  expect(drawn.length, JSON.stringify(r.samples)).toBeGreaterThan(8);
  expect(errors).toEqual([]);
});

test('the rifle is lit by the world, and by its own flash', async ({ page }) => {
  const errors = await openGame(page);
  await holding(page, 'bay');
  const at = async (hours: number) =>
    hooks(
      page,
      async (h, t) => {
        h.setTimeOfDay(t as number);
        await h.waitFrames(30);
        return h.rifleLuminance();
      },
      hours,
    );
  const noon = await at(12);
  const night = await at(23);
  expect(noon / night, JSON.stringify({ noon, night })).toBeGreaterThan(5);
  const flashed = await hooks(page, async (h) => {
    h.debugLights([{ position: h.rifleMuzzle(), radiusM: 6, colour: [1.0, 0.72, 0.4], intensity: 40 }]);
    await h.waitFrames(2);
    const lum = await h.rifleLuminance();
    h.debugLights([]);
    return lum;
  });
  // The flash is in front of the rifle, and most of its faces look aside or up: a fifth more, about.
  expect(flashed / night, JSON.stringify({ night, flashed })).toBeGreaterThan(1.1);
  expect(errors).toEqual([]);
});
