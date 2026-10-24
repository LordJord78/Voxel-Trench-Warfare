import { expect, test, type Page } from '@playwright/test';
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

// The spec's "dusk shows the distant artillery and the smoke", from the firing step, the front heavy:
// a shell's moment against half a second before it landed, in a box round where it stands, the
// camera turned to it and raised `up` degrees.
type Landed = { t: number; position: number[]; eye: number[] };
async function firstLanded(page: Page, far: boolean, withinM = Infinity): Promise<Landed> {
  const shell = await hooks(
    page,
    async (h, a) => {
      const { far: wantFar, within } = a as { far: boolean; within: number };
      h.setQuality({ preset: 'high', dynres: false });
      h.view('step');
      h.setTimeOfDay(17 + 35 / 60);
      h.setIntensity('heavy');
      h.runLights(120);
      for (let k = 0; k < 7200; k++) {
        await h.waitFrames(1);
        const eye = h.views.step.position;
        const f = h.battle().flashes.find((s) => s.far === wantFar && h.battle().seconds - s.t < 0.1 && Math.hypot(s.position[0] - eye[0], s.position[2] - eye[2]) <= within);
        if (f) return { t: f.t, position: f.position, eye };
      }
      return null;
    },
    { far, within: withinM },
  );
  expect(shell, `no ${far ? 'far shell' : "barrage's shell"} landed in two minutes`).not.toBeNull();
  return shell!;
}
/** The canvas's mean in a box `across` wide (a fraction of it) from `aboveDeg` over the shell's ground to `belowDeg` under it, the battle held at `at`. */
async function boxMean(page: Page, shell: Landed, at: number, up: number, across: number, aboveDeg: number, belowDeg: number): Promise<number> {
  return hooks(
    page,
    async (h, a) => {
      const { shell: s, at: t, up: u, across: w, above, below } = a as { shell: Landed; at: number; up: number; across: number; above: number; below: number };
      h.holdLights(t);
      const d = [s.position[0] - s.eye[0], s.position[2] - s.eye[2]];
      const pitch = (Math.atan2(s.position[1] - s.eye[1], Math.hypot(d[0], d[1])) * 180) / Math.PI + u;
      h.flyTo({ position: s.eye as [number, number, number], yaw: (Math.atan2(d[0], d[1]) * 180) / Math.PI, pitch });
      await h.waitFrames(90);
      // Where an angle under the view's middle falls on the canvas, as a fraction of its height.
      const tanHalfV = Math.tan((((h.camera().fov ?? 90) / 2) * Math.PI) / 180) / (innerWidth / innerHeight);
      const at = (deg: number) => 0.5 + Math.tan((deg * Math.PI) / 180) / (2 * tanHalfV);
      return (await h.snapshot([0.5 - w / 2, at(u - above), 0.5 + w / 2, at(u + below)])).region;
    },
    { shell, at, up, across, above: aboveDeg, below: belowDeg },
  );
}

test('at dusk from the step, a barrage beyond the map brightens the horizon toward it', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = await openGame(page);
  const shell = await firstLanded(page, false);
  const lit = await boxMean(page, shell, shell.t + 0.02, 3, 0.06, 2, 0.5);
  const before = await boxMean(page, shell, shell.t - 0.5, 3, 0.06, 2, 0.5);
  console.log(`a barrage's shell ${Math.hypot(shell.position[0] - shell.eye[0], shell.position[2] - shell.eye[2]).toFixed(0)} m off at dusk: the skyline toward it ${before.toFixed(4)} → ${lit.toFixed(4)}`);
  expect(lit / before).toBeGreaterThan(1.08);
  expect(errors).toEqual([]);
});

test("at dusk from the step, a far shell's smoke column shows over the parapet", async ({ page }) => {
  test.setTimeout(300_000);
  const errors = await openGame(page);
  // Within 400 m: the approved dusk haze is too thick for anything 700 m off to show from the trench,
  // the far field's own hills hardly; a column there stands from 12° over the view's middle to 3° under.
  const shell = await firstLanded(page, true, 400);
  const smoke = await boxMean(page, shell, shell.t + 20, 6, 0.05, 18, -3);
  const before = await boxMean(page, shell, shell.t - 0.5, 6, 0.05, 18, -3);
  console.log(`a far shell ${Math.hypot(shell.position[0] - shell.eye[0], shell.position[2] - shell.eye[2]).toFixed(0)} m off at dusk: the sky over it ${before.toFixed(4)} → ${smoke.toFixed(4)} with its smoke`);
  expect(smoke / before).toBeLessThan(0.97);
  expect(errors).toEqual([]);
});
