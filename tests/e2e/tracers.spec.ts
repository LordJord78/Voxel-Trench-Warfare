import { expect, test } from '@playwright/test';
import { hooks, openGame } from './support/app';

// The tracers across the sky (the battle spec's §4): at night with the lights running, the machine
// guns' tracers stream over no man's land and the field, drawn as the effects pass's ribbons; at rest,
// as every approved view is measured, none.
test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });

test('at night with the lights running, tracers stream over the field: 20 or more drawn at light', async ({ page }) => {
  const errors = await openGame(page);
  const drawn = await hooks(page, async (h) => {
    h.view('nml-night');
    h.setTimeOfDay(21);
    h.setIntensity('light');
    h.runLights(120);
    await h.waitFrames(30);
    let sum = 0;
    let most = 0;
    for (let k = 0; k < 60; k++) {
      await h.waitFrames(5);
      sum += h.effects().battleTracers;
      most = Math.max(most, h.battle().tracers.length);
    }
    return { mean: sum / 60, most };
  });
  expect(drawn.mean, JSON.stringify(drawn)).toBeGreaterThanOrEqual(20);
  expect(errors).toEqual([]);
});

test('at rest none is drawn', async ({ page }) => {
  const errors = await openGame(page);
  const drawn = await hooks(page, async (h) => {
    h.view('nml-night');
    h.setTimeOfDay(21);
    h.setIntensity('light');
    await h.waitFrames(60);
    return h.effects().battleTracers;
  });
  expect(drawn).toBe(0);
  expect(errors).toEqual([]);
});
