import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { P } from '../../src/world/materials';
import { useManyLights } from './many-lights';
import { hooks, openGame } from './support/app';
import { digAlong, fireInTheBay, shellTheBay, type ShelledBay } from './support/bay';

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

// Combat milestone 4's review: a 3 m shell on the parapet's crest ahead of the step, seen from the
// ground behind the trench, 12 m back, across it, at dusk and at night: before, the frames of its
// blast (its light, flash, soil and debris), and once its crater is in and its smoke hangs. Written
// to artifacts/c4. (A bay is 8 m between traverses: inside one, the crater's slump takes the eye.)
test('a shell on the parapet, before, during and after', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await openGame(page);
  await hooks(page, (h) => h.setQuality({ preset: 'high', dynres: false }));
  await hooks(page, (h) => h.play());
  // The highest ground within 3 m ahead of the step: its parapet's crest.
  const crest = await hooks(page, (h) => {
    const v = h.views.step;
    const yaw = (v.yaw * Math.PI) / 180;
    let best: [number, number, number] = [v.position[0], -1, v.position[2]];
    for (let d = 0; d <= 3; d += 0.1) {
      const x = v.position[0] + Math.sin(yaw) * d;
      const z = v.position[2] + Math.cos(yaw) * d;
      let y = 319;
      while (y >= 0 && h.world.map.get(Math.floor(x / 0.1), y, Math.floor(z / 0.1)) === 0) y--;
      if ((y + 1) * 0.1 > best[1]) best = [x, (y + 1) * 0.1, z];
    }
    return best;
  });
  for (const [label, hours] of [['dusk', DUSK], ['night', 21]] as const) {
    // On the ground behind the trench, 12 m back from the crest along the step's view, facing it.
    await hooks(
      page,
      async (h, arg) => {
        const { hours, crest } = arg as { hours: number; crest: [number, number, number] };
        const v = h.views.step;
        const yaw = (v.yaw * Math.PI) / 180;
        const [x, z] = [crest[0] - Math.sin(yaw) * 12, crest[2] - Math.cos(yaw) * 12];
        let y = 319;
        while (y >= 0 && h.world.map.get(Math.floor(x / 0.1), y, Math.floor(z / 0.1)) === 0) y--;
        h.teleport({ position: [x, (y + 1) * 0.1, z], yaw: v.yaw, pitch: -6 });
        h.setTimeOfDay(hours);
        await h.waitFrames(120);
      },
      { hours, crest },
    );
    await page.screenshot({ path: `artifacts/c4/parapet-before-${label}.png` });
    await hooks(page, async (h, at) => {
      h.freeze();
      void h.shell(at as [number, number, number], 3);
      await h.stepFrames(3);
    }, crest);
    await page.screenshot({ path: `artifacts/c4/parapet-blast-${label}.png` });
    await hooks(page, async (h) => {
      await h.stepFrames(12);
    });
    await page.screenshot({ path: `artifacts/c4/parapet-soil-${label}.png` });
    await hooks(page, async (h) => {
      h.thaw();
      await h.waitFrames(150);
    });
    await page.screenshot({ path: `artifacts/c4/parapet-after-${label}.png` });
  }
  if (errors.length) throw new Error(errors.join('\n'));
});

// Combat milestone 5's review: a 3 m shell on the parapet's crest across from the spawn slumps it
// into the bay; the player stands 2.5 m along the bay and digs toward the slump as a person would
// (F held, stepping in when nothing is in reach, at most 2.5 m), at dusk. The bay from a fixed
// vantage over their shoulder, 3.5 m up, looking down on the ground they dig through, before, after
// 20 s and after 40 s; and the player's own view, with the HUD, 10 s in. Written to artifacts/c5.
test('digging out a slumped bay', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = await openGame(page);
  await page.locator('#play').click();
  await expect(page.locator('#loading')).toBeHidden();
  await hooks(page, (h, t) => {
    h.setQuality({ preset: 'high', dynres: false });
    h.setTimeOfDay(t as number);
  }, DUSK);
  const bay = await shellTheBay(page);
  const look = async (name: string) => {
    await hooks(page, async (h, a) => {
      const { vantage, yaw } = a as ShelledBay;
      h.flyTo({ position: vantage, yaw, pitch: -55 });
      await h.waitFrames(120);
    }, bay);
    await page.screenshot({ path: `artifacts/c5/${name}.png` });
    await hooks(page, async (h) => {
      h.walk();
      await h.waitFrames(5);
    });
  };
  await look('dig-before-dusk');
  await digAlong(page, bay, 20, 2.5, async (k) => {
    if (k === 40) await page.screenshot({ path: 'artifacts/c5/dig-hud-dusk.png' });
  });
  await look('dig-20s-dusk');
  await digAlong(page, bay, 20);
  await look('dig-40s-dusk');
  const cleared = await hooks(page, (h) => h.session.entrenching.cleared);
  console.log(`Digging out a slumped bay: ${cleared} voxels cleared in 40 s`);
  expect(cleared).toBeGreaterThan(1000);
  if (errors.length) throw new Error(errors.join('\n'));
});

// Combat milestone 5's review: on the firing step, calm; the same frame at full suppression (frozen,
// the look alone); and with the front's fire heavy, a second and a half in: the picture greyed and
// closed in, the player pinned and pushed off the step. At dusk and at night; written to artifacts/c5.
test('suppression under heavy fire', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await openGame(page);
  await page.locator('#play').click();
  await expect(page.locator('#loading')).toBeHidden();
  for (const [label, hours] of [['dusk', DUSK], ['night', 21]] as const) {
    await hooks(page, async (h, t) => {
      h.setQuality({ preset: 'high', dynres: false });
      h.setIntensity('off');
      h.setShelling('off');
      h.setTimeOfDay(t as number);
      h.session.suppression.level = 0;
      const v = h.views.step;
      h.teleport({ position: [v.position[0], v.position[1] - 1.62, v.position[2]], yaw: v.yaw, pitch: 0 });
      await h.waitFrames(120);
    }, hours);
    await page.screenshot({ path: `artifacts/c5/step-calm-${label}.png` });
    await hooks(page, async (h) => {
      h.freeze();
      h.session.suppression.level = 1;
      await h.stepFrames(1);
    });
    await page.screenshot({ path: `artifacts/c5/step-look-full-${label}.png` });
    await hooks(page, async (h) => {
      h.session.suppression.level = 0;
      h.thaw();
      await h.waitFrames(60);
      h.setIntensity('heavy');
      await h.waitFrames(90);
    });
    const level = await hooks(page, (h) => h.session.suppression.level);
    await page.screenshot({ path: `artifacts/c5/step-suppressed-${label}.png` });
    console.log(`Suppression under heavy fire at ${label}: level ${level.toFixed(2)}`);
    expect(level).toBeGreaterThan(0.6);
    await hooks(page, (h) => h.setIntensity('off'));
  }
  if (errors.length) throw new Error(errors.join('\n'));
});

// Battle milestone 1's review: the battle's flares over no man's land at night (the front light, two
// minutes in, and twenty seconds later); and from the firing step, a flare fired and bursting: its
// spark climbing, its burst, and burning as it drifts. Written to artifacts/b1.
test("flares over no man's land, and one fired and bursting", async ({ page }) => {
  test.setTimeout(300_000);
  const errors = await openGame(page);
  await hooks(page, async (h) => {
    h.setQuality({ preset: 'high', dynres: false });
    h.view('nml-night');
    h.setTimeOfDay(21);
    h.setIntensity('light');
    h.runLights(120);
    await h.waitFrames(90);
  });
  await page.screenshot({ path: 'artifacts/b1/nml-flares-a.png' });
  await hooks(page, (h) => h.waitFrames(1200));
  await page.screenshot({ path: 'artifacts/b1/nml-flares-b.png' });
  // From the firing step, the front heavy: the first flare fired 50–140 m off and ahead of the step,
  // the camera turned to it and raised toward its burst, 30–50 m up, so its climb and burst are in frame.
  await hooks(page, async (h) => {
    h.view('step');
    h.setTimeOfDay(21);
    h.setIntensity('heavy');
    h.runLights(0);
    await h.waitFrames(30);
  });
  const found = await hooks(page, async (h) => {
    const v = h.views.step;
    const yaw = (v.yaw * Math.PI) / 180;
    const ahead = [Math.sin(yaw), Math.cos(yaw)];
    for (let k = 0; k < 900; k++) {
      await h.waitFrames(2);
      for (const f of h.battle().flares) {
        if (f.stage !== 'climb') continue;
        const d = [f.position[0] - v.position[0], f.position[2] - v.position[2]];
        const far = Math.hypot(d[0], d[1]);
        if (far < 50 || far > 140 || (d[0] * ahead[0] + d[1] * ahead[1]) / far < Math.cos((70 * Math.PI) / 180)) continue;
        h.flyTo({ position: v.position, yaw: (Math.atan2(d[0], d[1]) * 180) / Math.PI, pitch: ((Math.atan2(30, far) * 180) / Math.PI) * 0.8 });
        await h.waitFrames(10);
        return f.id;
      }
    }
    return null;
  });
  expect(found, 'no flare fired 50–140 m ahead of the step in 30 s').not.toBeNull();
  await page.screenshot({ path: 'artifacts/b1/flare-climbing.png' });
  await hooks(page, async (h, id) => {
    for (let k = 0; k < 300; k++) {
      await h.waitFrames(1);
      if (h.battle().flares.find((f) => f.id === id)?.stage === 'burning') break;
    }
    await h.waitFrames(20);
  }, found);
  await page.screenshot({ path: 'artifacts/b1/flare-burst.png' });
  await hooks(page, (h) => h.waitFrames(300));
  await page.screenshot({ path: 'artifacts/b1/flare-burning.png' });
  if (errors.length) throw new Error(errors.join('\n'));
});

// Battle milestone 2's review: a barrage on the horizon at dusk and at night, from the firing step, the
// battle held at a shell's flash 0.02 s old with the camera turned to it, beside the moment half a second
// before; and a far shell's flash and its column of smoke 20 s on, at dusk. Written to artifacts/b2.
type Landed = { t: number; position: number[]; eye: number[] };
/** From the step, the front heavy: the first far shell, or shell beyond the map within `withinM`, to land. */
const firstLanded = (page: Page, hours: number, far: boolean, withinM = Infinity): Promise<Landed | null> =>
  hooks(
    page,
    async (h, a) => {
      const { hours: at, far: wantFar, within } = a as { hours: number; far: boolean; within: number };
      h.setQuality({ preset: 'high', dynres: false });
      h.view('step');
      h.setTimeOfDay(at);
      h.setIntensity('heavy');
      h.runLights(120);
      for (let k = 0; k < 7200; k++) {
        await h.waitFrames(1);
        const eye = h.views.step.position;
        const f = h.battle().flashes.find((s) => s.far === wantFar && h.battle().seconds - s.t < 0.1 && Math.hypot(s.position[0] - eye[0], s.position[2] - eye[2]) <= within);
        if (f) return { t: f.t, position: f.position, eye: h.views.step.position };
      }
      return null;
    },
    { hours, far, within: withinM },
  );
/** The battle held at `at` (its clock, seconds), the camera at the shell's eye turned to it and `upDeg` above it, settled; then photographed to `path`, what it held logged. */
const heldOn = async (page: Page, shell: Landed, at: number, upDeg: number, path: string) => {
  await hooks(
    page,
    async (h, a) => {
      const { shell: s, at: t, up } = a as { shell: Landed; at: number; up: number };
      h.holdLights(t);
      const d = [s.position[0] - s.eye[0], s.position[2] - s.eye[2]];
      const far = Math.hypot(d[0], d[1]);
      const pitch = (Math.atan2(s.position[1] - s.eye[1], far) * 180) / Math.PI + up;
      h.flyTo({ position: s.eye as [number, number, number], yaw: (Math.atan2(d[0], d[1]) * 180) / Math.PI, pitch });
      await h.waitFrames(90);
    },
    { shell, at, up: upDeg },
  );
  const held = await hooks(page, (h) => ({ flashes: h.horizon().length, smoke: h.battle().smoke.length, billboards: h.effects().billboards }));
  const metres = Math.hypot(shell.position[0] - shell.eye[0], shell.position[2] - shell.eye[2]);
  console.log(`${path}: the shell ${metres.toFixed(0)} m off (${shell.position.map((v) => v.toFixed(0)).join(', ')}), eye ${shell.eye.map((v) => v.toFixed(0)).join(', ')}; ${held.flashes} flashes, ${held.smoke} puffs, ${held.billboards} billboards drawn`);
  await page.screenshot({ path });
};

test('a barrage on the horizon at dusk and at night, and a far shell flashing and smoking', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = await openGame(page);
  const look = (shell: Landed, at: number, upDeg: number, file: string) => heldOn(page, shell, at, upDeg, `artifacts/b2/${file}.png`);
  // At dusk a barrage reads against the bright haze only from a few kilometres: one within 2.5 km.
  for (const [name, hours, within] of [['dusk', 17 + 35 / 60, 2500], ['night', 21, Infinity]] as const) {
    const shell = await firstLanded(page, hours, false, within);
    expect(shell, `no barrage's shell landed in a minute at ${name}`).not.toBeNull();
    await look(shell!, shell!.t + 0.02, 3, `barrage-${name}`);
    await look(shell!, shell!.t - 0.5, 3, `barrage-${name}-before`);
  }
  const far = await firstLanded(page, 17 + 35 / 60, true);
  expect(far, 'no far shell landed in a minute at dusk').not.toBeNull();
  await look(far!, far!.t + 0.05, 2, 'far-flash-dusk');
  await look(far!, far!.t + 20, 6, 'far-smoke-dusk');
  // And from the overview, over the field.
  const overview = await hooks(page, (h) => h.views.overview.position);
  await look({ ...far!, eye: overview }, far!.t + 0.05, 0, 'far-flash-dusk-overview');
  await look({ ...far!, eye: overview }, far!.t + 20, 3, 'far-smoke-dusk-overview');
  const farNight = await firstLanded(page, 21, true);
  expect(farNight, 'no far shell landed in a minute at night').not.toBeNull();
  await look({ ...farNight!, eye: overview }, farNight!.t + 0.05, 0, 'far-flash-night-overview');
  await look({ ...farNight!, eye: overview }, farNight!.t + 20, 3, 'far-smoke-night-overview');
  if (errors.length) throw new Error(errors.join('\n'));
});

// Battle milestone 3's review: tracers over the field at night, from the firing step and from the
// overview, the front at light and at heavy, two minutes into the battle. Written to artifacts/b3.
test('tracers over the field at night', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await openGame(page);
  for (const view of ['step', 'overview'] as const) {
    for (const intensity of ['light', 'heavy'] as const) {
      await hooks(
        page,
        async (h, a) => {
          const { view: v, intensity: i } = a as { view: string; intensity: 'light' | 'heavy' };
          h.setQuality({ preset: 'high', dynres: false });
          h.view(v);
          h.setTimeOfDay(21);
          h.setIntensity(i);
          h.runLights(120);
          await h.waitFrames(90);
        },
        { view, intensity },
      );
      await page.screenshot({ path: `artifacts/b3/tracers-${view}-${intensity}.png` });
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
});

// Battle milestone 4's captures (artifacts/b4): a fire struck in the bay at dusk, burning and
// smoking, from along the bay and from over it, and what it charred once it has burnt out; the
// hamlet's fires at night from its view, near one, and from the overview.
type Pose = { position: [number, number, number]; yaw: number; pitch: number };
/** From `from` looking at `to` (metres). */
const looking = (from: [number, number, number], to: readonly number[]): Pose => {
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  return { position: from, yaw: (Math.atan2(d[0], d[2]) * 180) / Math.PI, pitch: (Math.atan2(d[1], Math.hypot(d[0], d[2])) * 180) / Math.PI };
};

test('a fire burning in the bay and its smoke at dusk', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = await openGame(page);
  await hooks(page, (h, dusk) => {
    h.setQuality({ preset: 'high', dynres: false });
    h.setTimeOfDay(dusk as number);
  }, DUSK);
  const { fire, shells } = await fireInTheBay(page);
  if (!fire) throw new Error(`no fire from ${shells} shells on the bay's timber`);
  const bay = await hooks(page, (h) => h.world.spawn.bay);
  // Along the bay 5 m, at the eye's height; and over it, 6 m along and 3 m back of the trench, 4.5 m up.
  const at = fire.at;
  const along = (m: number, up: number, back = 0): [number, number, number] => {
    const p: [number, number, number] = [at[0], at[1] + up, at[2]];
    p[bay.longAxis] += m;
    p[bay.longAxis === 0 ? 2 : 0] -= bay.facing * back;
    return p;
  };
  const views: [string, Pose][] = [
    ['along', looking(along(5, 1.6), [at[0], at[1] + 0.6, at[2]])],
    ['over', looking(along(6, 4.5, 3), [at[0], at[1] + 2, at[2]])],
  ];
  // Held at each vantage while the session runs on (spectating: flying, it would stand still, and
  // the shell's soil and smoke with it), the shell's smoke gone (15 s) and the fire at its full burn;
  // then burnt out, what it charred, the exposure come back to dusk from the fire's light.
  await hooks(page, async (h, p) => {
    h.spectate(p as Pose);
    await h.waitFrames(960);
    h.advanceBattle(10);
  }, views[0][1]);
  for (const [name, pose] of views) {
    await hooks(page, async (h, p) => {
      h.spectate(p as Pose);
      await h.waitFrames(120);
    }, pose);
    await page.screenshot({ path: `artifacts/b4/bay-fire-${name}-dusk.png` });
  }
  await hooks(page, async (h, p) => {
    h.advanceBattle(500);
    h.spectate(p as Pose);
    await h.waitFrames(600);
  }, views[0][1]);
  await page.screenshot({ path: 'artifacts/b4/bay-char-along-dusk.png' });
  // And at noon, where the char shows against the duckboards it did not reach.
  await hooks(page, async (h) => {
    h.setTimeOfDay(12);
    await h.waitFrames(300);
  });
  await page.screenshot({ path: 'artifacts/b4/bay-char-along-noon.png' });
  if (errors.length) throw new Error(errors.join('\n'));
});

test('the hamlet burning at night', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await openGame(page);
  await hooks(page, async (h) => {
    h.setQuality({ preset: 'high', dynres: false });
    h.view('hamlet');
    h.setTimeOfDay(22);
    h.runLights(60);
    await h.waitFrames(120);
  });
  await page.screenshot({ path: 'artifacts/b4/hamlet-burning-night.png' });
  // 8 m from the nearest fire, 3 m up, looking at its flames.
  await hooks(page, async (h) => {
    const eye = h.camera().position;
    const near = (a: readonly number[]) => Math.hypot(a[0] - eye[0], a[2] - eye[2]);
    const f = [...h.battle().fires].sort((x, y) => near(x.at) - near(y.at))[0];
    h.flyTo({ position: [f.at[0], f.at[1] + 3, f.at[2] - 8], yaw: 0, pitch: (Math.atan2(-2.4, 8) * 180) / Math.PI });
    await h.waitFrames(120);
  });
  await page.screenshot({ path: 'artifacts/b4/hamlet-fire-near-night.png' });
  // The overview, timber struck across its view as the perf test's burning night has it: the fires at the cap.
  await hooks(page, async (h, timber) => {
    h.view('overview');
    h.setTimeOfDay(22);
    h.runLights(60);
    const c = h.camera();
    const yaw = (c.yaw * Math.PI) / 180;
    const strikes = Array.from({ length: 36 }, (_, k) => {
      const d = 20 + (k % 6) * 15;
      const side = ((Math.floor(k / 6) - 2.5) / 2.5) * 0.4 * d;
      const x = c.position[0] + Math.sin(yaw) * d + Math.cos(yaw) * side;
      const z = c.position[2] + Math.cos(yaw) * d - Math.sin(yaw) * side;
      let y = 300;
      while (y > 0 && h.world.map.get(Math.floor(x / 0.1), y - 1, Math.floor(z / 0.1)) === 0) y--;
      return { at: [x, y * 0.1, z] as [number, number, number], material: timber as number, crater: null };
    });
    h.advanceBattle(25, strikes);
    await h.waitFrames(120);
  }, P.TIMBER);
  await page.screenshot({ path: 'artifacts/b4/overview-burning-night.png' });
  if (errors.length) throw new Error(errors.join('\n'));
});

// Battle milestone 5's captures (artifacts/b5): the flooded crater in front of the view over no
// man's land, seen from over its near rim: at night under a flare hung where its mirror image lies
// in the crater's water, on the high preset (the world traced) and the low (the sky and the glints
// alone, as the water was); and at dusk, its lit sides in its water, and rings spreading over it.
const CRATER: { eye: [number, number, number]; pool: [number, number, number] } = { eye: [130, 18, 134], pool: [130.5, 12.6, 139.5] };

test("a crater's water reflecting a flare at night", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await openGame(page);
  // Hung 9.4 m over the water and 10 m beyond the pool's middle along the eye's line to it, so its mirror image lies in the pool.
  const flare = { position: [131.4, 22, 149.1] as [number, number, number], radius: 65, colour: [1, 0.88, 0.7] as [number, number, number], intensity: 260, kind: 'flare' as const, phase: 0 };
  for (const preset of ['high', 'low'] as const) {
    await hooks(page, async (h, a) => {
      const { preset, flare, pose } = a as { preset: 'high' | 'low'; flare: never; pose: Pose };
      h.setQuality({ preset, dynres: false });
      h.view('nml-night');
      h.setTimeOfDay(21);
      h.useLights([...h.lights(), flare]);
      h.holdLights();
      h.flyTo(pose);
      await h.waitFrames(150);
    }, { preset, flare, pose: looking(CRATER.eye, CRATER.pool) });
    await page.screenshot({ path: `artifacts/b5/crater-flare-night-${preset}.png` });
  }
  if (errors.length) throw new Error(errors.join('\n'));
});

/** Just over the pool's far end, 0.6 m above the water, looking back across it, away from the low sun: its sunlit side in it. */
const GRAZING: Pose = { position: [130, 13.2, 142], yaw: 180, pitch: -4 };

test('a lit wall in water, and rings spreading', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await openGame(page);
  // At dusk, the battle running, just over the crater's water: its sunlit side in it; then a shell's
  // splash in the pool and two rounds' beside it, and the rings 0.5 s and 1.5 s on.
  await hooks(page, async (h, a) => {
    const { pose, dusk } = a as { pose: Pose; dusk: number };
    h.setQuality({ preset: 'high', dynres: false });
    h.setTimeOfDay(dusk);
    h.runLights();
    h.flyTo(pose);
    await h.waitFrames(150);
  }, { pose: GRAZING, dusk: DUSK });
  await page.screenshot({ path: 'artifacts/b5/crater-dusk-still.png' });
  await hooks(page, async (h, p) => {
    const at = p as [number, number, number];
    h.advanceBattle(0.02, [], [
      { at, energyJ: 3e6 },
      { at: [at[0] + 1.2, at[1], at[2] - 0.8], energyJ: 1500 },
      { at: [at[0] - 1, at[1], at[2] + 0.6], energyJ: 1500 },
    ]);
    await h.waitFrames(30);
  }, CRATER.pool);
  await page.screenshot({ path: 'artifacts/b5/crater-dusk-rings-0.5s.png' });
  await hooks(page, async (h) => {
    await h.waitFrames(60);
  });
  await page.screenshot({ path: 'artifacts/b5/crater-dusk-rings-1.5s.png' });
  if (errors.length) throw new Error(errors.join('\n'));
});

test("the battle's flares in a crater's water at night", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await openGame(page);
  // Heavy, two minutes in: the battle's flares over no man's land, from just over the crater's water.
  for (const preset of ['high', 'low'] as const) {
    await hooks(page, async (h, a) => {
      const { preset, pose } = a as { preset: 'high' | 'low'; pose: Pose };
      h.setQuality({ preset, dynres: false });
      h.view('nml-night');
      h.setTimeOfDay(21);
      h.setIntensity('heavy');
      h.runLights(120);
      h.flyTo(pose);
      await h.waitFrames(150);
    }, { preset, pose: GRAZING });
    await page.screenshot({ path: `artifacts/b5/crater-battle-night-${preset}.png` });
  }
  if (errors.length) throw new Error(errors.join('\n'));
});

// Battle milestone 6's review captures (artifacts/b6): the battle at its close, each part of it where
// it shows, the front heavy — no man's land at night under its flares, at the first moment from two
// minutes in with fifteen burning; a barrage on the horizon at dusk from the firing step, held at a
// shell's flash; tracers over the field at night from the overview; a fire burning in the bay and its
// smoke at dusk; a crater's water reflecting the flares at night, from its rim and from just over it;
// and the hamlet burning at night.
test("the battle's review captures", async ({ page }) => {
  test.setTimeout(600_000);
  const errors = await openGame(page);
  const shot = (name: string) => page.screenshot({ path: `artifacts/b6/${name}.png` });
  /** The heavy night sought to its first moment from two minutes in with fifteen flares burning. */
  const flaresAtTheirMost = () =>
    hooks(page, async (h) => {
      h.setTimeOfDay(21);
      h.setIntensity('heavy');
      let at = 120;
      for (; at < 900; at += 5) {
        h.runLights(at);
        await h.waitFrames(1);
        if (h.battle().flares.filter((f) => f.stage === 'burning').length >= 15) break;
      }
      return at;
    });
  await hooks(page, (h) => {
    h.setQuality({ preset: 'high', dynres: false });
    h.view('nml-night');
  });
  const at = await flaresAtTheirMost();
  // Turned to where the flares hang (their mean bearing from the eye) and raised to 10° under their
  // mean height (0–25°): they burst 25–40 m up, above a level eye's frame.
  const turned = await hooks(page, async (h) => {
    const v = h.views['nml-night'];
    const burning = h.battle().flares.filter((f) => f.stage === 'burning');
    let across = 0;
    let along = 0;
    let up = 0;
    for (const f of burning) {
      const dx = f.position[0] - v.position[0];
      const dz = f.position[2] - v.position[2];
      const d = Math.hypot(dx, dz);
      across += dx / d;
      along += dz / d;
      up += Math.atan2(f.position[1] - v.position[1], d);
    }
    const yaw = (Math.atan2(across, along) * 180) / Math.PI;
    const pitch = Math.min(25, Math.max(0, ((up / burning.length) * 180) / Math.PI - 10));
    h.flyTo({ position: v.position, yaw, pitch });
    await h.waitFrames(90);
    return { yaw, pitch, burning: burning.length };
  });
  console.log(`no man's land under the flares: ${turned.burning} burning, the eye turned to ${turned.yaw.toFixed(0)}°, raised ${turned.pitch.toFixed(0)}°`);
  await shot('nml-flares-night');
  // The barrage at dusk: its shell within 2.5 km (beyond, a barrage does not read against the bright haze).
  const shell = await firstLanded(page, DUSK, false, 2500);
  expect(shell, "no barrage's shell landed in a minute at dusk").not.toBeNull();
  await heldOn(page, shell!, shell!.t + 0.02, 3, 'artifacts/b6/barrage-dusk.png');
  await heldOn(page, shell!, shell!.t - 0.5, 3, 'artifacts/b6/barrage-dusk-before.png');
  // Tracers over the field from the overview, the night heavy at its flares' most.
  await hooks(page, (h) => {
    h.runLights();
    h.view('overview');
  });
  await flaresAtTheirMost();
  await hooks(page, (h) => h.waitFrames(90));
  await shot('tracers-overview-night');
  // The crater's water under the night's flares, the battle held at the moment: from 2.5 m over the
  // water, looking down at the pool's middle from across it from a burning flare, so that flare's
  // mirror image lies there — the flare nearest 50° up from it, and at least 42° (lower, the crater's
  // far wall stands between the water and the flare); and from just over its far end.
  const mirrored = await hooks(page, async (h, a) => {
    const { at, pool } = a as { at: number; pool: [number, number, number] };
    h.view('nml-night');
    h.setTimeOfDay(21);
    h.runLights(at);
    await h.waitFrames(1);
    const up = 2.5;
    let best: { pose: Pose; off: number; flare: number[] } | null = null;
    for (const f of h.battle().flares) {
      if (f.stage !== 'burning') continue;
      const dx = f.position[0] - pool[0];
      const dz = f.position[2] - pool[2];
      const across = Math.hypot(dx, dz);
      const elevation = (Math.atan2(f.position[1] - pool[1], across) * 180) / Math.PI;
      const back = (up * across) / (f.position[1] - pool[1]);
      const eye: [number, number, number] = [pool[0] - (dx / across) * back, pool[1] + up, pool[2] - (dz / across) * back];
      const pose = { position: eye, yaw: (Math.atan2(dx, dz) * 180) / Math.PI, pitch: (Math.atan2(-up, back) * 180) / Math.PI };
      const off = elevation < 42 ? 90 + Math.abs(elevation - 50) : Math.abs(elevation - 50);
      if (!best || off < best.off) best = { pose, off, flare: f.position };
    }
    h.holdLights(h.battle().seconds);
    h.flyTo(best!.pose);
    await h.waitFrames(150);
    return best;
  }, { at, pool: CRATER.pool });
  console.log(`the crater's water: the flare at ${mirrored!.flare.map((v) => v.toFixed(1)).join(', ')}, the eye at ${mirrored!.pose.position.map((v) => v.toFixed(1)).join(', ')}`);
  await shot('crater-flare-night-mirror');
  await hooks(page, async (h, pose) => {
    h.flyTo(pose as Pose);
    await h.waitFrames(150);
  }, GRAZING);
  await shot('crater-flares-night-grazing');
  await hooks(page, (h) => h.runLights());
  // The hamlet burning, as the hamlet's view has it at 22:00, its fires lit an hour on.
  await hooks(page, async (h) => {
    h.view('hamlet');
    h.setTimeOfDay(22);
    h.runLights(60);
    await h.waitFrames(120);
  });
  await shot('hamlet-burning-night');
  // A fire in the bay at dusk at its full burn, from along the bay and from over it (as B4's, the
  // front at its default, light): the battle sought afresh at dusk, so no night's flare lingers.
  await hooks(page, (h, dusk) => {
    h.setIntensity('light');
    h.setTimeOfDay(dusk as number);
    h.runLights(120);
  }, DUSK);
  const { fire, shells } = await fireInTheBay(page);
  if (!fire) throw new Error(`no fire from ${shells} shells on the bay's timber`);
  const bay = await hooks(page, (h) => h.world.spawn.bay);
  const along = (m: number, up: number, back = 0): [number, number, number] => {
    const p: [number, number, number] = [fire.at[0], fire.at[1] + up, fire.at[2]];
    p[bay.longAxis] += m;
    p[bay.longAxis === 0 ? 2 : 0] -= bay.facing * back;
    return p;
  };
  const views: [string, Pose][] = [
    ['along', looking(along(5, 1.6), [fire.at[0], fire.at[1] + 0.6, fire.at[2]])],
    ['over', looking(along(6, 4.5, 3), [fire.at[0], fire.at[1] + 2, fire.at[2]])],
  ];
  await hooks(page, async (h, p) => {
    h.spectate(p as Pose);
    await h.waitFrames(960);
    h.advanceBattle(10);
  }, views[0][1]);
  for (const [name, pose] of views) {
    await hooks(page, async (h, p) => {
      h.spectate(p as Pose);
      await h.waitFrames(120);
    }, pose);
    await shot(`bay-fire-${name}-dusk`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
});

// The showcase's first impression (artifacts/s2): the loading screen over the game's still while the
// world is made, and over the live world once it is drawn, at three window shapes, for the framing to
// be compared (the still is fitted to the window's width, as the camera's field of view is horizontal).
test('the loading screen over the still, and over the live world, at three window shapes', async ({ browser }) => {
  test.setTimeout(240_000);
  for (const [name, viewport] of [['16x9', { width: 1600, height: 900 }], ['4x3', { width: 1400, height: 1050 }], ['21x9', { width: 2100, height: 900 }]] as const) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto('/');
    await page.waitForFunction(() => (document.getElementById('still') as HTMLImageElement | null)?.complete === true);
    await page.screenshot({ path: `artifacts/s2/loading-${name}.png` });
    await page.waitForFunction(() => (window as unknown as { __trenchline?: { ready?: boolean } }).__trenchline?.ready === true, null, { timeout: 90_000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `artifacts/s2/ready-${name}.png` });
    await context.close();
  }
});

// The showcase's video fallback (artifacts/s3): a desktop browser without WebGPU, and a phone (touch
// alone), each with the game's video playing behind the title, 3 s in.
test('the video where the game cannot run: a desktop without WebGPU, and a phone', async ({ browser }) => {
  test.setTimeout(120_000);
  for (const [name, options] of [
    ['desktop-no-webgpu', { viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 }],
    ['phone', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true }],
  ] as const) {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    if (name === 'desktop-no-webgpu') await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true }));
    await page.goto('/');
    await page.waitForFunction(() => ((document.getElementById('motion') as HTMLVideoElement | null)?.currentTime ?? 0) > 3, null, { timeout: 30_000 });
    await page.screenshot({ path: `artifacts/s3/fallback-${name}.png` });
    await context.close();
  }
});

// The showcase's quality tiers (artifacts/s4): the note over the loading screen after a first visit is
// moved to low (an impossible budget forced with ?budget=1).
test('the note after a first visit moves to low', async ({ page }) => {
  await page.goto('/?budget=1');
  await expect(page.locator('#note')).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'artifacts/s4/note-low.png' });
});

// The showcase's portfolio card (artifacts/s5): the user's portfolio site opened from disk read-only, the
// card in place of its first placeholder project in the browser's copy of the page, as the card's note
// says (the site lays three across). No file of the site is written: its files' sizes and times are the
// same after. Skipped where the site is not on the machine.
test("the card among the portfolio's projects", async ({ page }) => {
  const site = join(homedir(), 'repos/portfolio-website');
  test.skip(!existsSync(join(site, 'index.html')), 'the portfolio site is not on this machine');
  const stamp = () =>
    readdirSync(site, { recursive: true })
      .map((f) => {
        const s = statSync(join(site, String(f)));
        return `${String(f)} ${s.size} ${s.mtimeMs}`;
      })
      .sort()
      .join('\n');
  const before = stamp();
  await page.goto(pathToFileURL(join(site, 'index.html')).href);
  const card = readFileSync('showcase/portfolio/card.html', 'utf8')
    .replace(/<!--[\s\S]*?-->/, '')
    .replace('./assets/trenchline.webp', pathToFileURL(resolve('showcase/portfolio/trenchline.webp')).href);
  await page.evaluate((html) => document.querySelector('#projects .about-containers > .details-container')!.outerHTML = html, card);
  const projects = page.locator('#projects');
  await projects.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => [...document.querySelectorAll('#projects img')].every((i) => (i as HTMLImageElement).complete));
  await projects.screenshot({ path: 'artifacts/s5/portfolio-card.png' });
  expect(stamp()).toBe(before);
});
