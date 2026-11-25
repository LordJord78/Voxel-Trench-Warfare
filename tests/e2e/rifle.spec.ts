import { expect, test, type Page } from '@playwright/test';
import { projectToPixel } from '../../src/render/camera';
import { handsBecome, hooks, openGame, type Hooks } from './support/app';

// The rifle, traced and shaded in its own pass: where the CPU's trace of the model meets it, the
// G-buffer's depth is the rifle's; a wall nearer than it hides it; it is not drawn in fly mode or
// through the periscope; and it is lit by the world's light and its own flash. Aimed, its front
// post's tip meets the crosshair; from the hip it leaves most of the view clear.

/** The hooks the sight picture's tests use past what Hooks types: the loadout, the sights, the hands, and the hands held still. */
type Held = Hooks & {
  setLoadout(l: unknown): void;
  aim(held: boolean): void;
  hands(): { held: number; ready: number; aimed: number; gun: string };
  session: { handsStill: boolean };
};

const held = <T>(page: Page, fn: (h: Held, arg: unknown) => T | Promise<T>, arg?: unknown): Promise<T> => hooks(page, fn as unknown as (h: Hooks, arg: unknown) => T | Promise<T>, arg);

/** Playing at a view's foot, still, jitter off (so the pixels' rays are the CPU's). */
async function holding(page: Page, view: 'bay' | 'step', yaw = 0) {
  await hooks(page, (h) => h.play());
  await hooks(
    page,
    (h, arg) => {
      const { view, yaw } = arg as { view: 'bay' | 'step'; yaw: number };
      const v = h.views[view];
      h.teleport({ position: [v.position[0], v.position[1] - 1.62, v.position[2]], yaw: v.yaw + yaw, pitch: 0 });
      h.jitter(false);
    },
    { view, yaw },
  );
  await hooks(page, (h) => h.waitFrames(30));
}

/** The rifle check, and the world's own depth at its pixels with the rifle put down for a frame. */
async function checkAgainstWorld(page: Page, n: number) {
  const r = await hooks(page, (h, n) => h.rifleCheck(n as number), n);
  const world = await hooks(
    page,
    async (h, px) => {
      h.showRifle(false);
      await h.waitFrames(2);
      const depths = await h.depthAt(px as [number, number][]);
      h.showRifle(true);
      await h.waitFrames(2);
      return depths;
    },
    r.samples.map((s) => s.px),
  );
  return { visible: r.visible, samples: r.samples.map((s, k) => ({ ...s, world: world[k] })) };
}

test("the rifle's pass agrees with a CPU trace of the model", async ({ page }) => {
  const errors = await openGame(page);
  await holding(page, 'bay');
  const r = await checkAgainstWorld(page, 12);
  expect(r.visible).toBe(true);
  let drawn = 0;
  for (const s of r.samples) {
    // The rifle where it is nearer than the world, exactly where the CPU's trace meets it; the world elsewhere.
    if (s.cpu !== null && s.cpu < s.world) {
      expect(Math.abs(s.gpu - s.cpu), JSON.stringify(s)).toBeLessThan(1e-3);
      drawn++;
    } else {
      expect(Math.abs(s.gpu - s.world), JSON.stringify(s)).toBeLessThan(1e-4);
    }
  }
  expect(drawn).toBeGreaterThan(8);
  expect(errors).toEqual([]);
});

test('a wall the rifle is pushed into hides what is behind it', async ({ page }) => {
  const errors = await openGame(page);
  // Turned to the trench's side and walked into it: the rifle reaches past the wall's face.
  await holding(page, 'bay', 90);
  await page.keyboard.down('KeyW');
  await hooks(page, (h) => h.waitFrames(120));
  await page.keyboard.up('KeyW');
  await hooks(page, (h) => h.waitFrames(20));
  const r = await hooks(page, (h) => h.rifleCheck(12));
  const hits = r.samples.filter((s) => s.cpu !== null);
  // Never drawn farther than the rifle is; where the rifle is behind the wall, the wall is drawn.
  for (const s of hits) expect(s.gpu, JSON.stringify(s)).toBeLessThanOrEqual(s.cpu! + 1e-3);
  expect(hits.filter((s) => s.gpu < s.cpu! - 0.05).length, JSON.stringify(r.samples)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('no rifle through the periscope or in fly mode', async ({ page }) => {
  const errors = await openGame(page);
  await holding(page, 'step');
  const held = await hooks(page, (h) => h.rifleCheck(12));
  expect(held.visible).toBe(true);
  const on = held.samples.find((s) => s.cpu !== null)!;
  await page.keyboard.press('KeyQ');
  await hooks(page, (h) => h.waitFrames(60));
  expect((await hooks(page, (h) => h.player())).stance).toBe(4);
  const through = await hooks(page, (h, px) => Promise.all([h.rifleVisible(), h.depthAt([px as [number, number]])]), on.px);
  expect(through[0]).toBe(false);
  expect(through[1][0]).toBeGreaterThan(1.3);
  await hooks(page, async (h) => {
    h.view('bay');
    await h.waitFrames(10);
  });
  expect(await hooks(page, (h) => h.rifleVisible())).toBe(false);
  expect(errors).toEqual([]);
});

test('on the firing step the rifle is raised over the parapet, and drawn', async ({ page }) => {
  const errors = await openGame(page);
  await holding(page, 'step');
  const r = await checkAgainstWorld(page, 12);
  expect(r.visible).toBe(true);
  const drawn = r.samples.filter((s) => s.cpu !== null && s.cpu < s.world && Math.abs(s.gpu - s.cpu) < 1e-3);
  expect(drawn.length, JSON.stringify(r.samples)).toBeGreaterThan(8);
  expect(errors).toEqual([]);
});

test('the rifle is lit by the world, and by its own flash', async ({ page }) => {
  const errors = await openGame(page);
  await holding(page, 'bay');
  const at = async (hours: number) =>
    hooks(
      page,
      async (h, t) => {
        h.setTimeOfDay(t as number);
        await h.waitFrames(30);
        return h.rifleLuminance();
      },
      hours,
    );
  const noon = await at(12);
  const night = await at(23);
  expect(noon / night, JSON.stringify({ noon, night })).toBeGreaterThan(5);
  const flashed = await hooks(page, async (h) => {
    h.debugLights([{ position: h.rifleMuzzle(), radiusM: 6, colour: [1.0, 0.72, 0.4], intensity: 40 }]);
    await h.waitFrames(2);
    const lum = await h.rifleLuminance();
    h.debugLights([]);
    return lum;
  });
  // The flash is in front of the rifle, and most of its faces look aside or up: a fifth more, about.
  expect(flashed / night, JSON.stringify({ night, flashed })).toBeGreaterThan(1.1);
  expect(errors).toEqual([]);
});

test("aimed, the front post's tip meets the crosshair: the post's top edge is within 2 px of the centre row", async ({ page }) => {
  // At 1600 x 1000, the AK on its irons aimed from the firing step over the field, its hands held still
  // (no breathing, no aim-in overshoot: the pose's own picture) and no shot. Down the canvas's middle
  // column, by the CPU's trace of the drawn model where the G-buffer's depth is the model's (the frame
  // stepped and held, so none is drawing as it is read): the front post (0.60-0.63 m along the gun,
  // whose origin is 0.1 m before the eye: 0.70-0.73 m out, seen in the rear sight's notch) from the
  // centre row or the one under it down, and nothing of the gun 3 px over it.
  await page.setViewportSize({ width: 1600, height: 1000 });
  const errors = await openGame(page);
  await held(page, (h) => {
    h.setQuality({ dynres: false });
    h.setLoadout({ primary: 'ak74', secondary: 'm17', fits: {} });
  });
  await holding(page, 'step');
  await held(page, (h) => {
    h.session.handsStill = true;
    h.aim(true);
  });
  await handsBecome(page, { gun: 'ak74', aimed: 1 });
  const seen = await held(page, async (h) => {
    await h.waitFrames(20);
    h.freeze();
    await h.stepFrames(2);
    const [w, ht] = h.stats().res;
    const cx = Math.floor(w / 2);
    const cy = Math.floor(ht / 2);
    const column = Array.from({ length: 41 }, (_, k) => [cx, cy - 20 + k] as [number, number]);
    const r = await h.riflePixels(column);
    h.thaw();
    return { res: r.res, cx, cy, visible: r.visible, samples: r.samples, aimed: h.hands().aimed };
  });
  const said = JSON.stringify({ ...seen, samples: seen.samples.map((s) => ({ y: s.px[1], gpu: +s.gpu.toFixed(4), cpu: s.cpu === null ? null : +s.cpu.toFixed(4) })) });
  expect(seen.visible, said).toBe(true);
  expect(seen.aimed).toBe(1);
  // A pixel of the internal image is this many of the 1600 x 1000 canvas's.
  const k = seen.res[1] / 1000;
  const drawn = (s: (typeof seen.samples)[number]) => s.cpu !== null && Math.abs(s.gpu - s.cpu) < 1e-3;
  const post = (s: (typeof seen.samples)[number]) => drawn(s) && s.cpu! > 0.69 && s.cpu! < 0.74;
  const at = (y: number) => seen.samples.find((s) => s.px[1] === y)!;
  const top = seen.samples.find((s) => s.cpu !== null);
  console.log(`aimed AK, down the middle column (internal ${seen.res.join(' x ')}, centre row ${seen.cy}): the gun's first pixel at row ${top?.px[1]} (${top ? ((top.px[1] - seen.cy) / k).toFixed(2) : '-'} px of 1600 x 1000 from the centre row), ${top?.cpu?.toFixed(4)} m out`);
  // The gun's top edge down the middle is the post's, within 2 px of the centre row.
  expect(top, said).toBeDefined();
  expect(post(top!), said).toBe(true);
  expect(Math.abs(top!.px[1] - seen.cy), said).toBeLessThanOrEqual(2 * k);
  // 3 px over the centre, nothing of the gun; the centre pixel, or the one under it, the post.
  expect(at(seen.cy - Math.ceil(3 * k)).cpu, said).toBeNull();
  expect(post(at(seen.cy)) || post(at(seen.cy + Math.max(1, Math.round(k)))), said).toBe(true);
  expect(errors).toEqual([]);
});

/** Each gun in the hands (bare), the long guns as the primary, the pistols as the secondary on its number. */
const EVERY_GUN = [
  ['ak74', 0], ['m4', 0], ['mp5', 0], ['svd', 0], ['m249', 0], ['m870', 0], ['m17', 1], ['pm', 1],
] as const;

test('from the hip the gun covers at most 30% of the view', async ({ page }) => {
  // Standing in the spawn bay, off the firing step, at 1600 x 1000, each gun bare in the hands and held
  // still: the share of the view where the renderer drew it (the CPU's trace of the model meets the
  // pixel and the G-buffer's depth there is the model's), over every other pixel each way, the frame
  // stepped and held as it is read. The trace alone (drawn or hidden by something nearer) is reported
  // beside it, and floors the share: nothing in the bay is nearer than the gun, so the drawn share is
  // nine tenths of the traced or more (a gun not drawn where it is traced reads as a share near none),
  // and every gun shows on 1% of the view or more. Then, reported and not gated (the firing step's raised pose keeps its look on the
  // parapet: the G4 ledger), the AK raised on the Ravine's firing step with the range up: its share,
  // and whether it covers the range's 30 m torso plate (right of the middle, just under the horizon).
  await page.setViewportSize({ width: 1600, height: 1000 });
  const errors = await openGame(page);
  await held(page, (h) => h.setQuality({ dynres: false }));
  await holding(page, 'bay');
  await held(page, (h) => {
    h.session.handsStill = true;
  });
  expect((await held(page, (h) => h.player())).onFiringStep).toBe(false);
  const shareNow = () =>
    held(page, async (h) => {
      await h.waitFrames(6);
      h.freeze();
      await h.stepFrames(2);
      const r = await h.rifleShare(2);
      h.thaw();
      return r;
    });
  const shares: Record<string, { share: number; traced: number }> = {};
  for (const [gun, slot] of EVERY_GUN) {
    await held(page, (h, l) => h.setLoadout(l), slot === 0 ? { primary: gun, secondary: 'm17', fits: {} } : { primary: 'ak74', secondary: gun, fits: {} });
    if (slot === 1) await page.keyboard.press('Digit2');
    await handsBecome(page, { gun, held: slot, ready: 1 });
    const r = await shareNow();
    shares[gun] = { share: r.share, traced: r.traced };
    expect(r.drawn, gun).toBeGreaterThan(0);
    expect(r.share, `${gun}: ${JSON.stringify(r)}`).toBeGreaterThanOrEqual(0.9 * r.traced);
    expect(r.share, `${gun}: ${JSON.stringify(r)}`).toBeGreaterThanOrEqual(0.01);
  }
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  console.log(`from the hip off the step, each gun's share of the view (drawn; traced): ${Object.entries(shares).map(([g, s]) => `${g} ${pct(s.share)} (${pct(s.traced)})`).join(', ')}`);
  for (const [gun, s] of Object.entries(shares)) expect(s.share, gun).toBeLessThanOrEqual(0.3);

  // Reported: on the Ravine's firing step with the range up, the AK raised, not aimed (aimed, it is
  // gated: the next test).
  const step = await held(page, async (h) => {
    h.setLoadout({ primary: 'ak74', secondary: 'm17', fits: {} });
    h.range(true);
    h.standAt('step');
    h.jitter(false);
    await h.waitFrames(40);
    h.freeze();
    await h.stepFrames(2);
    const r = await h.rifleShare(2);
    const out = { map: (h as unknown as { map: string }).map, share: r.share, traced: r.traced, box: r.box, plates: h.rangeState().plates, camera: h.camera(), res: h.stats().res, onStep: h.player().onFiringStep, hands: h.hands() };
    return out;
  });
  const plate = step.plates.find((p) => p.index === 0);
  let cover = 'no plate';
  if (plate && step.onStep) {
    const at = projectToPixel({ ...step.camera, fov: step.camera.fov! }, step.res, plate.at);
    const k = step.res[1] / 1000;
    if (at) {
      // Its middle, and a box 8 px of the canvas's each way round it.
      const r = Math.ceil(8 * k);
      const points: [number, number][] = [];
      for (let dy = -r; dy <= r; dy += 2) for (let dx = -r; dx <= r; dx += 2) points.push([Math.floor(at[0]) + dx, Math.floor(at[1]) + dy]);
      const read = await held(page, (h, p) => h.riflePixels(p as [number, number][]), points);
      const gun = read.samples.filter((s) => s.cpu !== null && Math.abs(s.gpu - s.cpu) < 1e-3).length;
      cover = `the 30 m plate at (${(at[0] / k).toFixed(0)}, ${(at[1] / k).toFixed(0)}) of 1600 x 1000: ${gun} of ${points.length} pixels round it the gun's`;
    }
  }
  await held(page, (h) => h.thaw());
  console.log(`on the ${step.map}'s firing step (${step.onStep ? 'on it' : 'off it'}), the AK raised (aimed ${step.hands.aimed}): its share ${pct(step.share)} (traced ${pct(step.traced)}), its box ${JSON.stringify(step.box)} of ${step.res.join(' x ')}; ${cover}`);
  expect(errors).toEqual([]);
});

test("aimed on the Ravine's firing step, the AK leaves the range's 30 m plate clear", async ({ page }) => {
  // The G4 ledger's ruling: raised and not aimed, the AK on the firing step may cover the range's 30 m
  // torso plate (hip framing, reported above); aimed, it must not. At 1600 x 1000, the range up, the AK
  // aimed down its irons, its hands held still, the frame stepped and held: on the step and aimed, the
  // plate (index 0, right of the middle, just under the horizon) on the screen, and none of the pixels
  // of a box 8 px of the canvas's each way round its middle the gun's (the CPU's trace of the drawn
  // model meets it and the G-buffer's depth there is the model's). Aimed whole, the pose is the sight
  // line's alone: the step's raise is not in it.
  await page.setViewportSize({ width: 1600, height: 1000 });
  const errors = await openGame(page);
  await held(page, (h) => h.setQuality({ dynres: false }));
  await hooks(page, (h) => h.play());
  await held(page, (h) => {
    h.setLoadout({ primary: 'ak74', secondary: 'm17', fits: {} });
    h.range(true);
    h.standAt('step');
    h.jitter(false);
    h.session.handsStill = true;
    h.aim(true);
  });
  await handsBecome(page, { gun: 'ak74', aimed: 1 });
  const step = await held(page, async (h) => {
    await h.waitFrames(40);
    h.freeze();
    await h.stepFrames(2);
    return { map: (h as unknown as { map: string }).map, plates: h.rangeState().plates, camera: h.camera(), res: h.stats().res, onStep: h.player().onFiringStep, hands: h.hands() };
  });
  const said = JSON.stringify(step);
  expect(step.onStep, said).toBe(true);
  expect(step.hands.aimed, said).toBe(1);
  const plate = step.plates.find((p) => p.index === 0);
  expect(plate, said).toBeDefined();
  const at = projectToPixel({ ...step.camera, fov: step.camera.fov! }, step.res, plate!.at);
  expect(at, said).not.toBeNull();
  const [w, ht] = step.res;
  expect(at![0] >= 0 && at![0] < w && at![1] >= 0 && at![1] < ht, `${JSON.stringify(at)} of ${w} x ${ht}`).toBe(true);
  // Its middle, and a box 8 px of the canvas's each way round it.
  const k = ht / 1000;
  const r = Math.ceil(8 * k);
  const points: [number, number][] = [];
  for (let dy = -r; dy <= r; dy += 2) for (let dx = -r; dx <= r; dx += 2) points.push([Math.floor(at![0]) + dx, Math.floor(at![1]) + dy]);
  const read = await held(page, (h, p) => h.riflePixels(p as [number, number][]), points);
  await held(page, (h) => h.thaw());
  const gun = read.samples.filter((s) => s.cpu !== null && Math.abs(s.gpu - s.cpu) < 1e-3);
  console.log(`on the ${step.map}'s firing step, the AK aimed: the 30 m plate at (${(at![0] / k).toFixed(0)}, ${(at![1] / k).toFixed(0)}) of 1600 x 1000; ${gun.length} of ${points.length} pixels round it the gun's`);
  expect(read.visible).toBe(true);
  expect(gun, JSON.stringify(gun)).toHaveLength(0);
  expect(errors).toEqual([]);
});
