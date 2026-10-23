import { expect, test } from '@playwright/test';
import { hooks, openGame } from './support/app';
import { openHarness, runCase } from './support/run';

interface Present {
  green: number[];
  expected: number;
  errors: string[];
}

/** ACES fit and gamma, as present.wgsl, for finding colours that land between two codes. */
const aces = (x: number) => Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
const code = (c: number) => 255 * aces(c) ** (1 / 2.2);

test('present maps HDR to the expected bytes', async ({ page }) => {
  await openHarness(page);
  for (const [c, exposure] of [[0.18, 1], [0.05, 3.2], [2.0, 1]]) {
    const r = await runCase<Present>(page, 'present', { c, exposure });
    expect(r.errors).toEqual([]);
    for (const g of r.green) expect(Math.abs(g - r.expected)).toBeLessThanOrEqual(1);
  }
});

test('dither stays within one code and breaks up flat grey', async ({ page }) => {
  await openHarness(page);
  // A colour whose exact code is 100.5: halfway between two, so plain rounding would pick one everywhere.
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (code(mid) < 100.5) lo = mid;
    else hi = mid;
  }
  const r = await runCase<Present>(page, 'present', { c: lo, exposure: 1 });
  expect(r.errors).toEqual([]);
  for (const g of r.green) expect(Math.abs(g - r.expected)).toBeLessThanOrEqual(1);
  const values = new Set(r.green);
  expect(values.size).toBeGreaterThanOrEqual(2);
});

test('present mixes the bloom into the image at its weight, before the exposure', async ({ page }) => {
  await openHarness(page);
  // A quarter of the light from a bloom five times the image: 0.75·0.1 + 0.25·0.5 = 0.2, two codes' worth of steps from 0.1.
  const r = await runCase<Present>(page, 'present', { c: 0.1, exposure: 1, bloom: 0.5, bloomWeight: 0.25 });
  expect(r.errors).toEqual([]);
  expect(Math.abs(r.expected - code(0.2))).toBeLessThan(0.5);
  for (const g of r.green) expect(Math.abs(g - r.expected)).toBeLessThanOrEqual(1);
});

test("upscaling a point as bright as the sun's disc leaves no dark ring round it", async ({ page }) => {
  await openHarness(page);
  // 32 texels to 48 pixels: the bicubic's negative lobes reach the pixels round the point.
  const r = await runCase<Present>(page, 'present', { c: 0.1, exposure: 1, spot: 30000, canvas: 48 });
  expect(r.errors).toEqual([]);
  expect(Math.min(...r.green)).toBeGreaterThanOrEqual(r.expected - 1);
});

test("CAS passes a texel as bright as the sun's disc through, unclipped, for the bloom to spread", async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ worst: number; spot: number[]; errors: string[] }>(page, 'casFlat', { c: [0.3, 0.2, 0.1, 1], spot: 30000 });
  expect(r.errors).toEqual([]);
  for (const v of r.spot) expect(v).toBe(30000);
  expect(r.worst).toBeLessThan(2e-3);
});

test('CAS leaves a flat colour unchanged', async ({ page }) => {
  await openHarness(page);
  const r = await runCase<{ worst: number; errors: string[] }>(page, 'casFlat', { c: [0.3, 0.2, 0.1, 1] });
  expect(r.errors).toEqual([]);
  expect(r.worst).toBeLessThan(2e-3);
});

// Suppression's look (the spec's §5, "The HUD"): the present pass greys the picture and darkens its
// edges by the level, desaturation 0.55 and vignette 0.5 at full; with none, the picture is as it was.
test('suppression greys the picture and closes it in, and none leaves it as it was', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await openGame(page);
  const seen: string[] = [];
  for (const quality of [{ preset: 'high', dynres: false, scale: 1 }, { preset: 'low', dynres: false }, { preset: 'high', dynres: false, scale: 0.5 }] as const) {
    const { none, full, after } = await hooks(
      page,
      async (h, q) => {
        h.setQuality(q as { preset: 'high' | 'low'; dynres: boolean; scale?: number });
        h.setIntensity('off');
        h.setShelling('off');
        h.play();
        await h.waitFrames(90);
        h.freeze();
        // The bay at dusk, held still: a frame at each level, set before it is drawn.
        const at = async (level: number) => {
          h.session.suppression.level = level;
          await h.stepFrames(30);
          h.session.suppression.level = level;
          const shot = h.snapshot();
          await h.stepFrames(1);
          return shot;
        };
        const none = await at(0);
        const full = await at(1);
        const after = await at(0);
        h.thaw();
        return { none, full, after };
      },
      quality,
    );
    const at = JSON.stringify({ quality, none, full, after });
    seen.push(at);
    expect(full.saturation, at).toBeLessThanOrEqual(0.6 * none.saturation);
    expect(full.edge / full.middle, at).toBeLessThanOrEqual(0.8 * (none.edge / none.middle));
    for (const k of ['mean', 'saturation', 'edge', 'middle'] as const) expect(Math.abs(after[k] - none[k]), at).toBeLessThanOrEqual(0.01 * none[k]);
  }
  console.log(seen.join('\n'));
  expect(errors).toEqual([]);
});
