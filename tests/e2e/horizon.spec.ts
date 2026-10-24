import { expect, test } from '@playwright/test';
import { hooks, openGame } from './support/app';

// The distant fire in the frame (the battle spec's §3): with the lights running, the battle's newest
// distant shells' flashes go to the sky, the haze and the far field; at rest, as every approved view
// is measured, none.
test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });

test("at rest no flash is set; running at heavy, the battle's newest are, each at least 200 m off", async ({ page }) => {
  const errors = await openGame(page);
  const rest = await hooks(page, async (h) => {
    h.setIntensity('heavy');
    await h.waitFrames(30);
    return h.horizon().length;
  });
  expect(rest).toBe(0);
  const seen = await hooks(page, async (h) => {
    h.runLights(0);
    for (let k = 0; k < 1200; k++) {
      await h.waitFrames(1);
      const set = h.horizon();
      if (set.length > 0) return { set, flashes: h.battle().flashes };
    }
    return null;
  });
  expect(seen, 'no distant shell landed in 20 s at heavy').not.toBeNull();
  expect(seen!.set.length).toBe(seen!.flashes.length);
  for (const f of seen!.set) {
    expect(Math.hypot(f.position[0] - 128, f.position[2] - 128)).toBeGreaterThanOrEqual(200);
    expect(f.power).toBeGreaterThan(0);
  }
  expect(errors).toEqual([]);
});

test("running at heavy, a far shell's flash and smoke are drawn; at rest, none", async ({ page }) => {
  // At dusk in fly mode nothing else draws billboards: no flare is fired, and the session is still.
  const errors = await openGame(page);
  const rest = await hooks(page, async (h) => {
    h.setIntensity('heavy');
    await h.waitFrames(30);
    return h.effects().billboards;
  });
  const seen = await hooks(page, async (h) => {
    h.runLights(0);
    for (let k = 0; k < 1800; k++) {
      await h.waitFrames(1);
      const smoke = h.battle().smoke.length;
      if (smoke >= 4) return { smoke, billboards: h.effects().billboards };
    }
    return null;
  });
  expect(seen, 'no far shell smoked in 30 s at heavy').not.toBeNull();
  // The frame's effects are built from the battle a frame behind its lights: a puff either way.
  expect(seen!.billboards - rest).toBeGreaterThanOrEqual(seen!.smoke - 1);
  const after = await hooks(page, async (h) => {
    h.holdLights();
    await h.waitFrames(3);
    return h.effects().billboards;
  });
  expect(after).toBe(rest);
  expect(errors).toEqual([]);
});
