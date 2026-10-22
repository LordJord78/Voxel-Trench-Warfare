import { test } from '@playwright/test';
import { useManyLights } from './many-lights';
import { hooks, openGame } from './support/app';

// The six standard views at dusk, night, dawn and noon, and at 18:30, the darkest of the evening's
// twilight, where the exposure peaks: for review by eye (grain, seams, the horizon, lanterns and
// flares in twilight) and the look against the approved frames (artifacts/approved). Written to
// artifacts/m4 (git-ignored); the test fails only on errors.
test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });

const VIEWS = ['bay', 'step', 'nml-night', 'overview', 'dugout', 'hamlet'];
const DUSK = 17 + 35 / 60;

test('the standard views, at dusk, night, dawn, noon and twilight', async ({ page }) => {
  test.setTimeout(360_000);
  const errors = await openGame(page);
  await hooks(page, (h) => h.setQuality({ preset: 'high', dynres: false }));
  for (const name of VIEWS) {
    for (const [label, time] of [['dusk', DUSK], ['night', 21], ['dawn', 6 + 50 / 60], ['noon', 12], ['twilight', 18.5]] as const) {
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
  await spawn(DUSK);
  await hooks(page, (h) => h.waitConverged());
  await page.keyboard.down('KeyW');
  for (let k = 0; k < 4; k++) {
    await hooks(page, (h) => h.waitFrames(12));
    await page.screenshot({ path: `artifacts/m5/walk-${k}.png` });
  }
  await page.keyboard.up('KeyW');
  await spawn(21);
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
    h.setTimeOfDay(17 + 35 / 60);
  });
  await hooks(page, (h) => h.waitConverged());
  await page.screenshot({ path: 'artifacts/m5/step.png' });
  await page.keyboard.press('KeyQ');
  await hooks(page, (h) => h.waitConverged());
  await page.screenshot({ path: 'artifacts/m5/periscope.png' });
  if (errors.length) throw new Error(errors.join('\n'));
});

// The exposure adapting: the dugout settled at dusk, then the clock put to night (no fresh start),
// so the lantern-lit chamber comes down from the dusk's exposure at its rate, three stops a second.
// Written to artifacts/m5.
test('the dugout as the eye comes down from dusk into the lantern-lit night', async ({ page }) => {
  const errors = await openGame(page);
  await hooks(page, (h) => {
    h.setQuality({ preset: 'high', dynres: false });
    h.view('dugout');
  });
  await hooks(page, (h) => h.waitConverged());
  await hooks(page, (h) => h.setTimeOfDay(21));
  // Shots 1, 15, 30, 60 and 120 frames after.
  let at = 0;
  for (const [k, frames] of [1, 15, 30, 60, 120].entries()) {
    await hooks(page, (h, n) => h.waitFrames(n as number), frames - at);
    at = frames;
    await page.screenshot({ path: `artifacts/m5/dugout-adapt-${k}.png` });
  }
  if (errors.length) throw new Error(errors.join('\n'));
});

// Row 2's scene for review by eye: the field at night under a thousand lights, 256 of them moving
// (the lights' own clock running), from the overview and from no man's land, two frames apart.
// Written to artifacts/l4.
test('the field at night under a thousand lights', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await openGame(page);
  await hooks(page, (h) => h.setQuality({ preset: 'high', dynres: false }));
  await useManyLights(page);
  await hooks(page, (h) => h.runLights());
  for (const name of ['overview', 'nml-night']) {
    await hooks(page, (h, n) => {
      h.view(n as string);
      h.setTimeOfDay(21);
    }, name);
    await hooks(page, (h) => h.waitFrames(150));
    await page.screenshot({ path: `artifacts/l4/many-lights-${name}-a.png` });
    await hooks(page, (h) => h.waitFrames(2));
    await page.screenshot({ path: `artifacts/l4/many-lights-${name}-b.png` });
  }
  if (errors.length) throw new Error(errors.join('\n'));
});

// Row 5, shafts, for review by eye: the hamlet's church at dusk, from its view and walking toward
// it; and over the parapet from the firing step at night under a flare (one of the scene's, hung
// beyond the dead wood, 45 m out and 16 m up, so its light comes toward the eye through the stumps
// and wire; held), standing and strafing along the step. Written to artifacts/l6.
test('row 5: the church at dusk, and over the parapet at night under a flare', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await openGame(page);
  await hooks(page, (h) => h.setQuality({ preset: 'high', dynres: false }));
  await hooks(page, (h) => h.view('hamlet'));
  await hooks(page, (h) => h.waitConverged());
  await page.screenshot({ path: 'artifacts/l6/church-dusk.png' });
  await hooks(page, (h) => h.play());
  const stand = async (view: 'hamlet' | 'step', time: number) =>
    hooks(page, (h, a) => {
      const [n, t] = a as ['hamlet' | 'step', number];
      const v = h.views[n];
      h.teleport({ position: [v.position[0], v.position[1] - 1.62, v.position[2]], yaw: v.yaw, pitch: 0 });
      h.setTimeOfDay(t);
    }, [view, time]);
  await stand('hamlet', DUSK);
  await hooks(page, (h) => h.waitConverged());
  await page.keyboard.down('KeyW');
  for (let k = 0; k < 3; k++) {
    await hooks(page, (h) => h.waitFrames(15));
    await page.screenshot({ path: `artifacts/l6/church-walk-${k}.png` });
  }
  await page.keyboard.up('KeyW');
  await hooks(page, (h) => {
    const v = h.views.step;
    const ahead = v.yaw === 0 ? 1 : -1;
    const flare = h.lights().find((l) => l.kind === 'flare');
    if (!flare) throw new Error('no flare in the scene');
    h.useLights([...h.lights(), { ...flare, position: [v.position[0] + 4, v.position[1] + 16, v.position[2] + 45 * ahead] }]);
    h.holdLights();
  });
  await stand('step', 21);
  await hooks(page, (h) => h.waitConverged());
  await page.screenshot({ path: 'artifacts/l6/step-flare-night.png' });
  await page.keyboard.down('KeyD');
  for (let k = 0; k < 3; k++) {
    await hooks(page, (h) => h.waitFrames(12));
    await page.screenshot({ path: `artifacts/l6/step-flare-strafe-${k}.png` });
  }
  await page.keyboard.up('KeyD');
  if (errors.length) throw new Error(errors.join('\n'));
});
