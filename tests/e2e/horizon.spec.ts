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
