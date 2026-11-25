import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { projectToPixel } from '../../src/render/camera';
import { paletteData } from '../../src/world/materials';
import { hooks, openGame, type Hooks } from './support/app';

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
    const out: [number, number, number][] = [];
    for (let k = 0; k < 4; k++) {
      await h.stepFrames(1);
      if (k === 0) h.trigger(false);
      const e = h.effects();
      out.push([e.stars, e.cores, e.lights]);
    }
    return out;
  });
  // Its star (3 to 5 prongs, drawn from the shot's hash: the same in both its frames) and its core.
  const prongs = seen[0][0];
  expect(prongs).toBeGreaterThanOrEqual(3);
  expect(prongs).toBeLessThanOrEqual(5);
  expect(seen).toEqual([[prongs, 1, 1], [prongs, 1, 1], [0, 0, 0], [0, 0, 0]]);
  expect(errors).toEqual([]);
});

/** What the SVD's shot frame reads of the page: the loadout, the shots fired, the drawn tracers and the particles as drawn. */
type Kicked = Hooks & {
  setLoadout(l: unknown): void;
  session: Hooks['session'] & { weapon: { shotsFired: number } };
  tracerPixels(): { tracers: { tailM: [number, number, number]; flown: number }[] };
  particleBillboards(): { kind: number; at: [number, number, number]; half: number }[];
  lastShots(): { tick: number; muzzle: [number, number, number] }[];
};

test("the SVD's shot frame: its flash, smoke and tracer leave the drawn muzzle, kicked up with it", async ({ page }) => {
  // The SVD's kick takes its drawn muzzle some 17 cm from where the shot left in the shot's own frame:
  // the flash, smoke and tracer were drawn there, a white half-disc and a tracer under the gun. Each now
  // leaves the drawn muzzle (its own flight on from it: the flash 2 m/s, a tick's 3 cm). Frozen, the
  // frame is drawn half-way to its tick (freeze() settles the clock's leftover at half a tick): half
  // the kick is in it, so the drawn muzzle is well off where the shot left, and a flash left there
  // would show.
  const errors = await openGame(page);
  await hooks(page, (h) => h.play());
  await hooks(page, (h) => {
    const v = h.views.step;
    h.teleport({ position: [v.position[0], v.position[1] - 1.62, v.position[2]], yaw: v.yaw, pitch: -2 });
    (h as Kicked).setLoadout({ primary: 'svd', secondary: 'm17', fits: {} });
  });
  const seen = await hooks(page, async (hk) => {
    const h = hk as Kicked;
    await h.waitFrames(90);
    h.freeze();
    const before = h.session.weapon.shotsFired;
    h.trigger(true);
    for (let k = 0; k < 10 && h.session.weapon.shotsFired === before; k++) await h.stepFrames(1);
    h.trigger(false);
    const out = { shots: h.session.weapon.shotsFired - before, muzzle: h.rifleMuzzle(), left: h.lastShots().map((s) => s.muzzle), tracers: h.tracerPixels().tracers.map((t) => t.tailM), particles: h.particleBillboards() };
    h.thaw();
    return out;
  });
  const off = (p: readonly number[]) => Math.hypot(p[0] - seen.muzzle[0], p[1] - seen.muzzle[1], p[2] - seen.muzzle[2]);
  const flash = seen.particles.filter((p) => p.kind === 1).map((p) => off(p.at));
  const smoke = seen.particles.filter((p) => p.kind === 7).map((p) => off(p.at));
  const brass = seen.particles.filter((p) => p.kind === 6).map((p) => off(p.at));
  const tracer = seen.tracers.map(off);
  // The kick in the frame: the drawn muzzle 6 cm or more off the muzzle the shot's event left from.
  const kicked = seen.left.map(off);
  const trace = JSON.stringify({ kicked, flash, smoke, brass, tracer });
  console.log(`the SVD's shot frame, each from the drawn muzzle (m): ${trace}`);
  expect(seen.shots).toBe(1);
  expect(kicked, trace).toHaveLength(1);
  expect(kicked[0], trace).toBeGreaterThanOrEqual(0.06);
  expect([flash.length, smoke.length, brass.length, tracer.length], trace).toEqual([1, 1, 1, 1]);
  // Its streak reaches back to the muzzle in its first frame: drawn from the drawn muzzle.
  expect(tracer[0], trace).toBeLessThan(0.01);
  // The flash and the smoke a tick's flight on from it (the casing leaves the port, the unit tests' to
  // measure: it is logged here).
  expect(flash[0], trace).toBeLessThan(0.05);
  expect(smoke[0], trace).toBeLessThan(0.05);
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
  // colour; and a round passing the eye is drawn no wider than tracer_glow_max_px (10), not the
  // bar across the screen its 0.22 m of glow would be there (some 280 px half a metre out), nor
  // the fat wedge 28 px drew; its core no wider than 0.45 of the glow drawn, so the glow's colour
  // shows round it. Its light alone, read as the image with it less the image without: at 17:35 the
  // sun is up, and a tracer's light covers the haze behind it ([effects] tracer_cover, its own test
  // below), so the look's cover is held at none while it is read here, as a tunable would set it.
  const errors = await openGame(page);
  type Look = { renderer: { effects: { look: { tracerCover: number } } } };
  const at = await hooks(
    page,
    async (h, hours) => {
      h.view('step');
      h.setTimeOfDay(hours as number);
      h.jitter(false);
      h.setQuality({ dynres: false, scale: 1 });
      const look = (h as unknown as Look).renderer.effects.look;
      const cover = look.tracerCover;
      look.tracerCover = 0;
      h.freeze();
      await h.stepFrames(40);
      const c = h.camera();
      return { position: c.position, yaw: c.yaw, pitch: c.pitch, fov: c.fov ?? 90, res: h.stats().res, exposure: await h.exposure(), sharp: 1 - h.bloomWeight(), cover };
    },
    DUSK,
  );
  expect(at.cover).toBeGreaterThan(0);
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
  // How a light shows: through the present pass's curve (the ACES fit, channel by channel) at the
  // frame's exposure on the image's share beside its bloom (1 - render.bloom_weight). A tracer's light
  // is kept at its hue through it (effects.wgsl keepHue), so its ratios in the linear image are not
  // its colour's.
  const aces = (x: number) => Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
  const shown = (c: readonly number[]) => c.map((v) => aces(v * at.exposure * at.sharp) ** (1 / 2.2));
  const saturation = (c: readonly number[]) => {
    const d = shown(c);
    return (Math.max(...d) - Math.min(...d)) / Math.max(...d);
  };
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
  const farSeen = JSON.stringify({ line, centre, edge, shownCentre: shown(centre), shownEdge: shown(edge), glowPx: 0.22 / pixelM, res: at.res });
  expect(0.22 / pixelM, farSeen).toBeGreaterThan(6);
  expect(lum(centre), farSeen).toBeGreaterThan(1);
  // Whiter at its core, as shown (one term of the glow's colour all across would show as saturated);
  // red in its glow.
  expect(saturation(centre), farSeen).toBeLessThan(saturation(edge) - 0.1);
  expect(edge[0], farSeen).toBeGreaterThan(edge[1]);
  expect(edge[0], farSeen).toBeGreaterThan(edge[2]);

  // Half a metre out along the view, 4 m long, wider than the view: a column through it is lit
  // (over a hundredth of its brightest) across no more than the glow's 10 px, a pixel either side
  // for where its edges fall.
  const near = await lightOf(across(along(at.pitch, 0.5), 2), cx, 1);
  const rgbRow = (r: number) => near.slice(r * 3, r * 3 + 3);
  const column = Array.from({ length: near.length / 3 }, (_, r) => lum(rgbRow(r)));
  const peak = Math.max(...column);
  const lit = column.map((v, r) => (v > 0.01 * peak ? r : -1)).filter((r) => r >= 0);
  const width = lit.length > 0 ? lit[lit.length - 1] - lit[0] + 1 : 0;
  // Its core apart from its glow: the glow is the tracer's own colour all across, so the green over
  // the glow's own share of the red (as its outer rows, clear of the core, show it) is the core's
  // alone; the core is drawn to where that falls to e⁻³ of its middle (effects.wgsl's profile).
  const brightest = column.indexOf(peak);
  const outer = [rgbRow(lit[0] + 1), rgbRow(lit[lit.length - 1] - 1)];
  const glowGreen = outer.reduce((a, c) => a + c[1], 0) / Math.max(1e-9, outer.reduce((a, c) => a + c[0], 0));
  const whiter = Array.from({ length: near.length / 3 }, (_, r) => rgbRow(r)[1] - glowGreen * rgbRow(r)[0]);
  const coreRows = whiter.filter((v) => v > Math.exp(-3) * whiter[brightest]).length;
  const nearSeen = JSON.stringify({ peak, width, first: lit[0], coreRows, glowGreen, res: at.res });
  expect(peak, nearSeen).toBeGreaterThan(1);
  expect(width, nearSeen).toBeGreaterThanOrEqual(8);
  expect(width, nearSeen).toBeLessThanOrEqual(12);
  expect(whiter[brightest], nearSeen).toBeGreaterThan(0);
  expect(coreRows, nearSeen).toBeGreaterThanOrEqual(1);
  expect(coreRows, nearSeen).toBeLessThanOrEqual(0.45 * width);
  await hooks(
    page,
    (h, cover) => {
      (h as unknown as Look).renderer.effects.look.tracerCover = cover as number;
    },
    at.cover,
  );
  expect(errors).toEqual([]);
});

test("a far tracer's white-hot core stays an unbroken line, as its glow does", async ({ page }) => {
  // A tracer's core (3.5 cm) is under a tenth of a pixel 150 m out: drawn at 0.45 of the glow there,
  // 1.8 px at the glow's 4 px floor, its light kept, as the glow's is; drawn at its share of a glow
  // two pixels across, it broke into dashes (a third of the columns all but dark, and neighbours a
  // third apart). Read at the image's full size (dynamic resolution could change it between the two
  // reads), and only within 12 px of the line it is drawn on: the stars twinkle over the rest of the
  // night sky.
  const errors = await openGame(page);
  const at = await hooks(page, async (h) => {
    h.view('step');
    h.setTimeOfDay(21);
    h.jitter(false);
    h.setQuality({ dynres: false, scale: 1 });
    h.freeze();
    await h.stepFrames(40);
    return { pose: h.camera(), res: h.stats().res };
  });
  // As the far ribbon above: 150 m out, 20° over the view, 20 m across it and rising half a metre.
  const RAD = Math.PI / 180;
  const pose = at.pose;
  const y = pose.yaw * RAD;
  const p = (pose.pitch + 20) * RAD;
  const centre = [0, 1, 2].map((k) => pose.position[k] + [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)][k] * 150);
  const right = [Math.cos(y), 0, -Math.sin(y)];
  const tail = [0, 1, 2].map((k) => centre[k] - right[k] * 10 - (k === 1 ? 0.25 : 0)) as [number, number, number];
  const head = [0, 1, 2].map((k) => centre[k] + right[k] * 10 + (k === 1 ? 0.25 : 0)) as [number, number, number];
  // Where it is drawn in the internal image: the line between its ends' pixels, as the frame's camera
  // projects them (a straight line seen through it stays straight).
  const ends = [tail, head].map((q) => projectToPixel(pose, at.res, q));
  expect(ends.every((e) => e !== null)).toBe(true);
  const [a, b] = ends as [number, number][];
  const sums = await hooks(
    page,
    async (h, arg) => {
      const { tail, head, a, b, band, res } = arg as { tail: [number, number, number]; head: [number, number, number]; a: [number, number]; b: [number, number]; band: number; res: [number, number] };
      // The rows the band covers, over the whole width.
      const top = Math.max(0, Math.floor(Math.min(a[1], b[1]) - band - 1));
      const bottom = Math.min(res[1], Math.ceil(Math.max(a[1], b[1]) + band + 1));
      const box: [number, number, number, number] = [0, top, res[0], bottom - top];
      const read = async (on: boolean) => {
        h.debugTracer(on ? { tail, head, kind: 2 } : null);
        await h.stepFrames(2);
        const now = h.stats().res;
        if (now[0] !== res[0] || now[1] !== res[1]) throw new Error(`the image went from ${res} to ${now}`);
        return h.sharpAt(box);
      };
      const without = await read(false);
      const withIt = await read(true);
      h.debugTracer(null);
      const [w, hgt] = [box[2], box[3]];
      const lum = (c: number[], i: number) => 0.2126 * c[i * 3] + 0.7152 * c[i * 3 + 1] + 0.0722 * c[i * 3 + 2];
      // Each column's light from the tracer, summed down the band about where the line crosses it.
      return Array.from({ length: w }, (_, x) => {
        const line = a[1] + ((x + 0.5 - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
        let sum = 0;
        for (let yy = 0; yy < hgt; yy++) {
          if (Math.abs(top + yy + 0.5 - line) <= band) sum += lum(withIt, yy * w + x) - lum(without, yy * w + x);
        }
        return sum;
      });
    },
    { tail, head, a, b, band: 12, res: at.res },
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

test("a far red tracer at night shows red on the screen, not white, under fire as out of it", async ({ page }) => {
  // Far off a tracer's light is kept at its hue through the present pass's per-channel tone curve
  // (effects.wgsl keepHue), which alone takes a bright red to white; and its core has no whiteness
  // left past tracer_white_far_m (40 m). Under fire the present pass greys the picture, all but the
  // light shown near the curve's top ([suppression] desaturate_knee): greyed with the rest, at
  // suppression's full level a far red tracer showed white, and colour tells friend from foe in
  // exactly the firefights that suppress. Read on the displayed canvas, as a player sees it, out of
  // fire and at suppression's full level.
  const errors = await openGame(page);
  const at = await hooks(page, async (h) => {
    h.view('step');
    h.setTimeOfDay(23);
    h.jitter(false);
    h.setQuality({ dynres: false, scale: 1 });
    // The session's suppression shown over this fixed view as over the player's own.
    h.suppressionLook(true);
    h.freeze();
    await h.stepFrames(40);
    const c = h.camera();
    return { position: c.position, yaw: c.yaw, pitch: c.pitch, fov: c.fov ?? 90 };
  });
  // 80 m out, 20° over the view against the night sky, 12 m across it.
  const RAD = Math.PI / 180;
  const y = at.yaw * RAD;
  const p = (at.pitch + 20) * RAD;
  const centre = [0, 1, 2].map((k) => at.position[k] + [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)][k] * 80);
  const right = [Math.cos(y), 0, -Math.sin(y)];
  const tail = centre.map((v, k) => v - right[k] * 6) as [number, number, number];
  const head = centre.map((v, k) => v + right[k] * 6) as [number, number, number];
  /** The canvas with the tracer or without it, suppression at `level` (flying, the session does not run, so it holds). */
  const shot = async (on: boolean, level: number) => {
    await hooks(
      page,
      async (h, arg) => {
        const { tail, head, on, level } = arg as { tail: [number, number, number]; head: [number, number, number]; on: boolean; level: number };
        h.session.suppression.level = level;
        h.debugTracer(on ? { tail, head, kind: 2 } : null);
        await h.stepFrames(2);
      },
      { tail, head, on, level },
    );
    return PNG.sync.read(await page.screenshot());
  };
  const lum = (d: Buffer, i: number) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  const measured: string[] = [];
  for (const level of [0, 1]) {
    const without = await shot(false, level);
    const withIt = await shot(true, level);
    // Where it lies on the canvas: 20° over its middle, 6 m either side 80 m out (4.3°), and a band of
    // 16 px about it (its glow and bloom; the grain elsewhere is not its).
    const w = withIt.width;
    const tanHalf = Math.tan((at.fov * RAD) / 2);
    const rowAt = withIt.height / 2 - (Math.tan(20 * RAD) / tanHalf) * (w / 2);
    const halfLength = (6 / 80 / tanHalf) * (w / 2);
    // Its pixels: lit as the captures' rule has it, 1.5 times the sky without it and 6 steps over it.
    let n = 0;
    let saturation = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < withIt.data.length; i += 4) {
      const px = (i / 4) % w;
      const py = Math.floor(i / 4 / w);
      if (Math.abs(py - rowAt) > 16 || Math.abs(px - w / 2) > halfLength + 16) continue;
      const bg = lum(without.data, i);
      const v = lum(withIt.data, i);
      if (!(v >= Math.max(1.5 * bg, bg + 6))) continue;
      const [r, g, b] = [withIt.data[i], withIt.data[i + 1], withIt.data[i + 2]];
      const top = Math.max(r, g, b);
      const c = top - Math.min(r, g, b);
      let h = c > 0 ? (top === r ? ((g - b) / c) % 6 : top === g ? (b - r) / c + 2 : (r - g) / c + 4) * 60 : 0;
      h = (h + 360) % 360;
      n++;
      saturation += c / top;
      sx += c * Math.cos(h * RAD);
      sy += c * Math.sin(h * RAD);
    }
    const hue = ((Math.atan2(sy, sx) / RAD) + 360) % 360;
    const seen = JSON.stringify({ level, n, saturation: saturation / Math.max(1, n), hue, rowAt, halfLength });
    measured.push(seen);
    expect(n, seen).toBeGreaterThan(20);
    // Red [1.0, 0.04, 0.018] shown at its hue is (255, 59, 41): hue 5°, saturation 0.84; white has
    // none. Over the violet night sky its edges read a little toward magenta.
    expect(saturation / n, seen).toBeGreaterThan(0.5);
    expect(Math.min(Math.abs(hue - 5), 360 - Math.abs(hue - 5)), seen).toBeLessThan(20);
  }
  console.log(measured.join('\n'));
  await hooks(page, (h) => {
    h.debugTracer(null);
    h.session.suppression.level = 0;
    h.suppressionLook(false);
  });
  expect(errors).toEqual([]);
});

/** A screenshot as decoded: its size and its RGBA. */
type Shot = { width: number; height: number; data: Buffer };

/**
 * The pixels a tracer changed on the canvas (any channel by `least` or more) whose centres lie `band`
 * ([inner, outer] pixels) off the row `rowAt` (a line across the view), in columns `cols`: their
 * colour's mean saturation and hue (a circular mean, each weighted by its chroma).
 */
function changedColour(without: Shot, withIt: Shot, rowAt: number, band: [number, number], cols: [number, number], least: number) {
  const RAD = Math.PI / 180;
  let n = 0;
  let saturation = 0;
  let sx = 0;
  let sy = 0;
  const w = withIt.width;
  for (let y = Math.max(0, Math.floor(rowAt - band[1])); y <= Math.min(withIt.height - 1, Math.ceil(rowAt + band[1])); y++) {
    const off = Math.abs(y + 0.5 - rowAt);
    if (off < band[0] || off > band[1]) continue;
    for (let x = Math.max(0, Math.floor(cols[0])); x <= Math.min(w - 1, Math.ceil(cols[1])); x++) {
      const i = (y * w + x) * 4;
      const [r, g, b] = [withIt.data[i], withIt.data[i + 1], withIt.data[i + 2]];
      if (Math.max(Math.abs(r - without.data[i]), Math.abs(g - without.data[i + 1]), Math.abs(b - without.data[i + 2])) < least) continue;
      const top = Math.max(r, g, b);
      const c = top - Math.min(r, g, b);
      let h = c > 0 ? (top === r ? ((g - b) / c) % 6 : top === g ? (b - r) / c + 2 : (r - g) / c + 4) * 60 : 0;
      h = (h + 360) % 360;
      n++;
      saturation += top > 0 ? c / top : 0;
      sx += c * Math.cos(h * RAD);
      sy += c * Math.sin(h * RAD);
    }
  }
  return { n, saturation: saturation / Math.max(1, n), hue: ((Math.atan2(sy, sx) / RAD) + 360) % 360 };
}

/** How far apart two hues are (degrees, 0 to 180). */
const hueOff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

test("a tracer over the low sun's haze shows its team's colour: red, not orange; blue, not lavender; and red apart from amber", async ({ page }) => {
  // At 17:35, the hour solo opens at, the shooter faces the low sun through a bright haze, some (220,
  // 190, 150) as shown. A tracer's light only added to it: its brightest channel clipped at the
  // display's top while the others stayed the haze's, so a red tracer showed the haze's hue pulled a
  // little toward red (orange-peach, some 23 degrees, halfway to the enemy's amber at 42), a blue one
  // lavender-white, and the amber pale. While the sun is up its light covers what is behind it as much
  // as it shows its colour ([effects] tracer_cover), so each shows its own over the haze, as over the
  // night. Read on the displayed canvas, as a player sees it.
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
      return { position: c.position, yaw: c.yaw, pitch: c.pitch, fov: c.fov ?? 90 };
    },
    DUSK,
  );
  // 30 m out, 15° over the view against the haze over the low sun, 10 m across it.
  const RAD = Math.PI / 180;
  const y = at.yaw * RAD;
  const p = (at.pitch + 15) * RAD;
  const centre = [0, 1, 2].map((k) => at.position[k] + [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)][k] * 30);
  const right = [Math.cos(y), 0, -Math.sin(y)];
  const tail = centre.map((v, k) => v - right[k] * 5) as [number, number, number];
  const head = centre.map((v, k) => v + right[k] * 5) as [number, number, number];
  const shot = async (kind: number | null) => {
    await hooks(
      page,
      async (h, arg) => {
        const { tail, head, kind } = arg as { tail: [number, number, number]; head: [number, number, number]; kind: number | null };
        h.debugTracer(kind === null ? null : { tail, head, kind });
        await h.stepFrames(2);
      },
      { tail, head, kind },
    );
    return PNG.sync.read(await page.screenshot());
  };
  // Each kind's colour as shown at its kept hue: red (255, 59, 41), 5°; blue (65, 152, 255), 213°; the
  // enemy line's and the battle's amber (255, 177, 0), 42°.
  const teams = [
    { name: 'red', kind: 2, hue: 5 },
    { name: 'blue', kind: 3, hue: 213 },
    { name: 'amber', kind: 1, hue: 42 },
  ];
  const without = await shot(null);
  const measured = [];
  for (const team of teams) {
    const withIt = await shot(team.kind);
    // Where it lies on the canvas: 15° over its middle, 5 m either side 30 m out. Its glow as drawn
    // (0.22 m, some 5 px there, held between 4 and 10), clear of its ends and of its core's middle
    // (white-hot by day, as it is meant to be), and of it the pixels it changed by a step of 32 or
    // more: its glow, not its bloom round it (over the haze a blue one's lifts the blue all round, as
    // any bright light's does).
    const w = withIt.width;
    const tanHalf = Math.tan((at.fov * RAD) / 2);
    const rowAt = withIt.height / 2 - (Math.tan(15 * RAD) / tanHalf) * (w / 2);
    const halfLength = (5 / 30 / tanHalf) * (w / 2);
    const pixelM = (2 * 30 * Math.cos(15 * RAD) * tanHalf) / w;
    const glowPx = Math.min(10, Math.max(4, 0.22 / pixelM));
    const seen = changedColour(without, withIt, rowAt, [0.75, glowPx / 2 + 0.5], [w / 2 - halfLength + 16, w / 2 + halfLength - 16], 32);
    measured.push({ ...team, ...seen, off: hueOff(seen.hue, team.hue) });
  }
  const report = JSON.stringify(measured);
  console.log(report);
  for (const seen of measured) {
    expect(seen.n, report).toBeGreaterThan(300);
    // Its team's hue, within 12° (a third of the way from red to the battle's amber), and coloured, not
    // the haze's pastel (added alone, red's glow showed 0.33 and blue's 0.15). The bloom's own share of
    // the picture (render.bloom_weight) is the haze's all round, so over it a thin glow shows a little
    // of it whatever it covers: blue, whose own colour shows at 0.75 to red's 0.84, the more.
    expect(seen.off, report).toBeLessThan(12);
    expect(seen.saturation, report).toBeGreaterThan(0.4);
  }
  // Friend from foe at a glance: red's glow and amber's at least 25° apart (added alone, 20°).
  const [red, , amber] = measured;
  expect(hueOff(red.hue, amber.hue), report).toBeGreaterThan(25);
  await hooks(page, (h) => h.debugTracer(null));
  expect(errors).toEqual([]);
});

test('a tracer seen end on is its head alone: lit every frame 150 m out, its cap under three pixels or not; held small half a metre out', async ({ page }) => {
  // The review's case: aimed down the sights, once its tracer has joined its path (where the shot
  // was aimed) the player's round is drawn on a ray from the eye, so its streak is seen end on and
  // its head is all the shooter sees of it. A
  // streak whose ends fall within a pixel of each other draws nothing (not a sliver of noise); its
  // head is drawn no smaller than three pixels, its light kept, so it lights the same light's worth
  // of pixels every frame however it falls among them (at its true 0.4 px, 150 m out, it lit one
  // frame in a few), and near the eye no wider than its share of a glow held to 10 px (0.09 of 0.22:
  // 4.1 px), where at its true size it would be 115 px. Its cap is never under its three pixels: a
  // glow_max_px under 7.33 would set it there, and capped first it drew every far head smaller.
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
  // row and a column through it lit (over a hundredth of its brightest), and the light it lays round
  // it. At the cap as shipped it is held to its 4.1 px.
  const near = { head: out(0, 0, 0.5), tail: out(0, 0.4, 12.5) };
  const [cx, cy] = near.head.px.map(Math.round);
  const across = (line: number[]) => {
    const peak = Math.max(...line);
    const lit = line.map((v, i) => (v > 0.01 * peak ? i : -1)).filter((i) => i >= 0);
    return { peak, width: lit.length > 0 ? lit[lit.length - 1] - lit[0] + 1 : 0 };
  };
  const nearHead = async () => {
    const one = [{ tail: near.tail.at, head: near.head.at }];
    const [row] = await lightOver(one, [0, cy, at.res[0], 1]);
    const [column] = await lightOver(one, [cx, 0, 1, at.res[1]]);
    const [round] = await lightOver(one, [cx - 8, cy - 8, 16, 16]);
    return { row: across(row), column: across(column), light: round.reduce((a, b) => a + b, 0) };
  };
  const shipped = await nearHead();

  // The same heads with the cap at 2 px, as a glow_max_px of 4.9 would set it: the look the renderer's
  // effects were made with (effectsLook, from the tunables), changed here as a tunable would change it.
  // Held at three far off all the same, it lights every frame alike; held to two, the light it laid
  // swung by some 40% from frame to frame as it moved among the pixels. And the cap reaches the draw:
  // half a metre out the head is held to the three pixels, not its 4.1.
  type Look = { renderer: { effects: { look: { tracerHeadMaxPx: number } } } };
  const cap = await hooks(page, (h) => {
    const look = (h as unknown as Look).renderer.effects.look;
    const was = look.tracerHeadMaxPx;
    look.tracerHeadMaxPx = 2;
    return was;
  });
  const capped = await lightOver(far.map((f) => ({ tail: f.tail.at, head: f.head.at })), [x0, y0, 20, 20]);
  const cappedNear = await nearHead();
  await hooks(
    page,
    (h, was) => {
      (h as unknown as Look).renderer.effects.look.tracerHeadMaxPx = was as number;
    },
    cap,
  );
  const cappedTotals = capped.map((f) => f.reduce((a, b) => a + b, 0));
  const cappedPeaks = capped.map((f) => Math.max(...f));
  const cappedSeen = JSON.stringify({ cap, totals: cappedTotals, peaks: cappedPeaks });
  expect(cap, cappedSeen).toBeGreaterThan(3);
  for (const p of cappedPeaks) expect(p, cappedSeen).toBeGreaterThan(0.05 * Math.max(...cappedPeaks));
  expect(Math.min(...cappedTotals) / Math.max(...cappedTotals), cappedSeen).toBeGreaterThan(0.9);
  expect(Math.min(...cappedTotals), cappedSeen).toBeGreaterThan(0);

  // Near: as shipped, lit across 6 px at most (its 4.1 px, a pixel either side for where its edges
  // fall). Its light, as bright a disc either way (held narrower, not brightened), goes as its
  // drawn width squared: capped at 2 it is held to 3 px, (3 / 4.1)² of the light (0.54), and its
  // width from that, 4.1 × √(the light's share), about 3 px.
  const drawnPx = cap * Math.sqrt(cappedNear.light / shipped.light);
  const nearSeen = JSON.stringify({ cap, shipped, capped: cappedNear, drawnPx });
  for (const line of ['row', 'column'] as const) {
    expect(shipped[line].peak, nearSeen).toBeGreaterThan(1);
    expect(shipped[line].width, nearSeen).toBeLessThanOrEqual(6);
    expect(cappedNear[line].width, nearSeen).toBeLessThan(shipped[line].width);
  }
  expect(drawnPx, nearSeen).toBeGreaterThan(2.7);
  expect(drawnPx, nearSeen).toBeLessThan(3.3);
  expect(errors).toEqual([]);
});

test("a strike's ember far off is lit every frame: held no smaller than a head's three pixels, its light kept; near the eye held to ember_max_px across, not brightened", async ({ page }) => {
  // An ember is 6 cm across: 100 m out, under half a pixel, so moving across the view it lit some
  // frames and not others (a twinkle). It is drawn no smaller than a tracer's head is, its light
  // kept, so it lights the same light's worth of pixels every frame however it falls among them.
  // Near the eye it is held no wider than [effects.ricochet] ember_max_px (12 px across), narrowed and
  // not brightened, as a head is held to its cap: 1.5 m out its 6 cm would be a ball some 26 px across
  // on this 1280 px image (32 on the captures' 1600).
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
  /** The light each ember adds over `box` of the internal image (each, less the image without it): luminance, a row at a time. */
  const emberLight = (embers: [number, number, number][], box: [number, number, number, number]) =>
    hooks(
      page,
      async (h, arg) => {
        const { embers, box } = arg as { embers: [number, number, number][]; box: [number, number, number, number] };
        const lum = (a: number[], i: number) => 0.2126 * a[i * 3] + 0.7152 * a[i * 3 + 1] + 0.0722 * a[i * 3 + 2];
        h.debugEmber(null);
        await h.stepFrames(2);
        const without = await h.sharpAt(box);
        const seen: number[][] = [];
        for (const e of embers) {
          h.debugEmber({ at: e, kind: 2 });
          await h.stepFrames(2);
          const withIt = await h.sharpAt(box);
          seen.push(Array.from({ length: box[2] * box[3] }, (_, i) => lum(withIt, i) - lum(without, i)));
        }
        h.debugEmber(null);
        return seen;
      },
      { embers, box },
    );
  // 100 m out, 20° over the view against the night sky, moving a third of a pixel right and a quarter
  // up each frame.
  const steps = Array.from({ length: 8 }, (_, k) => out(20 + 0.023 * k, 0.37 * k, 100));
  const box: [number, number, number, number] = [Math.round(steps[0].px[0]) - 8, Math.round(steps[steps.length - 1].px[1]) - 8, 20, 20];
  const frames = await emberLight(steps.map((s) => s.at), box);
  const totals = frames.map((f) => f.reduce((a, b) => a + b, 0));
  const peaks = frames.map((f) => Math.max(...f));
  const seen = JSON.stringify({ totals, peaks });
  for (const p of peaks) expect(p, seen).toBeGreaterThan(0.05 * Math.max(...peaks));
  expect(Math.min(...totals) / Math.max(...totals), seen).toBeGreaterThan(0.9);
  expect(Math.min(...totals), seen).toBeGreaterThan(0);

  // 1.5 m out, 10° over the view's middle against the night sky: a row and a column through it lit
  // (over a hundredth of its brightest) across 12 px at most. Then with the look's cap lifted (as a
  // tunable would lift it: the renderer's effects' look, from the tunables), across its own 6 cm (some
  // 26 px), and as bright at its middle: held narrower, not brightened.
  const near = out(10, 0, 1.5);
  const [cx, cy] = near.px.map(Math.round);
  const ownPx = (0.06 * at.res[0]) / (2 * 1.5 * Math.cos(10 * RAD) * tanHalf);
  const across = (line: number[]) => {
    const peak = Math.max(...line);
    const lit = line.map((v, i) => (v > 0.01 * peak ? i : -1)).filter((i) => i >= 0);
    return { peak, width: lit.length > 0 ? lit[lit.length - 1] - lit[0] + 1 : 0 };
  };
  const nearLines = async () => {
    const [row] = await emberLight([near.at], [0, cy, at.res[0], 1]);
    const [column] = await emberLight([near.at], [cx, 0, 1, at.res[1]]);
    return { row: across(row), column: across(column) };
  };
  const capped = await nearLines();
  type Look = { renderer: { effects: { look: { emberMaxPx: number } } } };
  const cap = await hooks(page, (h) => {
    const look = (h as unknown as Look).renderer.effects.look;
    const was = look.emberMaxPx;
    look.emberMaxPx = 1000;
    return was;
  });
  const lifted = await nearLines();
  await hooks(
    page,
    (h, was) => {
      (h as unknown as Look).renderer.effects.look.emberMaxPx = was as number;
    },
    cap,
  );
  const nearSeen = JSON.stringify({ cap, ownPx, capped, lifted });
  for (const line of ['row', 'column'] as const) {
    expect(capped[line].peak, nearSeen).toBeGreaterThan(1);
    expect(capped[line].width, nearSeen).toBeLessThanOrEqual(12);
    expect(lifted[line].width, nearSeen).toBeGreaterThanOrEqual(ownPx - 3);
    expect(capped[line].peak / lifted[line].peak, nearSeen).toBeGreaterThan(0.9);
    expect(capped[line].peak / lifted[line].peak, nearSeen).toBeLessThan(1.1);
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
