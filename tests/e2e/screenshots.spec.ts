import { test } from '@playwright/test';
import { useManyLights } from './many-lights';
import { hooks, openGame } from './support/app';

// The six standard views at dusk, night, dawn and noon, and at 18:30, the darkest of the evening's
// twilight, where the exposure peaks: for review by eye (grain, seams, the horizon, lanterns and
// flares in twilight) and the look against the approved frames (artifacts/approved). Written to
// artifacts/l6/views (git-ignored); the test fails only on errors.
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
      await page.screenshot({ path: `artifacts/l6/views/${name}-${label}.png` });
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
});

// The low preset (half the froxels each way, no spatial reuse, a quarter of the sky view, lit at one
// pixel in sixteen), where it shows: the church's shafts at dusk, the flares' glow in no man's land
// at night, and the overview's sky at dusk. Written to artifacts/l6/low.
test('three views on the low preset', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await openGame(page);
  await hooks(page, (h) => h.setQuality({ preset: 'low', dynres: false }));
  for (const [name, label, time] of [['hamlet', 'dusk', DUSK], ['nml-night', 'night', 21], ['overview', 'dusk', DUSK]] as const) {
    await hooks(page, (h, a) => {
      const [n, t] = a as [string, number];
      h.view(n);
      h.setTimeOfDay(t);
    }, [name, time]);
    await hooks(page, (h) => h.waitFrames(120));
    await page.screenshot({ path: `artifacts/l6/low/${name}-${label}.png` });
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

// Row 5's flare where the froxels can resolve its shaft (a stump or a post is a froxel column wide at
// most): the church at night from the hamlet's view, a flare hung 12 m beyond the tower and 10 m to
// its right, at three fifths of its height, so the tower's shadow crosses the view through the
// flare's glow in the haze. For the user to judge the flares' strength in the haze
// (sky.haze_lights). Written to artifacts/l6.
test('row 5: a flare beyond the church tower at night', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await openGame(page);
  await hooks(page, (h) => h.setQuality({ preset: 'high', dynres: false }));
  await hooks(page, (h) => {
    const w = h.world as unknown as {
      plan: { params: { voxel: number }; props: { kind: string; x: number; z: number }[] };
      map: { dims: { y: number }; get(x: number, y: number, z: number): number };
    };
    const voxel = w.plan.params.voxel;
    const church = w.plan.props.find((q) => q.kind === 'church');
    if (!church) throw new Error('no church in the plan');
    // The tower's top: the highest solid voxel within a metre of its middle.
    let top = 0;
    for (let dz = -10; dz <= 10; dz += 2) {
      for (let dx = -10; dx <= 10; dx += 2) {
        for (let y = w.map.dims.y - 1; y > top; y--) {
          if (w.map.get(church.x + dx, y, church.z + dz) !== 0) {
            top = y;
            break;
          }
        }
      }
    }
    const v = h.views.hamlet;
    const ax = church.x * voxel - v.position[0];
    const az = church.z * voxel - v.position[2];
    const d = Math.hypot(ax, az);
    const flare = h.lights().find((l) => l.kind === 'flare');
    if (!flare) throw new Error('no flare in the scene');
    // Beyond the tower along the view, and to its right (the view's right, square to it in plan).
    const at: [number, number, number] = [church.x * voxel + (ax / d) * 12 + (az / d) * 10, top * voxel * 0.6, church.z * voxel + (az / d) * 12 - (ax / d) * 10];
    h.useLights([...h.lights(), { ...flare, position: at }]);
    h.holdLights();
    h.view('hamlet');
    h.setTimeOfDay(21);
  });
  await hooks(page, (h) => h.waitConverged());
  await hooks(page, (h) => h.waitFrames(60));
  await page.screenshot({ path: 'artifacts/l6/church-flare-night.png' });
  if (errors.length) throw new Error(errors.join('\n'));
});

// Combat milestone 3's review: a magazine fired along the bay at dusk and at night, and over the
// parapet at night, each caught on a frame with its flash's star and a tracer in the air; the rifle
// raised on the firing step at dusk, and down on the walkway in the trench's shadow. Written to
// artifacts/c3.
test('a magazine along the bay and over the parapet, and the rifle in the light', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await openGame(page);
  await hooks(page, (h) => h.setQuality({ preset: 'high', dynres: false }));
  await hooks(page, (h) => h.play());
  // Along the bay a round strikes the traverse in its first tick, so draws no tracer: its frames are
  // the flash lighting the walls and the strike's dust. Over the parapet the tracers fly.
  const stand = (view: 'bay' | 'step', hours: number, pitch = 0) =>
    hooks(
      page,
      async (h, arg) => {
        const { view, hours, pitch } = arg as { view: 'bay' | 'step'; hours: number; pitch: number };
        const v = h.views[view];
        h.teleport({ position: [v.position[0], v.position[1] - 1.62, v.position[2]], yaw: v.yaw, pitch });
        h.setTimeOfDay(hours);
        await h.waitFrames(120);
      },
      { view, hours, pitch },
    );
  // Frozen, a frame at a time, until one shows a shot's star (and a tracer, if asked); then that frame.
  const burst = async (path: string, tracer: boolean) => {
    const caught = await hooks(
      page,
      async (h, tracer) => {
        h.freeze();
        (h.session.weapon as { rounds: number }).rounds = 30;
        h.trigger(true);
        for (let k = 0; k < 90; k++) {
          await h.stepFrames(1);
          const e = h.effects();
          if (k > 20 && e.stars > 0 && (!tracer || e.tracers > 0)) return true;
        }
        return false;
      },
      tracer,
    );
    await page.screenshot({ path });
    await hooks(page, (h) => {
      h.trigger(false);
      h.thaw();
    });
    if (!caught) throw new Error(`no frame with a flash and a tracer for ${path}`);
  };
  await stand('bay', DUSK);
  await page.screenshot({ path: 'artifacts/c3/bay-rifle-dusk.png' });
  await burst('artifacts/c3/bay-burst-dusk.png', false);
  await stand('bay', 21);
  await burst('artifacts/c3/bay-burst-night.png', false);
  await stand('step', DUSK);
  await page.screenshot({ path: 'artifacts/c3/step-rifle-dusk.png' });
  await burst('artifacts/c3/step-burst-dusk.png', true);
  await stand('step', 21);
  await burst('artifacts/c3/step-burst-night.png', true);
  if (errors.length) throw new Error(errors.join('\n'));
});
