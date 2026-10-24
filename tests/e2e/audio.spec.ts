import { expect, test } from '@playwright/test';
import { P } from '../../src/world/materials';
import { hooks, openGame } from './support/app';

// Sound starts with the click that starts play (no context before: the browser would refuse it),
// a shot is heard, and the pause menu silences the game.

test('sound starts with the click that starts play, and a shot is heard', async ({ page }) => {
  const errors = await openGame(page);
  expect((await hooks(page, (h) => h.audio())).state).toBe('none');
  await page.locator('#play').click();
  await hooks(page, (h) => h.waitFrames(10));
  const started = await hooks(page, (h) => h.audio());
  expect(started.state).toBe('running');
  await hooks(page, async (h) => {
    h.trigger(true);
    await h.waitFrames(3);
    h.trigger(false);
    await h.waitFrames(3);
  });
  const after = await hooks(page, (h) => h.audio());
  expect(after.voices).toBeGreaterThan(started.voices);
  expect(errors).toEqual([]);
});

test('a browser that refuses sound still starts play, takes the pointer and resumes, silent', async ({ page }) => {
  // The review's case: a context that throws threw out of the click that starts play, before the
  // pointer was locked.
  await page.addInitScript(() => {
    const refuse = function () {
      throw new DOMException('sound refused', 'NotSupportedError');
    };
    Object.defineProperty(window, 'AudioContext', { value: refuse, configurable: true, writable: true });
  });
  const errors = await openGame(page);
  await page.locator('#play').click();
  await page.waitForFunction(() => document.pointerLockElement !== null, null, { timeout: 5000 });
  expect(await hooks(page, (h) => h.mode())).toBe('playing');
  await hooks(page, async (h) => {
    h.trigger(true);
    await h.waitFrames(3);
    h.trigger(false);
    await h.waitFrames(3);
  });
  expect(await hooks(page, (h) => h.audio())).toEqual({ state: 'none', voices: 0, kinds: {} });
  await page.keyboard.press('Escape');
  await expect(page.locator('#pause')).toBeVisible();
  await page.locator('#resume').click();
  await page.waitForFunction(() => document.pointerLockElement !== null, null, { timeout: 5000 });
  expect(await hooks(page, (h) => h.mode())).toBe('playing');
  expect(errors).toEqual([]);
});

test('paused, the sound is suspended, and comes back on resuming', async ({ page }) => {
  const errors = await openGame(page);
  await page.locator('#play').click();
  await hooks(page, (h) => h.waitFrames(10));
  await page.keyboard.press('Escape');
  await hooks(page, (h) => h.waitFrames(10));
  expect((await hooks(page, (h) => h.audio())).state).toBe('suspended');
  await page.locator('#resume').click();
  await hooks(page, (h) => h.waitFrames(10));
  expect((await hooks(page, (h) => h.audio())).state).toBe('running');
  expect(errors).toEqual([]);
});

test('shells are heard: their whistles, then their blasts', async ({ page }) => {
  const errors = await openGame(page);
  await page.locator('#play').click();
  await hooks(page, (h) => h.waitFrames(10));
  const before = (await hooks(page, (h) => h.audio())).voices;
  // Shelling alone, heavy: about a shell a second, each a whistle and 1.5 s on a blast.
  await hooks(page, async (h) => {
    h.setShelling('heavy');
    await new Promise((resolve) => setTimeout(resolve, 3500));
    h.setShelling('off');
  });
  const after = (await hooks(page, (h) => h.audio())).voices;
  expect(after - before).toBeGreaterThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('digging is heard: a scrape a scoop', async ({ page }) => {
  const errors = await openGame(page);
  await page.locator('#play').click();
  await hooks(page, (h) => {
    h.setIntensity('off');
    h.setShelling('off');
    const p = h.world.spawn.position;
    h.teleport({ position: [p[0], p[1], p[2]], yaw: h.views.bay.yaw, pitch: 0 });
  });
  await hooks(page, (h) => h.waitFrames(30));
  // A heap of spoil a metre ahead of the feet, and F held for a second and a half: five or six scoops.
  await hooks(page, (h, spoil) => {
    const p = h.session.player.position;
    const yaw = (h.session.player.yaw * Math.PI) / 180;
    const [cx, cz] = [(p.x + Math.sin(yaw) * 1.0) / 0.1, (p.z + Math.cos(yaw) * 1.0) / 0.1];
    const y = Math.round(p.y / 0.1);
    h.world.map.fillBox(Math.floor(cx - 3), y, Math.floor(cz - 3), Math.floor(cx + 3), y + 4, Math.floor(cz + 3), spoil as number);
  }, P.SPOIL);
  const before = await hooks(page, (h) => ({ voices: h.audio().voices, cleared: h.session.entrenching.cleared }));
  await page.keyboard.down('KeyF');
  await hooks(page, (h) => h.waitFrames(90));
  await page.keyboard.up('KeyF');
  const after = await hooks(page, (h) => ({ voices: h.audio().voices, cleared: h.session.entrenching.cleared }));
  const scoops = (after.cleared - before.cleared) / 24;
  expect(scoops).toBeGreaterThanOrEqual(3);
  expect(after.voices - before.voices).toBeGreaterThanOrEqual(Math.floor(scoops));
  expect(errors).toEqual([]);
});

test('flares are heard when they are fired', async ({ page }) => {
  const errors = await openGame(page);
  await page.locator('#play').click();
  await hooks(page, (h) => h.waitFrames(10));
  const before = await hooks(page, (h) => ({ flares: h.audio().kinds.flare ?? 0, state: h.audio().state }));
  expect(before.state).toBe('running');
  // At night, the front heavy, the battle running from its start: two flares or more fired in 12 s,
  // each heard (by the flares' own voices: the front's fire is heard too).
  const fired = await hooks(page, async (h) => {
    h.setTimeOfDay(21);
    h.setIntensity('heavy');
    h.runLights(0);
    const seen = new Set<number>();
    for (let k = 0; k < 24; k++) {
      await h.waitFrames(30);
      for (const f of h.battle().flares) seen.add(f.id);
    }
    return seen.size;
  });
  const after = (await hooks(page, (h) => h.audio())).kinds.flare ?? 0;
  expect(fired).toBeGreaterThanOrEqual(2);
  expect(after - before.flares).toBeGreaterThanOrEqual(fired);
  expect(errors).toEqual([]);
});

test('distant artillery is heard: a barrage beyond the map rumbles, a far shell thumps', async ({ page }) => {
  const errors = await openGame(page);
  await page.locator('#play').click();
  await hooks(page, (h) => h.waitFrames(10));
  // The front heavy, the battle two minutes in: barrages in progress and a far shell every few seconds.
  const heard = await hooks(page, async (h) => {
    h.setIntensity('heavy');
    h.runLights(120);
    const before = { ...h.audio().kinds };
    for (let k = 0; k < 40; k++) await h.waitFrames(60);
    const after = h.audio().kinds;
    return { rumble: (after.rumble ?? 0) - (before.rumble ?? 0), thump: (after.thump ?? 0) - (before.thump ?? 0), state: h.audio().state };
  });
  expect(heard.state).toBe('running');
  expect(heard.rumble).toBeGreaterThan(0);
  expect(heard.thump).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
