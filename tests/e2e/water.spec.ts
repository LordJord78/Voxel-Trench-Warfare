import { expect, test } from '@playwright/test';
import { openHarness, runCase } from './support/run';

// The water's reflection (reflect.wgsl), over a pool before a lit brick wall (cases/water.ts): the
// wall reflected where the mirrored ray meets it, the sky beyond the reach or where nothing is, a
// flare's glint at its mirror image, and the low preset's sky and glints alone.

interface Sample {
  px: number;
  py: number;
  ray: number[];
  depthM: number;
  high: number[];
  bare: number[];
  low: number[];
  short: number[];
}

interface Reflected {
  pose: { position: number[] };
  waterY: number;
  samples: Sample[];
  glint: { px: number; py: number; water: boolean; with: number[]; without: number[]; low: number[]; aside: number[] } | null;
  errors: string[];
}

const luma = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const near = (a: number[], b: number[], share: number) => Math.abs(luma(a) - luma(b)) <= share * Math.max(luma(a), luma(b), 1e-6);

/** Whether the ray of `s`, mirrored about the water where it meets it, meets the wall's face (9.6 m out, 1.6–6.4 m up). */
function meetsWall(r: Reflected, s: Sample): boolean {
  const p = r.pose.position.map((c, k) => c + s.ray[k] * s.depthM);
  const m = [s.ray[0], -s.ray[1], s.ray[2]];
  if (m[2] <= 0) return false;
  const t = (9.6 - p[2]) / m[2];
  const y = p[1] + m[1] * t;
  const x = p[0] + m[0] * t;
  return y >= 1.6 && y <= 6.4 && x >= 0 && x <= 12.8;
}

test.describe("the water's reflection", () => {
  let r: Reflected;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await openHarness(page);
    r = await runCase<Reflected>(page, 'waterReflect');
    await page.close();
  });

  test('still water reflects the wall as it is lit, mirrored about the surface', () => {
    expect(r.errors).toEqual([]);
    expect(r.samples.length).toBeGreaterThan(200);
    const wall = r.samples.filter((s) => meetsWall(r, s));
    const sky = r.samples.filter((s) => !meetsWall(r, s));
    console.log(`water: ${r.samples.length} samples, ${wall.length} mirror the wall, ${sky.length} the sky`);
    expect(wall.length).toBeGreaterThan(30);
    // Where the mirrored ray meets the wall, the wall is there, unlike without it; elsewhere, the same.
    expect(wall.filter((s) => !near(s.high, s.bare, 0.2)).length / wall.length).toBeGreaterThan(0.9);
    expect(sky.filter((s) => near(s.high, s.bare, 0.02)).length / sky.length).toBeGreaterThan(0.95);
  });

  test('beyond its reach, or where nothing is, the sky', () => {
    expect(r.samples.filter((s) => near(s.short, s.bare, 0.02)).length / r.samples.length).toBeGreaterThan(0.98);
  });

  test("a flare's glint shows where its mirror image is", () => {
    expect(r.glint).not.toBeNull();
    const g = r.glint!;
    console.log(`glint: ${luma(g.with).toFixed(3)} with the flare, ${luma(g.without).toFixed(3)} without, ${luma(g.aside).toFixed(3)} 12 px aside`);
    expect(g.water).toBe(true);
    expect(luma(g.with)).toBeGreaterThan(3 * luma(g.without));
    expect(luma(g.with)).toBeGreaterThan(3 * luma(g.aside));
  });

  test('the low preset reflects the sky and the glints, and no wall', () => {
    expect(r.samples.filter((s) => near(s.low, s.bare, 0.02)).length / r.samples.length).toBeGreaterThan(0.98);
    expect(luma(r.glint!.low)).toBeGreaterThan(3 * luma(r.glint!.without));
  });
});

interface Surface {
  centre: number[];
  ringM: number;
  samples: { at: number[]; still: number[]; second: number[]; faded: number[]; calm: number[]; breeze: number[]; wind: number[] }[];
  errors: string[];
}

test.describe("the water's surface", () => {
  let s: Surface;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await openHarness(page);
    s = await runCase<Surface>(page, 'waterSurface');
    await page.close();
  });

  test('a ring bends the reflection on its circle, 1 m out after 1 s, and is gone by 2 s', () => {
    expect(s.errors).toEqual([]);
    const off = (x: { at: number[] }) => Math.hypot(x.at[0] - s.centre[0], x.at[2] - s.centre[2]);
    const bent = s.samples.filter((x) => !near(x.second, x.still, 0.03));
    console.log(`a ring 1 s on: ${bent.length} of ${s.samples.length} water samples bent, ${bent.filter((x) => Math.abs(off(x) - s.ringM) <= 0.4).length} of them within 0.4 m of its circle`);
    expect(bent.length).toBeGreaterThan(20);
    expect(bent.filter((x) => Math.abs(off(x) - s.ringM) <= 0.4).length / bent.length).toBeGreaterThan(0.8);
    // Away from its circle, untouched.
    const away = s.samples.filter((x) => Math.abs(off(x) - s.ringM) > 0.6);
    expect(away.filter((x) => near(x.second, x.still, 0.01)).length / away.length).toBeGreaterThan(0.98);
    // Near its end, all but gone.
    expect(s.samples.filter((x) => near(x.faded, x.still, 0.01)).length / s.samples.length).toBeGreaterThan(0.98);
  });

  test('the wind roughens the reflection, more for a stronger wind; none without its slope', () => {
    const mean = (k: 'breeze' | 'wind' | 'calm') => s.samples.reduce((sum, x) => sum + Math.abs(luma(x[k]) - luma(x.still)), 0) / s.samples.length;
    console.log(`the wind's roughness: ${mean('calm').toExponential(2)} calm, ${mean('breeze').toExponential(2)} at 0.024, ${mean('wind').toExponential(2)} at 0.048`);
    expect(mean('calm')).toBeLessThan(1e-4);
    expect(mean('breeze')).toBeGreaterThan(1e-3);
    expect(mean('wind')).toBeGreaterThan(1.5 * mean('breeze'));
  });
});

