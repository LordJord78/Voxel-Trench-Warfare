import { expect, test } from '@playwright/test';
import { hooks, openGame } from './support/app';

// 1600 × 1000 CSS pixels at a device scale of 1: a 1.6 MP canvas, so the
// internal image is the high preset's 1.5 MP.
test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });

const VIEWS = ['bay', 'step', 'nml-night', 'overview', 'dugout', 'hamlet'];
const TIMES: Record<string, number> = { dusk: 0, night: 1 };
const BUDGET_MS = 14;
// Frames for the histories and the GPU's clocks to settle at a view, then frames whose GPU times
// are read: one frame's time wanders by a millisecond or two, their median does not.
const SETTLE = 90;
const SAMPLES = 31;

test('every standard view renders within the GPU budget at 1.5 MP, at dusk and at night', async ({ page }) => {
  test.setTimeout(240_000);
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
  console.log(`GPU ms per view, median of ${SAMPLES} frames (dusk/night): ${VIEWS.map((v) => `${v} ${medians[v].dusk.toFixed(2)}/${medians[v].night.toFixed(2)}`).join(', ')}`);
  expect(errors).toEqual([]);
  for (const name of VIEWS) for (const time of Object.keys(TIMES)) expect(medians[name][time], `${name} at ${time}`).toBeLessThanOrEqual(BUDGET_MS);
});
