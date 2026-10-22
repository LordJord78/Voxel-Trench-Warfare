import { expect, test } from '@playwright/test';
import { useManyLights } from './many-lights';
import { hooks, openGame } from './support/app';

// 1600 × 1000 CSS pixels at a device scale of 1: a 1.6 MP canvas, so the
// internal image is the high preset's 1.5 MP.
test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });

const VIEWS = ['bay', 'step', 'nml-night', 'overview', 'dugout', 'hamlet'];
// The clock's four keys: each view at dusk and at night, as before, at noon, the sky's brightest,
// and at dawn.
const TIMES: Record<string, number> = { dusk: 17 + 35 / 60, night: 21, noon: 12, dawn: 6 + 50 / 60 };
const BUDGET_MS = 14;
// Frames for the histories and the GPU's clocks to settle at a view, then frames whose GPU times
// are read: one frame's time wanders by a millisecond or two, their median does not.
const SETTLE = 90;
const SAMPLES = 31;

test('every standard view renders within the GPU budget at 1.5 MP, at dusk, at night, at noon and at dawn', async ({ page }) => {
  test.setTimeout(400_000);
  const errors = await openGame(page);
  // Measured at the high preset's full 1.5 MP: dynamic resolution would hide a slow view.
  await hooks(page, (h) => h.setQuality({ preset: 'high', dynres: false }));
  const first = await hooks(page, (h) => h.stats());
  test.skip(first.gpuMs === null && (await hooks(page, async (h) => (await h.waitFrames(30), h.stats().gpuMs))) === null, 'no timestamp queries on this GPU');
  const medians: Record<string, Record<string, number>> = {};
  for (const name of VIEWS) {
    medians[name] = {};
    for (const [time, t] of Object.entries(TIMES)) {
      await hooks(page, (h, n) => h.view(n as string), name);
      await hooks(page, (h, v) => h.setTimeOfDay(v as number), t);
      await hooks(page, (h, n) => h.waitFrames(n as number), SETTLE);
      const times = await hooks(
        page,
        async (h, n) => {
          const out: number[] = [];
          for (let i = 0; i < (n as number); i++) {
            await h.waitFrames(1);
            const s = h.stats();
            if (s.gpuMs !== null) out.push(s.gpuMs);
          }
          return out;
        },
        SAMPLES,
      );
      const s = await hooks(page, (h) => h.stats());
      expect(s.res[0] * s.res[1]).toBeGreaterThan(1.48e6);
      expect(times.length).toBeGreaterThan(SAMPLES / 2);
      times.sort((a, b) => a - b);
      medians[name][time] = times[times.length >> 1];
    }
  }
  console.log(`GPU ms per view, median of ${SAMPLES} frames (dusk/night/noon/dawn): ${VIEWS.map((v) => `${v} ${Object.keys(TIMES).map((t) => medians[v][t].toFixed(2)).join('/')}`).join(', ')}`);
  expect(errors).toEqual([]);
  for (const name of VIEWS) for (const time of Object.keys(TIMES)) expect(medians[name][time], `${name} at ${time}`).toBeLessThanOrEqual(BUDGET_MS);
});

test('a thousand lights at night, 256 of them moving, render within the GPU budget from the overview and in no man\'s land', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await openGame(page);
  await hooks(page, (h) => h.setQuality({ preset: 'high', dynres: false }));
  await useManyLights(page);
  await hooks(page, (h) => h.runLights());
  const medians: Record<string, number> = {};
  for (const name of ['overview', 'nml-night']) {
    await hooks(page, (h, n) => {
      h.view(n as string);
      h.setTimeOfDay(21);
    }, name);
    await hooks(page, (h, n) => h.waitFrames(n as number), SETTLE);
    const times = await hooks(
      page,
      async (h, n) => {
        const out: number[] = [];
        for (let i = 0; i < (n as number); i++) {
          await h.waitFrames(1);
          const s = h.stats();
          if (s.gpuMs !== null) out.push(s.gpuMs);
        }
        return out;
      },
      SAMPLES,
    );
    test.skip(times.length === 0, 'no timestamp queries on this GPU');
    times.sort((a, b) => a - b);
    medians[name] = times[times.length >> 1];
  }
  console.log(`GPU ms under a thousand lights at night, median of ${SAMPLES} frames: ${Object.entries(medians).map(([v, ms]) => `${v} ${ms.toFixed(2)}`).join(', ')}`);
  expect(errors).toEqual([]);
  for (const [name, ms] of Object.entries(medians)) expect(ms, name).toBeLessThanOrEqual(BUDGET_MS);
});
