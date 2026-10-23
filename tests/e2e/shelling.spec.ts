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
