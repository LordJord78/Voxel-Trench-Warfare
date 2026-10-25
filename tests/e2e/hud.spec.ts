import { expect, test, type Page } from '@playwright/test';
import { isLoose, P } from '../../src/world/materials';
import { hooks, openGame } from './support/app';

// The HUD (the spec's §5, "The HUD"): DOM over the canvas in the page's type and colours — the
// stance, how exposed, the rounds or "Reloading", the digging, and a four-tick crosshair — shown
// only in play: not on the loading screen, paused or flying, and no crosshair through the periscope.
const FIRING_STEP = 3;
const PERISCOPE = 4;
const LOOSE = Array.from({ length: 256 }, (_, p) => p).filter(isLoose);

/** Load the game and click through the prompt, the front quiet; the console errors so far. */
async function playing(page: Page): Promise<string[]> {
  const errors = await openGame(page);
  await page.locator('#play').click();
  await expect(page.locator('#loading')).toBeHidden();
  await hooks(page, (h) => {
    h.setIntensity('off');
    h.setShelling('off');
  });
  return errors;
}

/** The HUD after `frames` frames: it is redrawn ten times a second. */
async function hudAfter(page: Page, frames = 15) {
  await hooks(page, (h, n) => h.waitFrames(n as number), frames);
  return hooks(page, (h) => h.hud());
}

/** Stand at the spawn facing along the bay; the feet, metres. */
async function standAtSpawn(page: Page): Promise<void> {
  await hooks(page, (h) => {
    const p = h.world.spawn.position;
    h.teleport({ position: [p[0], p[1], p[2]], yaw: h.views.bay.yaw, pitch: 0 });
  });
  await hooks(page, (h) => h.waitFrames(30));
}

test('in play the HUD shows the rounds, the stance and a crosshair; R shows reloading; C, crouched', async ({ page }) => {
  const errors = await playing(page);
  await standAtSpawn(page);
  let hud = await hudAfter(page);
  expect(hud.visible).toBe(true);
  expect(hud.crosshair).toBe(true);
  expect(hud.text).toContain('Standing');
  expect(hud.text).toContain('Exposure');
  expect(hud.text).toContain('30 / 30');
  await expect(page.locator('#hud .crosshair i').first()).toBeVisible();
  // A short burst, so there is a reload to make.
  await hooks(page, (h) => h.trigger(true));
  await hooks(page, (h) => h.waitFrames(12));
  await hooks(page, (h) => h.trigger(false));
  const rounds = await hooks(page, (h) => h.session.weapon.rounds);
  expect(rounds).toBeLessThan(30);
  expect((await hudAfter(page)).text).toContain(`${rounds} / 30`);
  await page.keyboard.press('KeyR');
  hud = await hudAfter(page);
  expect(hud.text).toContain('Reloading');
  expect(hud.text).not.toContain(' / 30');
  await page.keyboard.press('KeyC');
  expect((await hudAfter(page, 30)).text).toContain('Crouched');
  expect(errors).toEqual([]);
});

test('holding F by spoil shows digging and its bar; by none, nothing to clear', async ({ page }) => {
  const errors = await playing(page);
  await standAtSpawn(page);
  // Nothing loose within 2.5 m of the feet: F held says so.
  await hooks(page, (h, loose) => {
    const ids = new Set(loose as number[]);
    const p = h.session.player.position;
    const [fx, fy, fz] = [p.x / 0.1, p.y / 0.1, p.z / 0.1];
    for (let z = Math.floor(fz - 25); z <= fz + 25; z++) {
      for (let y = Math.floor(fy - 3); y <= fy + 25; y++) {
        for (let x = Math.floor(fx - 25); x <= fx + 25; x++) if (ids.has(h.world.map.get(x, y, z))) h.world.map.set(x, y, z, 0);
      }
    }
  }, LOOSE);
  await page.keyboard.down('KeyF');
  let hud = await hudAfter(page);
  expect(hud.text).toContain('Nothing to clear');
  expect(await hooks(page, (h) => h.session.digging)).toBe(true);
  // A heap of spoil 0.8 m ahead of the feet: digging, its bar filling toward each scoop.
  await hooks(page, (h, spoil) => {
    const p = h.session.player.position;
    const yaw = (h.session.player.yaw * Math.PI) / 180;
    const [cx, cz] = [(p.x + Math.sin(yaw) * 1.0) / 0.1, (p.z + Math.cos(yaw) * 1.0) / 0.1];
    const y = Math.round(p.y / 0.1);
    h.world.map.fillBox(Math.floor(cx - 3), y, Math.floor(cz - 3), Math.floor(cx + 3), y + 4, Math.floor(cz + 3), spoil as number);
  }, P.SPOIL);
  hud = await hudAfter(page);
  expect(hud.text).toContain('Digging');
  expect(hud.text).not.toContain('Nothing to clear');
  await expect(page.locator('#hud .dig .bar i')).toHaveCount(8);
  // Over a second the bar shows some of the way to a scoop, and scoops are made.
  const filled = new Set<number>();
  for (let k = 0; k < 10; k++) {
    await hooks(page, (h) => h.waitFrames(6));
    filled.add(await page.locator('#hud .dig .bar i.on').count());
  }
  expect(Math.max(...filled)).toBeGreaterThan(0);
  expect(await hooks(page, (h) => h.session.entrenching.cleared)).toBeGreaterThan(0);
  await page.keyboard.up('KeyF');
  hud = await hudAfter(page);
  expect(hud.text).not.toContain('Digging');
  expect(errors).toEqual([]);
});

test('the HUD is hidden on the loading screen, paused and flying, and the crosshair through the periscope', async ({ page }) => {
  const errors = await openGame(page);
  expect((await hooks(page, (h) => h.hud())).visible).toBe(false);
  await expect(page.locator('#hud')).toBeHidden();
  await page.locator('#play').click();
  await expect(page.locator('#loading')).toBeHidden();
  expect(await hudAfter(page, 5)).toMatchObject({ visible: true, crosshair: true });
  await expect(page.locator('#hud')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('#pause')).toBeVisible();
  expect((await hudAfter(page, 5)).visible).toBe(false);
  await expect(page.locator('#hud')).toBeHidden();
  await page.locator('#resume').click();
  expect((await hudAfter(page, 5)).visible).toBe(true);

  await hooks(page, (h) => h.view('bay'));
  expect((await hudAfter(page, 5)).visible).toBe(false);
  await expect(page.locator('#hud')).toBeHidden();
  await hooks(page, (h) => h.walk());
  expect((await hudAfter(page, 5)).visible).toBe(true);

  // Up the firing step, and the periscope raised: the HUD stays, its crosshair goes.
  await hooks(page, (h) => {
    const v = h.views.step;
    h.teleport({ position: [v.position[0], v.position[1] - 1.62, v.position[2]], yaw: v.yaw, pitch: 0 });
  });
  await page.waitForFunction((s) => (window as unknown as { __trenchline: { player(): { stance: number } } }).__trenchline.player().stance === s, FIRING_STEP);
  await page.keyboard.press('KeyQ');
  await page.waitForFunction((s) => (window as unknown as { __trenchline: { player(): { stance: number } } }).__trenchline.player().stance === s, PERISCOPE);
  const hud = await hudAfter(page);
  expect(hud).toMatchObject({ visible: true, crosshair: false });
  expect(hud.text).toContain('Periscope up');
  await expect(page.locator('#hud .crosshair i').first()).toBeHidden();
  expect(errors).toEqual([]);
});

test('the HUD goes when the game stops: not over the failure screen', async ({ page }) => {
  // The review's case: the GPU lost mid-play, the failure sheet came up with the crosshair and the
  // stance still drawn over it.
  await playing(page);
  expect((await hudAfter(page, 5)).visible).toBe(true);
  await hooks(page, (h) => h.loseDevice());
  await expect(page.locator('#loading.failed')).toBeVisible();
  await expect(page.locator('#hud')).toBeHidden();
  await expect(page.locator('#hud .crosshair i').first()).toBeHidden();
});

test('the periscope goes when the game stops: its frame not over the failure screen', async ({ page }) => {
  // C5's review's case, left for the showcase: the GPU lost with the periscope up, its dark frame
  // stayed round the failure's message.
  await playing(page);
  await hooks(page, (h) => {
    const v = h.views.step;
    h.teleport({ position: [v.position[0], v.position[1] - 1.62, v.position[2]], yaw: v.yaw, pitch: 0 });
  });
  await page.waitForFunction((s) => (window as unknown as { __trenchline: { player(): { stance: number } } }).__trenchline.player().stance === s, FIRING_STEP);
  await page.keyboard.press('KeyQ');
  await expect(page.locator('#periscope')).toBeVisible();
  await hooks(page, (h) => h.loseDevice());
  await expect(page.locator('#loading.failed')).toBeVisible();
  await expect(page.locator('#periscope')).toBeHidden();
});
