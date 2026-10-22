import { expect, test } from '@playwright/test';
import { readImage, useManyLights } from './many-lights';
import { hooks, openGame } from './support/app';
import { openHarness, runCase } from './support/run';

interface Cells {
  cells: number;
  mismatched: number[];
  denseMismatched: number[];
  empty: number;
  refEmpty: number;
  crowd: { reaching: number; count: number; same: boolean };
  ms: number | null;
  errors: string[];
}

test('the light cells list, cell for cell, what the reference lists for 1,024 lights over the map; an empty cell none, a crowded one its 32 nearest', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<Cells>(page, 'lightCells', { seed: 7, runs: 31 });
  expect(r.errors).toEqual([]);
  expect(r.cells).toBe(32 * 32);
  expect(r.mismatched).toEqual([]);
  // And where more lights reach a cell than it gathers at once (200 reaching every cell).
  expect(r.denseMismatched).toEqual([]);
  // Cells no light reaches are emptied of the last build's lights.
  expect(r.refEmpty).toBeGreaterThan(64);
  expect(r.empty).toBe(r.refEmpty);
  expect(r.crowd.reaching).toBeGreaterThan(32);
  expect(r.crowd.count).toBe(32);
  expect(r.crowd.same).toBe(true);
  // The build, a thread a cell over every light: within 0.05 ms.
  if (r.ms !== null) expect(r.ms).toBeLessThanOrEqual(0.05);
  console.log(`light cells build: ${r.ms?.toFixed(4)} ms`);
});

test('ReSTIR\'s point light over the floor, 64 frames of it, has the mean of the lights\' own sum, within 5%, colour by colour', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ mean: number[]; want: number[]; errors: string[] }>(page, 'restirMean', { frames: 64 });
  console.log(`ReSTIR mean over the floor: ${r.mean.map((v, c) => (v / r.want[c]).toFixed(4)).join(', ')} of the sum`);
  expect(r.errors).toEqual([]);
  for (let c = 0; c < 3; c++) expect(Math.abs(r.mean[c] / r.want[c] - 1)).toBeLessThanOrEqual(0.05);
});

test('with more lights than a pixel draws a frame (24), the point light over the floor still has the mean of the lights\' sum, within 5%', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ mean: number[]; want: number[]; errors: string[] }>(page, 'restirMean', { frames: 64, many: true });
  expect(r.errors).toEqual([]);
  console.log(`ReSTIR mean over the floor, 24 lights: ${r.mean.map((v, c) => (v / r.want[c]).toFixed(4)).join(', ')} of the sum`);
  for (let c = 0; c < 3; c++) expect(Math.abs(r.mean[c] / r.want[c] - 1)).toBeLessThanOrEqual(0.05);
});

test('a light moved between frames is weighed where it is now: its light the next frame is its light from there, and none once out of reach', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ there: number[]; want: number[]; gone: number[]; errors: string[] }>(page, 'restirMoved');
  expect(r.errors).toEqual([]);
  for (let c = 0; c < 3; c++) expect(Math.abs(r.there[c] / r.want[c] - 1)).toBeLessThanOrEqual(0.01);
  expect(r.gone).toEqual([0, 0, 0]);
});

test('a light that comes within reach is lit in full the frame it arrives, though no history had it', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ arrived: number[]; want: number[]; errors: string[] }>(page, 'restirArrived');
  expect(r.errors).toEqual([]);
  console.log(`arrived: ${r.arrived.map((v, c) => (v / r.want[c]).toFixed(4)).join(', ')} of a floor lit by both from the start`);
  for (let c = 0; c < 3; c++) expect(Math.abs(r.arrived[c] / r.want[c] - 1)).toBeLessThanOrEqual(0.05);
});

test('each lighting pixel keeps a reservoir from frame to frame: 8 candidates a frame, its history capped at 160, started afresh on a reset', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ seen: { light: number; weight: number; count: number }[]; sound: boolean; errors: string[] }>(page, 'restirReservoirs', { frames: 40, reset: 30 });
  expect(r.errors).toEqual([]);
  expect(r.sound).toBe(true);
  const counts = r.seen.map((s) => s.count);
  // The first frame has no history; then each adds its 8 to a history of at most 160.
  expect(counts.slice(0, 4)).toEqual([8, 16, 24, 32]);
  expect(counts.slice(25, 30)).toEqual([168, 168, 168, 168, 168]);
  expect(counts.slice(30, 33)).toEqual([8, 16, 24]);
  for (const s of r.seen) {
    expect(s.light).toBeGreaterThanOrEqual(0);
    expect(s.weight).toBeGreaterThan(0);
  }
});

test('at a corner, each face lit from in front by the same lights gets their light at its own points, with its own normal', async ({ page }) => {
  await openHarness(page);
  type Face = { pixels: number; got: number[]; want: number[] };
  const r = await runCase<{ front: Face; side: Face; errors: string[] }>(page, 'restirCorner', { frames: 64 });
  expect(r.errors).toEqual([]);
  for (const [name, face] of [['front', r.front], ['side', r.side]] as const) {
    console.log(`corner ${name}: ${face.pixels} pixel-frames, ${face.got.map((v, c) => (v / face.want[c]).toFixed(4)).join(', ')} of the lights' sum`);
    expect(face.pixels).toBeGreaterThan(64 * 40);
    for (let c = 0; c < 3; c++) expect(Math.abs(face.got[c] / face.want[c] - 1)).toBeLessThanOrEqual(0.05);
  }
});

test('with no more lights than a pixel draws a frame (6), its point light is the lights\' sum every frame: nothing merged or shared to add noise', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ error: number; errors: string[] }>(page, 'restirNoise', { frames: 32, warm: 24, size: 256, spatial: true });
  expect(r.errors).toEqual([]);
  console.log(`error against the sum, 6 lights: ${r.error.toFixed(4)}`);
  // What is left is the half floats the light is kept in.
  expect(r.error).toBeLessThan(0.005);
});

test('neighbours sharing their picks bring the point light nearer the lights\' sum, settled and most of all just after a cut', async ({ page }) => {
  test.setTimeout(180_000);
  await openHarness(page);
  // 256 pixels across the floor's 11 m: 12 lighting pixels are a metre, as a view's are a few metres
  // off. Twenty-four lights, three times a pixel's candidates: with fewer, each pixel draws every
  // light every frame, and its own estimate is all but exact.
  const run = (spatial: boolean, cycle?: number) => runCase<{ error: number; errors: string[] }>(page, 'restirNoise', { frames: 32, warm: cycle ? 0 : 24, size: 256, spatial, cycle, many: true });
  const [alone, shared, aloneCut, sharedCut] = [await run(false), await run(true), await run(false, 8), await run(true, 8)];
  for (const r of [alone, shared, aloneCut, sharedCut]) expect(r.errors).toEqual([]);
  console.log(`error against the sum: settled ${alone.error.toFixed(4)} alone, ${shared.error.toFixed(4)} shared; cut every 8 frames ${aloneCut.error.toFixed(4)} alone, ${sharedCut.error.toFixed(4)} shared`);
  expect(shared.error).toBeLessThan(alone.error);
  expect(sharedCut.error).toBeLessThan(0.8 * aloneCut.error);
});

test('where neighbours\' lights differ most, sharing costs a settled pixel little: its history stays its own', async ({ page }) => {
  await openHarness(page);
  // 64 pixels across 11 m, lights 2 m up: 12 lighting pixels are 4 m, and the lights' light differs
  // several-fold across them. Shared reservoirs kept as history made the error several times worse.
  const run = (spatial: boolean) => runCase<{ error: number; errors: string[] }>(page, 'restirNoise', { frames: 32, warm: 24, size: 64, spatial, many: true });
  const [alone, shared] = [await run(false), await run(true)];
  expect(alone.errors).toEqual([]);
  expect(shared.errors).toEqual([]);
  console.log(`error against the sum, coarse: ${alone.error.toFixed(4)} alone, ${shared.error.toFixed(4)} shared`);
  expect(shared.error).toBeLessThan(1.2 * alone.error);
});

// Row 2: a thousand lights over the field at night, from the overview. The frame's test flags: no
// sharing between neighbours (32), and no reservoir carried from frame to frame (64) — plain
// resampling of each pixel's eight candidates, every frame afresh, the reference's sampling. The
// app's loop is frozen and stepped a frame at a time, the lights' clock a sixtieth of a second a
// step, so each frame read is the one drawn, and both runs see the same lights move the same way.
const PLAIN = 32 | 64;

test.describe('a thousand lights at night', () => {
  test.use({ viewport: { width: 800, height: 500 }, deviceScaleFactor: 1 });

  const setUp = async (page: import('@playwright/test').Page) => {
    const errors = await openGame(page);
    await hooks(page, (h) => {
      h.setQuality({ preset: 'high', dynres: false });
      h.view('overview');
      h.setTimeOfDay(21);
    });
    await useManyLights(page);
    await hooks(page, (h) => h.freeze());
    return errors;
  };
  /** A run under the frame's `flags`, the history started afresh and the lights' clock at 3 s: a stepper. */
  const run = async (page: import('@playwright/test').Page, flags: number) => {
    await hooks(page, (h, f) => {
      const r = (h as unknown as { renderer: { flags: number; resetHistory(): void } }).renderer;
      r.flags = f as number;
      r.resetHistory();
    }, flags);
    let t = 3;
    return async (frames: number) => {
      for (let i = 0; i < frames; i++) {
        t += 1 / 60;
        await hooks(page, (h, s) => h.holdLights(s as number), t);
        await hooks(page, (h) => h.stepFrames(1));
      }
    };
  };

  test('with 256 of them moving, their mean over the field is plain resampling\'s, frame for frame, within 5%', async ({ page }) => {
    test.setTimeout(400_000);
    const errors = await setUp(page);
    const mean = async (flags: number) => {
      const step = await run(page, flags);
      await step(48);
      const sum = [0, 0, 0];
      let n = 0;
      for (let f = 0; f < 128; f++) {
        await step(1);
        const px = await readImage(page, 'lNoisy', true);
        for (let i = 0; i < px.length; i += 3) for (let c = 0; c < 3; c++) sum[c] += px[i + c];
        n += px.length / 3;
      }
      return sum.map((v) => v / n);
    };
    const restir = await mean(0);
    const plain = await mean(PLAIN);
    console.log(`point light over the field, lights moving: ReSTIR ${restir.map((v, c) => (v / plain[c]).toFixed(4)).join(', ')} of plain resampling's`);
    for (let c = 0; c < 3; c++) expect(Math.abs(restir[c] / plain[c] - 1)).toBeLessThanOrEqual(0.05);
    expect(errors).toEqual([]);
  });

  test('with 256 of them moving, the image moves from frame to frame no more than under plain resampling, and by under 1.5% of its brightness', async ({ page }) => {
    test.setTimeout(600_000);
    const errors = await setUp(page);
    const fizz = async (flags: number) => {
      const step = await run(page, flags);
      await step(90);
      let change = 0;
      let last = await readImage(page, 'sharp');
      for (let f = 0; f < 64; f++) {
        await step(1);
        const now = await readImage(page, 'sharp');
        let d = 0;
        let total = 0;
        for (let i = 0; i < now.length; i++) {
          d += Math.abs(now[i] - last[i]);
          total += now[i];
        }
        change += d / total;
        last = now;
      }
      return change / 64;
    };
    // Two runs of each, in turn.
    const restir = ((await fizz(0)) + (await fizz(0))) / 2;
    const plain = ((await fizz(PLAIN)) + (await fizz(PLAIN))) / 2;
    console.log(`image change frame to frame, 256 lights moving: ReSTIR ${restir.toFixed(4)}, plain resampling ${plain.toFixed(4)}`);
    // The same within a run's wander (some 1%).
    expect(restir).toBeLessThan(1.05 * plain);
    expect(restir).toBeLessThan(0.015);
    expect(errors).toEqual([]);
  });

  test('far off, the denoiser keeps its history on rough ground, where a pixel spans several voxels\' faces', async ({ page }) => {
    const errors = await setUp(page);
    const step = await run(page, 0);
    await step(90);    // The history's length, frames, for each lighting pixel that sees a surface.
    const moments = await readImage(page, 'hMoments', true);
    const hits = await hooks(page, async (h) => {
      const r = (h as unknown as { renderer: { device: GPUDevice; texture(n: string): GPUTexture; stats: { res: [number, number] } } }).renderer;
      const t = r.texture('hHit');
      const stride = Math.ceil((t.width * 8) / 256) * 256;
      const buffer = r.device.createBuffer({ size: stride * t.height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const encoder = r.device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: t }, { buffer, bytesPerRow: stride }, [t.width, t.height]);
      r.device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const [w, hgt] = [Math.ceil(r.stats.res[0] / 2), Math.ceil(r.stats.res[1] / 2)];
      const faces: number[] = [];
      const bytes = buffer.getMappedRange();
      for (let y = 0; y < hgt; y++) {
        const row = new Uint32Array(bytes, y * stride, t.width * 2);
        for (let x = 0; x < w; x++) faces.push((row[x * 2] >>> 24) & 7);
      }
      buffer.unmap();
      buffer.destroy();
      return faces;
    });
    let surfaces = 0;
    let short = 0;
    hits.forEach((face, i) => {
      if (face >= 6) return;
      surfaces++;
      if (moments[i * 3 + 2] < 8) short++;
    });
    console.log(`histories under 8 frames: ${short} of ${surfaces} surface pixels`);
    // An exact face and plane, as up close, left 29% of them restarting every frame or two.
    expect(short / surfaces).toBeLessThan(0.1);
    expect(errors).toEqual([]);
  });
});
