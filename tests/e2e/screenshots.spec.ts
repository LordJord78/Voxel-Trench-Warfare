import { test } from '@playwright/test';
import { hooks, openGame } from './support/app';

// The six standard views at dusk and at night, for review by eye: grain, seams,
// the horizon, and the look against the probe frames. Written to artifacts/m4
// (git-ignored); the test fails only on errors.
test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });

const VIEWS = ['bay', 'step', 'nml-night', 'overview', 'dugout', 'hamlet'];

test('the standard views, at dusk and at night', async ({ page }) => {
  const errors = await openGame(page);
  await hooks(page, (h) => h.setQuality({ preset: 'high', dynres: false }));
  for (const name of VIEWS) {
    for (const [label, time] of [['dusk', 0], ['night', 1]] as const) {
      await hooks(page, (h, a) => {
        const [n, t] = a as [string, number];
        h.view(n);
        h.setTimeOfDay(t);
      }, [name, time]);
      // Long enough for the lighting history and TAA to settle.
      await hooks(page, (h) => h.waitFrames(120));
      await page.screenshot({ path: `artifacts/m4/${name}-${label}.png` });
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
});
