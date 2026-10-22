import { expect, test } from '@playwright/test';
import { openHarness, runCase } from './support/run';

interface Compared {
  compared: number;
  hits: number;
  mismatches: number;
  nan: number;
  maxError: number;
  wrong: string[];
  texel: number;
}

interface KeyShadowSummary {
  compileErrors?: string[];
  texels: Compared;
  lit: { total: number; agree: number; shadowed: number; nearEdge: number; farFromEdge: string[] };
  off: { total: number; shadowed: number; least: number };
  interleave: { slots: string[]; mixed: number; twice: number; after: Compared };
  switched: Compared;
  turned: Compared;
  low: Compared;
  errors: string[];
}

const exact = (c: Compared) => {
  expect(c.wrong).toEqual([]);
  expect(c.mismatches).toBe(0);
  expect(c.nan).toBe(0);
  expect(c.maxError).toBeLessThanOrEqual(1);
};

test.describe("the key light's height map", () => {
  let r: KeyShadowSummary;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await openHarness(page);
    r = await runCase<KeyShadowSummary>(page, 'keyShadow');
    await page.close();
  });

  test('compiles, without GPU errors', () => {
    expect(r.compileErrors ?? []).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  test('on a wall on a floor, the key 30° up, every texel is within a voxel of the reference', () => {
    exact(r.texels);
    expect(r.texels.hits).toBeGreaterThan(1000);
  });

  test('keyLit agrees with a shadow ray toward the key at 2,000 points in the air, but within 2 texels of an edge', () => {
    console.log(`keyLit: ${r.lit.agree} of ${r.lit.total} agree (${r.lit.shadowed} shadowed); ${r.lit.nearEdge} near an edge`);
    expect(r.lit.shadowed).toBeGreaterThan(100);
    expect(r.lit.agree / r.lit.total).toBeGreaterThanOrEqual(0.99);
    expect(r.lit.farFromEdge).toEqual([]);
  });

  test('points off the map are lit: over it, and beyond its texels across the light', () => {
    console.log(`off the map: the least keyLit ${r.off.least}`);
    expect(r.off.total).toBe(400);
    expect(r.off.shadowed).toBe(0);
  });

  test('the interleave traces each texel exactly once in 16 frames', () => {
    // Each update changed texels of one tile in each 4 × 4 block of tiles, a different one each time.
    expect(r.interleave.mixed).toBe(0);
    expect(r.interleave.slots.every((s) => s.length > 0)).toBe(true);
    expect(new Set(r.interleave.slots).size).toBe(16);
    expect(r.interleave.twice).toBe(0);
    exact(r.interleave.after);
  });

  test('a switch between sun and moon rebuilds every texel at once', () => {
    exact(r.switched);
  });

  test('a turn of the key over a degree rebuilds every texel at once', () => {
    exact(r.turned);
  });

  test('at 1° elevation the texel is capped at 2 m, with no NaN', () => {
    expect(r.low.texel).toBeLessThanOrEqual(20);
    exact(r.low);
  });
});

test("the frame traces the key light's height map, a sixteenth a frame", async ({ page }) => {
  await openHarness(page);
  const f = await runCase<{ first: Compared; partway: Compared; after: Compared; errors: string[] }>(page, 'keyShadowFrames');
  expect(f.errors).toEqual([]);
  exact(f.first);
  // The floor raised 2 voxels: after 15 frames a sixteenth of the texels still reach it where it was; after 16, none.
  expect(f.partway.maxError).toBeGreaterThan(2);
  exact(f.after);
});

test.describe('the froxels', () => {
  test.setTimeout(120_000);

  test('with nothing to cast a shaft and no point lights, the haze to 120 m is the analytic fog: transmittance within 1%, colour within 2%', async ({ page }) => {
    await openHarness(page);
    const r = await runCase<{ answers: { haze: number[]; fog: number[] }[]; errors: string[] }>(page, 'hazeOpen');
    expect(r.errors).toEqual([]);
    const luma = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    let worstT = 0;
    let worstColour = 0;
    for (const { haze, fog } of r.answers) {
      // Within 1% of itself, or of a tenth where it is less: rays that run into the fog below its
      // base, through no ground, see it fall to 5e-5, which half floats hold to some 3e-5.
      worstT = Math.max(worstT, Math.abs(haze[3] - fog[3]) / Math.max(fog[3], 0.1));
      worstColour = Math.max(worstColour, Math.abs(luma(haze) - luma(fog)) / luma(fog));
    }
    console.log(`froxels against the analytic fog, worst of ${r.answers.length}: transmittance ${(worstT * 100).toFixed(3)}%, colour ${(worstColour * 100).toFixed(3)}%`);
    expect(worstT).toBeLessThanOrEqual(0.01);
    expect(worstColour).toBeLessThanOrEqual(0.02);
  });

  test("behind a wall with a slit, lit at 30°, the slit's shaft is brighter than the haze each side of it by a third of the key's share", async ({ page }) => {
    await openHarness(page);
    const r = await runCase<{ left: number; centre: number; right: number; keyShare: number; errors: string[] }>(page, 'hazeSlit');
    expect(r.errors).toEqual([]);
    console.log(`the haze at 5 m: left ${r.left.toFixed(4)}, through the slit ${r.centre.toFixed(4)}, right ${r.right.toFixed(4)}; the key's share ${r.keyShare.toFixed(4)}`);
    expect(r.centre - Math.max(r.left, r.right)).toBeGreaterThanOrEqual(r.keyShare / 3);
  });

  test("a camera turned 20° shows froxels within 3% of a fresh camera's after 4 frames, with no shaft left where the slit was", async ({ page }) => {
    await openHarness(page);
    const r = await runCase<{ turned: number[]; fresh: number[]; errors: string[] }>(page, 'hazeTurn');
    expect(r.errors).toEqual([]);
    const n = r.turned.length - 2;
    let diff = 0;
    let sum = 0;
    for (let k = 0; k < n; k++) {
      diff += Math.abs(r.turned[k] - r.fresh[k]);
      sum += r.fresh[k];
    }
    console.log(`turned against fresh: ${((diff / sum) * 100).toFixed(2)}% over the view; where the slit was ${r.turned.slice(n).map((v) => v.toFixed(4))} against ${r.fresh.slice(n).map((v) => v.toFixed(4))}`);
    expect(diff / sum).toBeLessThanOrEqual(0.03);
    for (let k = n; k < r.turned.length; k++) expect(Math.abs(r.turned[k] - r.fresh[k])).toBeLessThanOrEqual(0.03 * r.fresh[k]);
  });

  test('a lantern in clear air adds its haze within 10% of the analytic sum over the lights', async ({ page }) => {
    await openHarness(page);
    const r = await runCase<{ froxels: number[]; reference: number[]; errors: string[] }>(page, 'hazeLantern');
    expect(r.errors).toEqual([]);
    const most = Math.max(...r.reference);
    let worst = 0;
    r.reference.forEach((ref, k) => {
      if (ref >= 0.1 * most) worst = Math.max(worst, Math.abs(r.froxels[k] - ref) / ref);
    });
    console.log(`the lantern's haze: worst ${(worst * 100).toFixed(2)}% where it is a tenth of its most (${most.toFixed(4)}) or more`);
    expect(most).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(0.1);
  });
});
