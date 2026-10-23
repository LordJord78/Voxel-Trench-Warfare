import { expect, test, type Page } from '@playwright/test';
import { hooks, openGame } from './support/app';

// Shells at runtime (the spec's §3 and done-table row 3): a crater is cut in a worker on a copy of
// its region, as detonate cuts it in place, and is in the world within half a second; the frames
// while shells land stay under 20 ms of main-thread work; and without a worker, shells still land.

/** The parapet's crest ahead of the step view: the highest ground within 3 m along its view, metres. */
async function crestAhead(page: Page): Promise<[number, number, number]> {
  return hooks(page, (h) => {
    const v = h.views.step;
    const yaw = (v.yaw * Math.PI) / 180;
    let best: [number, number, number] = [v.position[0], -1, v.position[2]];
    for (let d = 0; d <= 3; d += 0.1) {
      const x = v.position[0] + Math.sin(yaw) * d;
      const z = v.position[2] + Math.cos(yaw) * d;
      const [vx, vz] = [Math.floor(x / 0.1), Math.floor(z / 0.1)];
      let y = 319;
      while (y >= 0 && h.world.map.get(vx, y, vz) === 0) y--;
      if ((y + 1) * 0.1 > best[1]) best = [x, (y + 1) * 0.1, z];
    }
    return best;
  });
}

test('a 3 m shell on the parapet is in the world within 0.5 s, as in-process detonate cuts it', async ({ page }) => {
  const errors = await openGame(page);
  await hooks(page, (h) => h.play());
  const crest = await crestAhead(page);
  const landed = await hooks(page, (h, at) => h.shellCheck(at as [number, number, number], 3), crest);
  console.log(`A 3 m shell on the parapet: in the world in ${landed.ms.toFixed(0)} ms, ${landed.bricks} bricks changed`);
  expect(landed.equal).toBe(true);
  expect(landed.bricks).toBeGreaterThan(50);
  expect(landed.ms, JSON.stringify(landed)).toBeLessThan(500);
  // The crest it landed on is gone.
  const top = await hooks(page, (h, at) => {
    const [x, y, z] = at as number[];
    return h.world.map.get(Math.floor(x / 0.1), Math.round(y / 0.1) - 1, Math.floor(z / 0.1));
  }, crest);
  expect(top).toBe(0);
  expect(errors).toEqual([]);
});

test("no frame's main-thread work exceeds 20 ms while shells land", async ({ page }) => {
  const errors = await openGame(page);
  await hooks(page, (h) => h.play());
  const seen = await hooks(page, async (h) => {
    await h.waitFrames(30);
    const from = h.frames();
    const p = h.player().position;
    const landings: { ms: number; bricks: number }[] = [];
    for (let k = 0; k < 5; k++) {
      const angle = 1.1 + k * 1.3;
      const d = 20 + k * 7;
      const shell = h.shell([p[0] + Math.cos(angle) * d, 0, p[2] + Math.sin(angle) * d], 2.2 + k * 0.3);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      landings.push(await shell);
    }
    await h.waitFrames(10);
    const frames = h.frames() - from;
    const ms = h.mainMs().slice(-frames);
    return { landings, frames, max: Math.max(...ms), ms: ms.slice().sort((a, b) => b - a).slice(0, 5) };
  });
  console.log(`Five shells 20–48 m off: main thread at most ${seen.max.toFixed(1)} ms a frame over ${seen.frames} frames (worst ${seen.ms.map((v) => v.toFixed(1)).join(', ')}); landed in ${seen.landings.map((l) => `${l.ms.toFixed(0)} ms (${l.bricks} bricks)`).join(', ')}`);
  expect(seen.landings.length).toBe(5);
  for (const l of seen.landings) expect(l.bricks).toBeGreaterThan(0);
  expect(seen.frames).toBeGreaterThan(100);
  expect(seen.max, JSON.stringify(seen)).toBeLessThanOrEqual(20);
  expect(errors).toEqual([]);
});

test('a worker that will not start leaves shells landing in-process', async ({ page }) => {
  await page.addInitScript(() => {
    const Real = window.Worker;
    const Refusing = function (url: string | URL, options?: WorkerOptions) {
      if (String(url).includes('destruction-worker')) throw new Error('no worker for this');
      return new Real(url, options);
    };
    Object.defineProperty(window, 'Worker', { value: Refusing, configurable: true, writable: true });
  });
  const errors = await openGame(page);
  await hooks(page, (h) => h.play());
  const landed = await hooks(page, async (h) => {
    const p = h.player().position;
    return h.shell([p[0] + 25, 0, p[2] + 10], 2.5);
  });
  expect(landed.bricks).toBeGreaterThan(0);
  expect(await hooks(page, (h) => h.craters())).toBe(1);
  expect(errors).toEqual([]);
});

/** The bay at night, its lanterns out, frozen: its camera, and the step view's. */
async function bayAtNight(page: Page) {
  return hooks(page, async (h) => {
    h.view('bay');
    h.setTimeOfDay(21);
    h.useLights([]);
    h.jitter(false);
    h.freeze();
    await h.stepFrames(40);
    const c = h.camera();
    return { position: c.position, yaw: c.yaw, res: h.stats().res };
  });
}

/** The floor at the image's lower middle: its mean shaded colour's luminance, with these blasts. */
function floorWith(page: Page, res: [number, number], blasts: { position: number[]; radiusM: number; colour: number[]; intensity: number }[]) {
  return hooks(
    page,
    async (h, arg) => {
      const { blasts, box } = arg as { blasts: never[]; box: [number, number, number, number] };
      h.debugBlasts(blasts);
      await h.stepFrames(2);
      const c = await h.colourAt(box);
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    },
    { blasts, box: [Math.floor(res[0] / 2) - 20, Math.floor(res[1] * 0.85), 40, 10] },
  );
}

test('a blast lights the faces that see it, and not those behind cover', async ({ page }) => {
  const errors = await openGame(page);
  const crest = await crestAhead(page);
  const step = await hooks(page, (h) => h.views.step);
  const at = await bayAtNight(page);
  const blast = (position: number[]) => [{ position, radiusM: 30, colour: [1.0, 0.62, 0.32], intensity: 300 }];
  const yaw = (at.yaw * Math.PI) / 180;
  // Three metres up the bay, a metre over its floor.
  const inBay = [at.position[0] + Math.sin(yaw) * 3, at.position[1] - 1.0, at.position[2] + Math.cos(yaw) * 3];
  // Three metres beyond the parapet's crest from the step, just over the field there.
  const sy = (step.yaw * Math.PI) / 180;
  const out = [crest[0] + Math.sin(sy) * 3, 0, crest[2] + Math.cos(sy) * 3];
  out[1] = (await hooks(page, (h, xz) => {
    const [x, z] = xz as number[];
    let y = 319;
    while (y >= 0 && h.world.map.get(Math.floor(x / 0.1), y, Math.floor(z / 0.1)) === 0) y--;
    return (y + 1) * 0.1;
  }, [out[0], out[2]])) + 0.3;
  const before = await floorWith(page, at.res, []);
  const near = await floorWith(page, at.res, blast(inBay));
  const covered = await floorWith(page, at.res, blast(out));
  const gone = await floorWith(page, at.res, []);
  const seen = JSON.stringify({ before, near, covered, gone, inBay, out });
  console.log(`A blast and the bay's floor: ${before.toExponential(3)} unlit, ${(near / before).toFixed(2)}× with it 3 m up the bay, ${(covered / before).toFixed(3)}× with it behind the parapet, ${(gone / before).toFixed(4)}× the frame after`);
  expect(near / before, seen).toBeGreaterThan(1.2);
  // Behind cover it lights only the haze between the eye and the floor.
  expect(covered - before, seen).toBeLessThan((near - before) / 10);
  // In no history: gone the frame after.
  expect(Math.abs(gone - before) / before, seen).toBeLessThan(0.01);
  expect(errors).toEqual([]);
});
