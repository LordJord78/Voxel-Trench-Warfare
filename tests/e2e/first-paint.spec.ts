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
