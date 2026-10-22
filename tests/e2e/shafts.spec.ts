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
