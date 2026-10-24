import { expect, test } from '@playwright/test';
import { hooks, openGame } from './support/app';

// The battle's flares (the battle spec's §2): at night, with the lights running, the director fires
// them from both lines; each climbs, bursts, drifts and sinks, lighting the field, the nearest
// holding the shadow maps. Paused, the battle waits; at rest, the six planned flares hang as before.
test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });

test('at night with the lights running, flares climb, burst, drift and sink, and light the field', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await openGame(page);
  const seen = await hooks(page, async (h) => {
    h.view('nml-night');
    h.setTimeOfDay(21);
    h.setIntensity('heavy');
    h.runLights();
    // Each flare by its id: its height at each look, and whether it was climbing or burning.
    const track = new Map<number, { y: number; stage: string }[]>();
    let lit = 0;
    for (let k = 0; k < 40; k++) {
      await h.waitFrames(30);
      for (const f of h.battle().flares) {
        const t = track.get(f.id) ?? [];
        t.push({ y: f.position[1], stage: f.stage });
        track.set(f.id, t);
      }
      lit = Math.max(lit, h.lights().filter((l) => l.kind === 'flare' && l.intensity > 0).length);
    }
    return { track: [...track.entries()], lit, seconds: h.battle().seconds };
  });
  expect(seen.seconds).toBeGreaterThan(15);
  expect(seen.track.length).toBeGreaterThanOrEqual(3);
  // One seen both climbing and burning: up while it climbs, down (sinking) after it bursts.
  const both = seen.track.find(([, t]) => t.some((s) => s.stage === 'climb') && t.filter((s) => s.stage === 'burning').length >= 2);
  expect(both, JSON.stringify(seen.track.slice(0, 4))).toBeDefined();
  const climb = both![1].filter((s) => s.stage === 'climb');
  const burn = both![1].filter((s) => s.stage === 'burning');
  expect(Math.max(...burn.map((s) => s.y))).toBeGreaterThan(Math.min(...climb.map((s) => s.y)));
  expect(burn[burn.length - 1].y).toBeLessThan(burn[0].y);
  expect(seen.lit).toBeGreaterThanOrEqual(3);
  expect(errors).toEqual([]);
});

test('paused, the battle waits', async ({ page }) => {
  const errors = await openGame(page);
  await page.locator('#play').click();
  await hooks(page, async (h) => {
    h.setTimeOfDay(21);
    h.setIntensity('heavy');
    h.runLights();
    await h.waitFrames(60);
  });
  await page.keyboard.press('Escape');
  expect(await hooks(page, (h) => h.mode())).toBe('paused');
  const [a, b] = await hooks(page, async (h) => {
    await h.waitFrames(2);
    const first = h.battle();
    await h.waitFrames(30);
    return [first, h.battle()];
  });
  expect(b).toEqual(a);
  expect(errors).toEqual([]);
});

test('at rest, the six planned flares hang as before', async ({ page }) => {
  const errors = await openGame(page);
  const flares = await hooks(page, async (h) => {
    h.setTimeOfDay(21);
    h.setIntensity('heavy');
    await h.waitFrames(60);
    return h.lights().filter((l) => l.kind === 'flare');
  });
  expect(flares).toHaveLength(6);
  for (const f of flares) {
    expect(f.id).toBeUndefined();
    expect(f.intensity).toBe(260);
  }
  expect(errors).toEqual([]);
});

test('the battle run from a moment is sought at the time of day just set, not the one drawn last', async ({ page }) => {
  // openGame leaves the game at dusk, when no flare is fired; set to night and run from two minutes
  // in, in the same breath, the battle is two minutes of a heavy night: about fifteen alight.
  const errors = await openGame(page);
  const alight = await hooks(page, async (h) => {
    h.view('nml-night');
    h.setTimeOfDay(21);
    h.setIntensity('heavy');
    h.runLights(120);
    await h.waitFrames(2);
    return h.battle().flares.filter((f) => f.stage === 'burning').length;
  });
  expect(alight).toBeGreaterThanOrEqual(8);
  expect(errors).toEqual([]);
});
