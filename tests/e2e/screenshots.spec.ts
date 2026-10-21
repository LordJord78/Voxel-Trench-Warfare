import { test } from '@playwright/test';
import { hooks, openGame } from './support/app';

// The six standard views at dusk and at night, for review by eye: grain, seams,
// the horizon, and the look against the probe frames. Written to artifacts/m4
// (git-ignored); the test fails only on errors.
test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });

const VIEWS = ['bay', 'step', 'nml-night', 'overview', 'dugout', 'hamlet'];

test('the standard views, at dusk and at night', async ({ page }) => {
  const errors = await openGame(page);
  await hooks(page, (h) => h.setQuality({ preset: 'high', dynres: false }));
  for (const name of VIEWS) {
    for (const [label, time] of [['dusk', 0], ['night', 1]] as const) {
      await hooks(page, (h, a) => {
        const [n, t] = a as [string, number];
        h.view(n);
        h.setTimeOfDay(t);
      }, [name, time]);
      // Long enough for the lighting history and TAA to settle.
      await hooks(page, (h) => h.waitFrames(120));
      await page.screenshot({ path: `artifacts/m4/${name}-${label}.png` });
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
});

// Moving: what the denoiser and TAA show mid-stride, not after they settle. Written to artifacts/m5.
test('walking the bay at dusk and strafing it at night, the firing step, the periscope', async ({ page }) => {
  const errors = await openGame(page);
  await hooks(page, (h) => h.setQuality({ preset: 'high', dynres: false }));
  await page.locator('#play').click();
  const spawn = async (time: number) =>
    hooks(page, (h, t) => {
      const p = h.world.spawn.position;
      h.teleport({ position: [p[0], p[1], p[2]], yaw: h.views.bay.yaw, pitch: 0 });
      h.setTimeOfDay(t as number);
    }, time);
  await spawn(0);
  await hooks(page, (h) => h.waitConverged());
  await page.keyboard.down('KeyW');
  for (let k = 0; k < 4; k++) {
    await hooks(page, (h) => h.waitFrames(12));
    await page.screenshot({ path: `artifacts/m5/walk-${k}.png` });
  }
  await page.keyboard.up('KeyW');
  await spawn(1);
  await hooks(page, (h) => h.waitConverged());
  await page.keyboard.down('KeyD');
  for (let k = 0; k < 2; k++) {
    await hooks(page, (h) => h.waitFrames(12));
    await page.screenshot({ path: `artifacts/m5/strafe-night-${k}.png` });
  }
  await page.keyboard.up('KeyD');
  await hooks(page, (h) => {
    const v = h.views.step;
    h.teleport({ position: [v.position[0], v.position[1] - 1.62, v.position[2]], yaw: v.yaw, pitch: 0 });
    h.setTimeOfDay(0);
  });
  await hooks(page, (h) => h.waitConverged());
  await page.screenshot({ path: 'artifacts/m5/step.png' });
  await page.keyboard.press('KeyQ');
  await hooks(page, (h) => h.waitConverged());
  await page.screenshot({ path: 'artifacts/m5/periscope.png' });
  if (errors.length) throw new Error(errors.join('\n'));
});
