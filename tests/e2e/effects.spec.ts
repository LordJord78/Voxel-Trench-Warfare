import { expect, test, type Page } from '@playwright/test';
import { paletteData } from '../../src/world/materials';
import { hooks, openGame } from './support/app';

const DUSK = 17 + 35 / 60;

// The effects pass: drawn over the sharpened image, hidden where the world is nearer, at the
// frame's internal resolution; and in play, a magazine's tracers, flash, brass and dust.

/** The bay view at dusk, frozen; the camera, its forward, and the world's depth (m) at the image's middle. */
async function atTheBay(page: Page) {
  await hooks(page, async (h) => {
    h.view('bay');
    h.freeze();
    await h.stepFrames(40);
  });
  return hooks(page, async (h) => {
    const c = h.camera();
    const s = h.stats();
    const [depth] = await h.depthAt([[Math.floor(s.res[0] / 2), Math.floor(s.res[1] / 2)]]);
    const y = (c.yaw * Math.PI) / 180;
    const p = (c.pitch * Math.PI) / 180;
    return { position: c.position, forward: [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)], depth };
  });
}

/**
 * The image's mean with a two-metre quad `out` metres along the view, or none: bright, but not so
 * bright (×`particle_glow`) that bloom spreads it over the frame, which it does further at a lower
 * resolution.
 */
async function meanWith(page: Page, at: { position: number[]; forward: number[] }, out: number | null): Promise<number> {
  return hooks(
    page,
    async (h, arg) => {
      const { at, out } = arg as { at: { position: number[]; forward: number[] }; out: number | null };
      h.debugQuads(out === null ? [] : [{ position: at.position.map((v, k) => v + at.forward[k] * out) as [number, number, number], size: 2.0, colour: [0.05, 0.05, 0.05] }]);
      // Frozen, a frame is drawn only when stepped: ask for its picture first.
      const shot = h.snapshot();
      await h.stepFrames(1);
      return (await shot).mean;
    },
    { at, out },
  );
}

test('an effect in front of the wall shows, and one behind it does not', async ({ page }) => {
  const errors = await openGame(page);
  const at = await atTheBay(page);
  expect(at.depth).toBeGreaterThan(4);
  const before = await meanWith(page, at, null);
  const again = await meanWith(page, at, null);
  const front = await meanWith(page, at, at.depth / 2);
  const behind = await meanWith(page, at, at.depth + 2);
  const after = await meanWith(page, at, null);
  // Frame to frame, a frozen view's mean (0 to 1) moves this little.
  const noise = Math.max(Math.abs(again - before), Math.abs(after - again), 1e-4);
  const seen = JSON.stringify({ before, again, front, behind, after });
  expect(front - after, seen).toBeGreaterThan(Math.max(0.01, 20 * noise));
  expect(Math.abs(behind - after), seen).toBeLessThanOrEqual(3 * noise);
  expect(errors).toEqual([]);
});

test('effects follow dynamic resolution', async ({ page }) => {
  const errors = await openGame(page);
  const at = await atTheBay(page);
  const rise = async () => {
    const without = await meanWith(page, at, null);
    return (await meanWith(page, at, at.depth / 2)) - without;
  };
  const full = await rise();
  await hooks(page, (h) => h.setQuality({ dynres: false, scale: 0.5 }));
  await hooks(page, (h) => h.stepFrames(10));
  const half = await rise();
  expect(full).toBeGreaterThan(0.01);
  expect(half / full, JSON.stringify({ full, half })).toBeGreaterThan(0.6);
  expect(half / full, JSON.stringify({ full, half })).toBeLessThan(1.6);
  expect(errors).toEqual([]);
});

/** The step view at night, frozen: its camera and forward. */
async function atNight(page: Page) {
  await hooks(page, async (h) => {
    h.view('step');
    h.setTimeOfDay(23);
    h.freeze();
    await h.stepFrames(40);
  });
  return hooks(page, (h) => {
    const c = h.camera();
    const y = (c.yaw * Math.PI) / 180;
    const p = (c.pitch * Math.PI) / 180;
    return { position: c.position, forward: [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)] };
  });
}

/** The image's mean with a shot's light 1.2 m along the view, or none. */
async function meanLit(page: Page, at: { position: number[]; forward: number[] }, lit: boolean): Promise<number> {
  return hooks(
    page,
    async (h, arg) => {
      const { at, lit } = arg as { at: { position: number[]; forward: number[] }; lit: boolean };
      const position = at.position.map((v, k) => v + at.forward[k] * 1.2) as [number, number, number];
      h.debugLights(lit ? [{ position, radiusM: 6, colour: [1.0, 0.72, 0.4], intensity: 40 }] : []);
      const shot = h.snapshot();
      await h.stepFrames(1);
      return (await shot).mean;
    },
    { at, lit },
  );
}

test("a shot's light lights the trench, and leaves nothing behind once gone", async ({ page }) => {
  const errors = await openGame(page);
  const at = await atNight(page);
  const before = await meanLit(page, at, false);
  const lit = await meanLit(page, at, true);
  const still = await meanLit(page, at, true);
  const gone = await meanLit(page, at, false);
  const seen = JSON.stringify({ before, lit, still, gone });
  expect(lit / before, seen).toBeGreaterThan(1.02);
  // In no history: whole on its first frame (a denoised light would show a thirtieth of itself)
  // and gone on the first frame after (one would linger for half a second, here some 80% over).
  // Within the exposure's adaptation to the two lit frames, a percent and a half each.
  expect(Math.abs(lit - still) / still, seen).toBeLessThan(0.03);
  expect(Math.abs(gone - before) / before, seen).toBeLessThan(0.06);
  expect(errors).toEqual([]);
});

test('a mote in the open is lit by a shot\'s light and by the lights near it, as a face turned to them is', async ({ page }) => {
  // The review's case: dust and brass took only part of the key and the sky's light from above, and
  // read as soot beside the walls they came off. Here a mote 1.5 m down the bay at night, metres
  // from any face, the scene's own lights put out.
  const errors = await openGame(page);
  const at = await hooks(page, async (h) => {
    h.view('bay');
    h.setTimeOfDay(21);
    h.freeze();
    await h.stepFrames(40);
    const c = h.camera();
    const s = h.stats();
    const [depth] = await h.depthAt([[Math.floor(s.res[0] / 2), Math.floor(s.res[1] / 2)]]);
    const y = (c.yaw * Math.PI) / 180;
    const p = (c.pitch * Math.PI) / 180;
    return { position: c.position, forward: [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)], depth };
  });
  expect(at.depth).toBeGreaterThan(4.5);
  const mote = at.position.map((v, k) => v + at.forward[k] * 1.5) as [number, number, number];
  const albedo: [number, number, number] = [0.5, 0.4, 0.3];
  type Lantern = { position: number[]; radius: number; colour: number[]; intensity: number; kind: 'lantern'; phase: number };
  type Flash = { position: number[]; radiusM: number; colour: number[]; intensity: number };
  const litWith = (lanterns: Lantern[], flashes: Flash[]) =>
    hooks(
      page,
      async (h, arg) => {
        const { mote, albedo, lanterns, flashes } = arg as { mote: [number, number, number]; albedo: [number, number, number]; lanterns: Lantern[]; flashes: Flash[] };
        h.useLights(lanterns as never);
        h.debugLights(flashes as never);
        h.debugQuads([{ position: mote, size: 0.1, colour: albedo, lit: true }]);
        await h.stepFrames(2);
        return (await h.debugLit())[0];
      },
      { mote, albedo, lanterns, flashes },
    );
  const dark = await litWith([], []);
  const flash = await litWith([], [{ position: [mote[0], mote[1] + 0.5, mote[2]], radiusM: 6, colour: [1, 0.72, 0.4], intensity: 3 }]);
  const lanternAt = mote.map((v, k) => v + at.forward[k]);
  const lantern = await litWith([{ position: lanternAt, radius: 8, colour: [1, 0.8, 0.6], intensity: 2, kind: 'lantern', phase: 0 }], []);
  // light.wgsl's `unshadowed` for a face turned to the light: intensity · window² / (m² + 1); seen
  // through a metre and a half of haze, a few percent at most.
  const take = (m: number, radius: number, intensity: number) => (intensity * Math.max(0, 1 - (m / radius) ** 4) ** 2) / (m * m + 1);
  const seen = JSON.stringify({ dark, flash, lantern });
  for (let k = 0; k < 3; k++) {
    const byFlash = albedo[k] * [1, 0.72, 0.4][k] * take(0.5, 6, 3);
    const byLantern = albedo[k] * [1, 0.8, 0.6][k] * take(1, 8, 2);
    expect(Math.abs(flash[k] - dark[k] - byFlash) / byFlash, seen).toBeLessThan(0.05);
    expect(Math.abs(lantern[k] - dark[k] - byLantern) / byLantern, seen).toBeLessThan(0.05);
  }
  expect(dark[3]).toBe(1);
  expect(errors).toEqual([]);
});

test('a mote of a wall\'s own colour just before it looks as the wall does, at dusk and at night', async ({ page }) => {
  // The review's case: at dusk, dust off the bay's traverse read as soot beside it (a quarter of its
  // light), the wall's light there being mostly what the trench throws back.
  const errors = await openGame(page);
  const palette = paletteData();
  const seen: Record<string, unknown> = {};
  for (const hours of [DUSK, 21]) {
    const got = await hooks(
      page,
      async (h, hours) => {
        h.view('bay');
        h.setTimeOfDay(hours as number);
        h.jitter(false);
        h.freeze();
        h.debugQuads([]);
        await h.stepFrames(40);
        const c = h.camera();
        const s = h.stats();
        const [cx, cy] = [Math.floor(s.res[0] / 2), Math.floor(s.res[1] / 2)];
        const [depth] = await h.depthAt([[cx, cy]]);
        const y = (c.yaw * Math.PI) / 180;
        const p = (c.pitch * Math.PI) / 180;
        const forward = [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)];
        const into = c.position.map((v, k) => Math.floor((v + forward[k] * (depth + 0.05)) / 0.1));
        const id = h.world.map.get(into[0], into[1], into[2]);
        const wall = await h.colourAt([cx - 4, cy - 4, 9, 9]);
        return { position: c.position, forward, depth, id, wall };
      },
      hours,
    );
    expect(got.depth).toBeGreaterThan(4);
    const albedo = [0, 1, 2].map((k) => palette[got.id * 8 + k]) as [number, number, number];
    const mote = got.position.map((v, k) => v + got.forward[k] * (got.depth - 0.25)) as [number, number, number];
    const lit = await hooks(
      page,
      async (h, arg) => {
        const { mote, albedo } = arg as { mote: [number, number, number]; albedo: [number, number, number] };
        h.debugQuads([{ position: mote, size: 0.1, colour: albedo, lit: true }]);
        await h.stepFrames(2);
        return (await h.debugLit())[0];
      },
      { mote, albedo },
    );
    const lum = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const ratio = lum(lit) / lum(got.wall);
    seen[String(hours)] = { id: got.id, albedo, lit, wall: got.wall, ratio };
    expect(ratio, JSON.stringify(seen)).toBeGreaterThan(0.75);
    expect(ratio, JSON.stringify(seen)).toBeLessThan(1.33);
  }
  expect(errors).toEqual([]);
});

test("a shot's light lights the trench at the low preset's light scale too", async ({ page }) => {
  const errors = await openGame(page);
  await hooks(page, (h) => h.setQuality({ preset: 'low' }));
  const at = await atNight(page);
  const before = await meanLit(page, at, false);
  const lit = await meanLit(page, at, true);
  expect(lit / before, JSON.stringify({ before, lit })).toBeGreaterThan(1.02);
  expect(errors).toEqual([]);
});

test("a shot's flash and light last two frames", async ({ page }) => {
  const errors = await openGame(page);
  await hooks(page, (h) => h.play());
  await hooks(page, (h) => {
    const v = h.views.step;
    h.teleport({ position: [v.position[0], v.position[1] - 1.62, v.position[2]], yaw: v.yaw, pitch: -2 });
  });
  const seen = await hooks(page, async (h) => {
    await h.waitFrames(20);
    h.freeze();
    h.trigger(true);
    const out: [number, number][] = [];
    for (let k = 0; k < 4; k++) {
      await h.stepFrames(1);
      if (k === 0) h.trigger(false);
      const e = h.effects();
      out.push([e.stars, e.lights]);
    }
    return out;
  });
  expect(seen).toEqual([[3, 1], [3, 1], [0, 0], [0, 0]]);
  expect(errors).toEqual([]);
});

test('a magazine on full auto draws tracers, the flash, brass and dust', async ({ page }) => {
  const errors = await openGame(page);
  await hooks(page, (h) => h.play());
  await hooks(page, (h) => {
    const v = h.views.step;
    h.teleport({ position: [v.position[0], v.position[1] - 1.62, v.position[2]], yaw: v.yaw, pitch: -2 });
  });
  await hooks(page, (h) => h.waitFrames(20));
  await hooks(page, (h) => h.trigger(true));
  const most = await hooks(page, async (h) => {
    let billboards = 0;
    let tracers = 0;
    let stars = 0;
    for (let k = 0; k < 90; k++) {
      await h.waitFrames(1);
      const e = h.effects();
      billboards = Math.max(billboards, e.billboards);
      tracers = Math.max(tracers, e.tracers);
      stars = Math.max(stars, e.stars);
    }
    h.trigger(false);
    return { billboards, tracers, stars, errors: h.gpuErrors() };
  });
  expect(most.billboards).toBeGreaterThan(0);
  expect(most.tracers).toBeGreaterThan(0);
  expect(most.stars).toBeGreaterThan(0);
  expect(most.errors).toEqual([]);
  expect(errors).toEqual([]);
});

test('a far tracer stays an unbroken line, at least two pixels across, its light kept', async ({ page }) => {
  // The review's case: 0.06 m at 150 m is under half a pixel, drawn after TAA, so the enemy's
  // tracers across the view broke into dashes that shimmered.
  const errors = await openGame(page);
  const at = await hooks(page, async (h) => {
    h.view('step');
    h.setTimeOfDay(21);
    h.jitter(false);
    h.freeze();
    await h.stepFrames(40);
    const c = h.camera();
    return { position: c.position, yaw: c.yaw, pitch: c.pitch, fov: c.fov ?? 90 };
  });
  // 150 m out, 20° over the view (clear of the dead trees), 20 m across it and rising half a metre
  // along it, against the sky.
  const RAD = Math.PI / 180;
  const y = at.yaw * RAD;
  const p = (at.pitch + 20) * RAD;
  const centre = [0, 1, 2].map((k) => at.position[k] + [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)][k] * 150);
  const right = [Math.cos(y), 0, -Math.sin(y)];
  const tail = [0, 1, 2].map((k) => centre[k] - right[k] * 10 - (k === 1 ? 0.25 : 0)) as [number, number, number];
  const head = [0, 1, 2].map((k) => centre[k] + right[k] * 10 + (k === 1 ? 0.25 : 0)) as [number, number, number];
  const width = 0.06;
  const glow = 20;
  const columns = await hooks(
    page,
    async (h, arg) => {
      const { tail, head, width, glow } = arg as { tail: [number, number, number]; head: [number, number, number]; width: number; glow: number };
      const read = async (on: boolean) => {
        h.debugRibbons(on ? [{ tail, head, width, colour: [glow, glow, glow] }] : []);
        await h.stepFrames(2);
        const s = h.stats();
        const box: [number, number, number, number] = [0, 0, s.res[0], Math.floor(s.res[1] / 2)];
        return { res: s.res, box, rgb: await h.sharpAt(box) };
      };
      const without = await read(false);
      const withIt = await read(true);
      const [w, hgt] = [without.box[2], without.box[3]];
      const lum = (a: number[], i: number) => 0.2126 * a[i * 3] + 0.7152 * a[i * 3 + 1] + 0.0722 * a[i * 3 + 2];
      // Each column's light from the ribbon, summed down it, and its brightest pixel's.
      const sums: number[] = [];
      const peaks: number[] = [];
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let peak = 0;
        for (let yy = 0; yy < hgt; yy++) {
          const d = lum(withIt.rgb, yy * w + x) - lum(without.rgb, yy * w + x);
          sum += d;
          peak = Math.max(peak, d);
        }
        sums.push(sum);
        peaks.push(peak);
      }
      return { res: withIt.res, sums, peaks };
    },
    { tail, head, width, glow },
  );
  // The columns it crosses, by where any light fell; the middle 80% of them.
  const touched = columns.peaks.map((v, x) => (v > 0.01 * glow ? x : -1)).filter((x) => x >= 0);
  expect(touched.length).toBeGreaterThan(5);
  const [first, last] = [touched[0], touched[touched.length - 1]];
  const span = last - first;
  const middle = Array.from({ length: Math.floor(span * 0.8) }, (_, i) => first + Math.floor(span * 0.1) + i);
  const lit = middle.filter((x) => columns.peaks[x] > 0.01 * glow).length / middle.length;
  const sums = middle.map((x) => columns.sums[x]);
  const mean = sums.reduce((a, b) => a + b, 0) / sums.length;
  const spread = Math.sqrt(sums.reduce((a, b) => a + (b - mean) ** 2, 0) / sums.length) / mean;
  // Its light down a column: the profile's integral (half its drawn width, effects.wgsl) times its
  // true width in pixels, at whatever width it is drawn.
  const pixelM = (2 * 150 * Math.tan((at.fov * RAD) / 2)) / columns.res[0];
  const expected = 0.504 * (width / pixelM) * glow;
  const seen = JSON.stringify({ lit, spread, mean, expected, span, res: columns.res });
  expect(lit, seen).toBeGreaterThan(0.97);
  expect(spread, seen).toBeLessThan(0.5);
  expect(mean / expected, seen).toBeGreaterThan(0.7);
  expect(mean / expected, seen).toBeLessThan(1.4);
  expect(errors).toEqual([]);
});

test('a tracer is a white-hot core in a coloured glow, its glow held near the eye', async ({ page }) => {
  // The shots spec's look (§1): a team's tracer is a core mixed toward white in a glow of its
  // colour; and a round passing the eye is drawn no wider than tracer_glow_max_px (28), not the
  // bar across the screen its 0.22 m of glow would be there (some 280 px half a metre out).
  const errors = await openGame(page);
  const at = await hooks(
    page,
    async (h, hours) => {
      h.view('step');
      h.setTimeOfDay(hours as number);
      h.jitter(false);
      h.setQuality({ dynres: false, scale: 1 });
      h.freeze();
      await h.stepFrames(40);
      const c = h.camera();
      return { position: c.position, yaw: c.yaw, pitch: c.pitch, fov: c.fov ?? 90, res: h.stats().res };
    },
    DUSK,
  );
  const RAD = Math.PI / 180;
  const y = at.yaw * RAD;
  const along = (up: number, m: number) => [Math.sin(y) * Math.cos(up * RAD), Math.sin(up * RAD), Math.cos(y) * Math.cos(up * RAD)].map((v, k) => at.position[k] + v * m);
  const right = [Math.cos(y), 0, -Math.sin(y)];
  const across = (centre: number[], half: number) => ({ tail: centre.map((v, k) => v - right[k] * half), head: centre.map((v, k) => v + right[k] * half) });
  /** The tracer's light (with it, less without) down a box of the internal image `w` columns wide at column `x`: linear rgb, a row at a time. */
  const lightOf = (tracer: { tail: number[]; head: number[] }, x: number, w: number) =>
    hooks(
      page,
      async (h, arg) => {
        const { tracer, box } = arg as { tracer: { tail: [number, number, number]; head: [number, number, number] }; box: [number, number, number, number] };
        const read = async (on: boolean) => {
          h.debugTracer(on ? { ...tracer, kind: 2 } : null);
          await h.stepFrames(2);
          return h.sharpAt(box);
        };
        const without = await read(false);
        const withIt = await read(true);
        h.debugTracer(null);
        return withIt.map((v, i) => v - without[i]);
      },
      { tracer, box: [x, 0, w, at.res[1]] },
    );
  const lum = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const saturation = (c: readonly number[]) => (Math.max(...c) - Math.min(...c)) / Math.max(...c);
  const cx = Math.floor(at.res[0] / 2);

  // Red, 20 m out across the view, 20° over it (against the sky), 10 m long. A pixel there is 2.9 cm:
  // the glow drawn 7.5 px across, the core (3.5 cm) at its least, 2 px. The line's middle falls
  // within half a pixel of its brightest row, so a block of rows 2 to 4 off that is in the glow,
  // clear of the core.
  const far = await lightOf(across(along(at.pitch + 20, 20), 5), cx - 1, 3);
  const pixelM = (2 * 20 * Math.cos(20 * RAD) * Math.tan((at.fov * RAD) / 2)) / at.res[0];
  const rgbAt = (row: number, col: number) => far.slice((row * 3 + col) * 3, (row * 3 + col) * 3 + 3);
  const rows = far.length / 9;
  const line = Array.from({ length: rows }, (_, r) => lum(rgbAt(r, 1))).reduce((best, v, r, all) => (v > all[best] ? r : best), 0);
  const block = (row: number) => {
    const sum = [0, 0, 0];
    for (let r = row - 1; r <= row + 1; r++) for (let c = 0; c < 3; c++) rgbAt(r, c).forEach((v, k) => (sum[k] += v / 9));
    return sum;
  };
  const centre = block(line);
  const edge = block(line - 3);
  const farSeen = JSON.stringify({ line, centre, edge, glowPx: 0.22 / pixelM, res: at.res });
  expect(0.22 / pixelM, farSeen).toBeGreaterThan(6);
  expect(lum(centre), farSeen).toBeGreaterThan(1);
  // Whiter at its core (one term of the glow's colour all across would be as saturated: 0.9); red
  // in its glow.
  expect(saturation(centre), farSeen).toBeLessThan(saturation(edge) - 0.1);
  expect(edge[0], farSeen).toBeGreaterThan(edge[1]);
  expect(edge[0], farSeen).toBeGreaterThan(edge[2]);

  // Half a metre out along the view, 4 m long, wider than the view: a column through it is lit
  // (over a hundredth of its brightest) across no more than the glow's 28 px.
  const near = await lightOf(across(along(at.pitch, 0.5), 2), cx, 1);
  const column = Array.from({ length: near.length / 3 }, (_, r) => lum(near.slice(r * 3, r * 3 + 3)));
  const peak = Math.max(...column);
  const lit = column.map((v, r) => (v > 0.01 * peak ? r : -1)).filter((r) => r >= 0);
  const width = lit.length > 0 ? lit[lit.length - 1] - lit[0] + 1 : 0;
  const nearSeen = JSON.stringify({ peak, width, first: lit[0], res: at.res });
  expect(peak, nearSeen).toBeGreaterThan(1);
  expect(width, nearSeen).toBeGreaterThan(20);
  expect(width, nearSeen).toBeLessThanOrEqual(30);
  expect(errors).toEqual([]);
});

test("a far tracer's white-hot core stays an unbroken line, as its glow does", async ({ page }) => {
  // A tracer's core (3.5 cm) is under a tenth of a pixel 150 m out: drawn no narrower than two
  // pixels, its light kept, as the glow is; drawn at its share of the glow's two, it broke into
  // dashes (a third of the columns all but dark, and neighbours a third apart).
  const errors = await openGame(page);
  const at = await hooks(page, async (h) => {
    h.view('step');
    h.setTimeOfDay(21);
    h.jitter(false);
    h.freeze();
    await h.stepFrames(40);
    const c = h.camera();
    return { position: c.position, yaw: c.yaw, pitch: c.pitch };
  });
  // As the far ribbon above: 150 m out, 20° over the view, 20 m across it and rising half a metre.
  const RAD = Math.PI / 180;
  const y = at.yaw * RAD;
  const p = (at.pitch + 20) * RAD;
  const centre = [0, 1, 2].map((k) => at.position[k] + [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)][k] * 150);
  const right = [Math.cos(y), 0, -Math.sin(y)];
  const tail = [0, 1, 2].map((k) => centre[k] - right[k] * 10 - (k === 1 ? 0.25 : 0));
  const head = [0, 1, 2].map((k) => centre[k] + right[k] * 10 + (k === 1 ? 0.25 : 0));
  const sums = await hooks(
    page,
    async (h, arg) => {
      const { tail, head } = arg as { tail: [number, number, number]; head: [number, number, number] };
      const read = async (on: boolean) => {
        h.debugTracer(on ? { tail, head, kind: 2 } : null);
        await h.stepFrames(2);
        const s = h.stats();
        const box: [number, number, number, number] = [0, 0, s.res[0], Math.floor(s.res[1] / 2)];
        return { box, rgb: await h.sharpAt(box) };
      };
      const without = await read(false);
      const withIt = await read(true);
      h.debugTracer(null);
      const [w, hgt] = [without.box[2], without.box[3]];
      const lum = (a: number[], i: number) => 0.2126 * a[i * 3] + 0.7152 * a[i * 3 + 1] + 0.0722 * a[i * 3 + 2];
      // Each column's light from the tracer, summed down it.
      return Array.from({ length: w }, (_, x) => {
        let sum = 0;
        for (let yy = 0; yy < hgt; yy++) sum += lum(withIt.rgb, yy * w + x) - lum(without.rgb, yy * w + x);
        return sum;
      });
    },
    { tail, head },
  );
  // The middle 80% of the columns it crosses.
  const touched = sums.map((v, x) => (v > 0.05 ? x : -1)).filter((x) => x >= 0);
  expect(touched.length).toBeGreaterThan(5);
  const [first, last] = [touched[0], touched[touched.length - 1]];
  const span = last - first;
  const middle = Array.from({ length: Math.floor(span * 0.8) }, (_, i) => first + Math.floor(span * 0.1) + i);
  const most = Math.max(...middle.map((x) => sums[x]));
  const lit = middle.filter((x) => sums[x] > 0.1 * most).length / middle.length;
  // Column to column it changes by its fade toward the tail, a few percent.
  const jumps = middle.slice(1).map((x) => Math.abs(sums[x] - sums[x - 1]) / Math.max(sums[x], sums[x - 1]));
  const p95 = [...jumps].sort((a, b) => a - b)[Math.floor(jumps.length * 0.95)];
  const seen = JSON.stringify({ span, lit, p95 });
  expect(lit, seen).toBeGreaterThan(0.97);
  expect(p95, seen).toBeLessThan(0.15);
  expect(errors).toEqual([]);
});

test('a tracer seen end on is its head alone: lit every frame 150 m out, held small half a metre out', async ({ page }) => {
  // The review's case: aimed down the sights, past tracer_converge_m the player's round is drawn on
  // a ray from the eye, so its streak is seen end on and its head is all the shooter sees of it. A
  // streak whose ends fall within a pixel of each other draws nothing (not a sliver of noise); its
  // head is drawn no smaller than three pixels, its light kept, so it lights the same light's worth
  // of pixels every frame however it falls among them (at its true 0.4 px, 150 m out, it lit one
  // frame in a few), and near the eye no wider than its share of a glow held to 28 px (0.09 of 0.22:
  // 11.5 px), where at its true size it would be 115 px.
  const errors = await openGame(page);
  const at = await hooks(page, async (h) => {
    h.view('step');
    h.setTimeOfDay(21);
    h.jitter(false);
    h.setQuality({ dynres: false, scale: 1 });
    h.freeze();
    await h.stepFrames(40);
    const c = h.camera();
    return { position: c.position, yaw: c.yaw, pitch: c.pitch, fov: c.fov ?? 90, res: h.stats().res };
  });
  const RAD = Math.PI / 180;
  const y = at.yaw * RAD;
  const right = [Math.cos(y), 0, -Math.sin(y)];
  const tanHalf = Math.tan((at.fov * RAD) / 2);
  /** The point `m` metres out along the ray `up` degrees over the view's middle and `side` pixels right of it, and the pixel it falls on. */
  const out = (up: number, side: number, m: number) => {
    const p = (at.pitch + up) * RAD;
    const s = (side * Math.cos(up * RAD) * 2 * tanHalf) / at.res[0];
    const d = [Math.sin(y) * Math.cos(p) + right[0] * s, Math.sin(p), Math.cos(y) * Math.cos(p) + right[2] * s];
    const n = Math.hypot(d[0], d[1], d[2]);
    return { at: d.map((v, k) => at.position[k] + (v / n) * m) as [number, number, number], px: [at.res[0] / 2 + side, at.res[1] / 2 - (Math.tan(up * RAD) / tanHalf) * (at.res[0] / 2)] };
  };
  /** The light each tracer adds over `box` of the internal image (each, less the image without it): luminance, a row at a time. */
  const lightOver = (tracers: { tail: [number, number, number]; head: [number, number, number] }[], box: [number, number, number, number]) =>
    hooks(
      page,
      async (h, arg) => {
        const { tracers, box } = arg as { tracers: { tail: [number, number, number]; head: [number, number, number] }[]; box: [number, number, number, number] };
        const lum = (a: number[], i: number) => 0.2126 * a[i * 3] + 0.7152 * a[i * 3 + 1] + 0.0722 * a[i * 3 + 2];
        h.debugTracer(null);
        await h.stepFrames(2);
        const without = await h.sharpAt(box);
        const seen: number[][] = [];
        for (const t of tracers) {
          h.debugTracer({ ...t, kind: 2 });
          await h.stepFrames(2);
          const withIt = await h.sharpAt(box);
          seen.push(Array.from({ length: box[2] * box[3] }, (_, i) => lum(withIt, i) - lum(without, i)));
        }
        h.debugTracer(null);
        return seen;
      },
      { tracers, box },
    );

  // 150 m out, 20° over the view against the night sky, moving a third of a pixel right and a
  // quarter up each frame; its tail 12 m back, 0.6 px aside (the eye a few centimetres off the
  // shot's line, as when walking).
  const steps = Array.from({ length: 8 }, (_, k) => ({ up: 20 + 0.023 * k, side: 0.37 * k }));
  const far = steps.map((s) => ({ head: out(s.up, s.side, 150), tail: out(s.up, s.side + 0.6, 138) }));
  const x0 = Math.round(far[0].head.px[0]) - 8;
  const y0 = Math.round(far[far.length - 1].head.px[1]) - 8;
  const frames = await lightOver(far.map((f) => ({ tail: f.tail.at, head: f.head.at })), [x0, y0, 20, 20]);
  const totals = frames.map((f) => f.reduce((a, b) => a + b, 0));
  const peaks = frames.map((f) => Math.max(...f));
  const farSeen = JSON.stringify({ totals, peaks });
  for (const p of peaks) expect(p, farSeen).toBeGreaterThan(0.05 * Math.max(...peaks));
  expect(Math.min(...totals) / Math.max(...totals), farSeen).toBeGreaterThan(0.9);
  expect(Math.min(...totals), farSeen).toBeGreaterThan(0);

  // Half a metre out on the view's middle, coming at the eye, its tail 12 m back and 0.4 px aside: a
  // row and a column through it lit (over a hundredth of its brightest) across 12 px at most.
  const near = { head: out(0, 0, 0.5), tail: out(0, 0.4, 12.5) };
  const [cx, cy] = near.head.px.map(Math.round);
  const [row] = await lightOver([{ tail: near.tail.at, head: near.head.at }], [0, cy, at.res[0], 1]);
  const [column] = await lightOver([{ tail: near.tail.at, head: near.head.at }], [cx, 0, 1, at.res[1]]);
  const across = (line: number[]) => {
    const peak = Math.max(...line);
    const lit = line.map((v, i) => (v > 0.01 * peak ? i : -1)).filter((i) => i >= 0);
    return { peak, width: lit.length > 0 ? lit[lit.length - 1] - lit[0] + 1 : 0 };
  };
  const nearSeen = JSON.stringify({ row: across(row), column: across(column) });
  for (const line of [row, column]) {
    expect(across(line).peak, nearSeen).toBeGreaterThan(1);
    expect(across(line).width, nearSeen).toBeLessThanOrEqual(12);
  }
  expect(errors).toEqual([]);
});

test('a lit square shows as a square, where a lit disc leaves its corners', async ({ page }) => {
  // Debris is drawn as lit squares (milestone 4's plan, ruling 7).
  const errors = await openGame(page);
  const at = await hooks(page, async (h) => {
    h.view('bay');
    h.setTimeOfDay(21);
    h.jitter(false);
    h.freeze();
    await h.stepFrames(40);
    const c = h.camera();
    const y = (c.yaw * Math.PI) / 180;
    const p = (c.pitch * Math.PI) / 180;
    return { position: c.position, forward: [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)], res: h.stats().res };
  });
  const centre = at.position.map((v, k) => v + at.forward[k] * 3) as [number, number, number];
  // The same light for all three reads, 0.6 m in front of the quad: it lights the quad and the wall.
  const lamp = centre.map((v, k) => v - at.forward[k] * 0.6) as [number, number, number];
  // A metre across, 3 m out: its corner's pixels at 0.85 of its half-width right and up (a disc's
  // edge has fallen to nothing by then, 1.2 of its radius out).
  const half = (0.5 / 3) * (at.res[0] / 2);
  const corner: [number, number, number, number] = [Math.round(at.res[0] / 2 + 0.85 * half) - 1, Math.round(at.res[1] / 2 - 0.85 * half) - 1, 3, 3];
  const read = (quads: unknown[]) =>
    hooks(
      page,
      async (h, arg) => {
        const { quads, corner, lamp } = arg as { quads: never[]; corner: [number, number, number, number]; lamp: [number, number, number] };
        h.debugQuads(quads);
        h.debugLights([{ position: lamp, radiusM: 6, colour: [1, 1, 1], intensity: 20 }]);
        await h.stepFrames(2);
        const rgb = await h.sharpAt(corner);
        let sum = 0;
        for (let i = 0; i < rgb.length; i += 3) sum += 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2];
        return sum / (rgb.length / 3);
      },
      { quads, corner, lamp },
    );
  const quad = (square: boolean) => [{ position: centre, size: 1, colour: [0.8, 0.8, 0.8], lit: true, square }];
  const none = await read([]);
  const disc = await read(quad(false));
  const square = await read(quad(true));
  const seen = JSON.stringify({ none, disc, square });
  expect(square / none, seen).toBeGreaterThan(1.5);
  expect(Math.abs(disc - none) / none, seen).toBeLessThan(0.02);
  expect(errors).toEqual([]);
});
