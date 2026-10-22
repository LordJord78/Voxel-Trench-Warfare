import { expect, test, type Page } from '@playwright/test';
import { hooks, openGame } from './support/app';

const STANDING = 0;
const FIRING_STEP = 3;
const PERISCOPE = 4;

/** Load the game and click through the prompt; the console errors so far. */
async function playing(page: Page): Promise<string[]> {
  const errors = await openGame(page);
  await page.locator('#play').click();
  await expect(page.locator('#loading')).toBeHidden();
  return errors;
}

/** Wait (by frames, at most `frames`) until `check` holds of the player. */
async function until(page: Page, frames: number, check: string): Promise<void> {
  await page.waitForFunction(
    ([n, source]) => {
      const h = (window as unknown as { __trenchline: { frames(): number; player(): unknown; camera(): unknown; start?: number } }).__trenchline;
      return new Function('p', 'c', `return ${source}`)(h.player(), h.camera()) as boolean;
    },
    [frames, check] as const,
    { timeout: Math.max(2000, frames * 50) },
  );
}

async function standAtSpawn(page: Page): Promise<[number, number, number]> {
  const spawn = await hooks(page, (h) => {
    const p = h.world.spawn.position;
    h.teleport({ position: [p[0], p[1], p[2]], yaw: h.views.bay.yaw, pitch: 0 });
    return [p[0], p[1], p[2]] as [number, number, number];
  });
  await hooks(page, (h) => h.waitFrames(20));
  return spawn;
}

test('the prompt comes after every phase shows', async ({ page }) => {
  await openGame(page);
  const { promptMs, phases } = await hooks(page, (h) => ({ promptMs: h.promptMs, phases: h.phases }));
  expect(phases).toEqual(['Starting', 'Digging the trenches', "Shelling no man's land", 'Sending the world to the GPU', 'Ready']);
  // The spec's 4 s is the production build's, gated by `node tools/preview-gen.mjs --prod`. This dev
  // server serves unbundled modules and runs about a quarter of a second slower; it only has to be sane.
  expect(promptMs).toBeLessThanOrEqual(6000);
});

test('walking along the bay keeps to the floor', async ({ page }) => {
  const errors = await playing(page);
  const spawn = await standAtSpawn(page);
  const before = await hooks(page, (h) => h.player());
  await page.keyboard.down('KeyW');
  await hooks(page, (h) => h.waitFrames(60));
  await page.keyboard.up('KeyW');
  await hooks(page, (h) => h.waitFrames(10));
  const after = await hooks(page, (h) => h.player());
  expect(Math.hypot(after.position[0] - before.position[0], after.position[2] - before.position[2])).toBeGreaterThan(1.5);
  expect(after.onGround).toBe(true);
  expect(Math.abs(after.position[1] - spawn[1])).toBeLessThan(0.6);
  expect(errors).toEqual([]);
});

test('the firing step raises you, and Q the periscope', async ({ page }) => {
  const errors = await playing(page);
  await hooks(page, (h) => {
    const v = h.views.step;
    h.teleport({ position: [v.position[0], v.position[1] - 1.62, v.position[2]], yaw: v.yaw, pitch: 0 });
  });
  await until(page, 30, `p.stance === ${FIRING_STEP}`);
  await page.keyboard.press('KeyQ');
  await until(page, 60, `p.stance === ${PERISCOPE} && c.fov < 40`);
  await expect(page.locator('#periscope')).toBeVisible();
  await page.keyboard.press('KeyQ');
  await until(page, 30, `p.stance === ${FIRING_STEP}`);
  // Raised again and carried off the step, the periscope comes down, and stays down back on it.
  await page.keyboard.press('KeyQ');
  await until(page, 60, `p.stance === ${PERISCOPE}`);
  await standAtSpawn(page);
  await hooks(page, (h) => {
    const v = h.views.step;
    h.teleport({ position: [v.position[0], v.position[1] - 1.62, v.position[2]], yaw: v.yaw, pitch: 0 });
  });
  await until(page, 30, `p.stance === ${FIRING_STEP}`);
  await hooks(page, (h) => h.waitFrames(30));
  expect((await hooks(page, (h) => h.player())).stance).toBe(FIRING_STEP);
  expect(errors).toEqual([]);
});

test('crouch and prone', async ({ page }) => {
  const errors = await playing(page);
  await standAtSpawn(page);
  await page.keyboard.press('KeyC');
  await until(page, 30, 'Math.abs(p.height - 1.25) < 1e-6');
  await page.keyboard.press('KeyZ');
  await until(page, 60, 'Math.abs(p.height - 0.55) < 1e-6');
  await page.keyboard.press('KeyZ');
  await until(page, 60, `Math.abs(p.height - 1.8) < 1e-6 && p.stance === ${STANDING}`);
  expect(errors).toEqual([]);
});

test('Esc pauses, and the menu changes the game', async ({ page }) => {
  const errors = await playing(page);
  await standAtSpawn(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#pause')).toBeVisible();
  const before = await hooks(page, (h) => h.player().position);
  await page.keyboard.down('KeyW');
  await hooks(page, (h) => h.waitFrames(30));
  await page.keyboard.up('KeyW');
  expect(await hooks(page, (h) => h.player().position)).toEqual(before);

  await page.locator('#fov').fill('70');
  await hooks(page, (h) => h.waitFrames(2));
  expect(await hooks(page, (h) => h.camera().fov)).toBeCloseTo(70, 6);
  await page.locator('#time').fill('21');
  await hooks(page, (h) => h.waitFrames(2));
  expect(await hooks(page, (h) => h.timeOfDay())).toBe(21);
  await expect(page.locator('#time-value')).toHaveText('21:00');
  // Time passing, ten minutes a second: the clock runs on behind the menu.
  await page.locator('input[name="lapse"][value="10"]').check();
  await hooks(page, (h) => h.waitFrames(60));
  const later = await hooks(page, (h) => h.timeOfDay());
  expect(later).toBeGreaterThan(21.05);
  expect(later).toBeLessThan(21.6);
  await page.locator('input[name="lapse"][value="0"]').check();
  await hooks(page, (h) => h.waitFrames(2));
  const held = await hooks(page, (h) => h.timeOfDay());
  await hooks(page, (h) => h.waitFrames(30));
  expect(await hooks(page, (h) => h.timeOfDay())).toBe(held);
  await page.locator('input[name="preset"][value="low"]').check();
  await hooks(page, (h) => h.waitFrames(2));
  expect(await hooks(page, (h) => h.stats().preset)).toBe('low');

  await page.locator('#resume').click();
  await expect(page.locator('#pause')).toBeHidden();
  expect(await hooks(page, (h) => h.mode())).toBe('playing');
  expect(errors).toEqual([]);
});

/** Horizontal distance the player covers over `frames` frames. */
async function drift(page: Page, frames: number): Promise<number> {
  const a = await hooks(page, (h) => h.player().position);
  await hooks(page, (h, n) => h.waitFrames(n as number), frames);
  const b = await hooks(page, (h) => h.player().position);
  return Math.hypot(b[0] - a[0], b[2] - a[2]);
}

test('losing focus mid-stride stops the player, though W is never released', async ({ page }) => {
  const errors = await playing(page);
  await standAtSpawn(page);
  await page.keyboard.down('KeyW');
  await hooks(page, (h) => h.waitFrames(20));
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await hooks(page, (h) => h.waitFrames(40));
  expect(await drift(page, 20)).toBeLessThan(0.01);
  await page.keyboard.up('KeyW');
  expect(errors).toEqual([]);
});

test('Esc mid-stride pauses, and resuming does not walk on', async ({ page }) => {
  const errors = await playing(page);
  await standAtSpawn(page);
  await page.keyboard.down('KeyW');
  await hooks(page, (h) => h.waitFrames(20));
  await page.keyboard.press('Escape');
  await expect(page.locator('#pause')).toBeVisible();
  await page.locator('#resume').click();
  expect(await hooks(page, (h) => h.mode())).toBe('playing');
  await hooks(page, (h) => h.waitFrames(40));
  expect(await drift(page, 20)).toBeLessThan(0.01);
  await page.keyboard.up('KeyW');
  expect(errors).toEqual([]);
});

for (const how of ['rejects', 'throws'] as const) {
  test(`a pointer lock that ${how} leaves play, pause and resume working`, async ({ page }) => {
    await page.addInitScript((h) => {
      HTMLCanvasElement.prototype.requestPointerLock = function () {
        const refusal = new DOMException('The user has exited the lock before this request was completed.', 'SecurityError');
        if (h === 'throws') throw refusal;
        return Promise.reject(refusal);
      } as typeof HTMLCanvasElement.prototype.requestPointerLock;
    }, how);
    const errors = await playing(page);
    expect(await hooks(page, (h) => h.mode())).toBe('playing');
    await page.keyboard.press('Escape');
    await expect(page.locator('#pause')).toBeVisible();
    await page.locator('#resume').click();
    expect(await hooks(page, (h) => h.mode())).toBe('playing');
    expect(errors).toEqual([]);
  });
}

test('losing the pointer lock pauses', async ({ page }) => {
  const errors = await playing(page);
  await page.waitForFunction(() => document.pointerLockElement !== null, null, { timeout: 5000 });
  await page.evaluate(() => document.exitPointerLock());
  await expect(page.locator('#pause')).toBeVisible();
  expect(await hooks(page, (h) => h.mode())).toBe('paused');
  expect(errors).toEqual([]);
});

test('the developer keys work only with the F3 overlay open', async ({ page }) => {
  const errors = await playing(page);
  await page.keyboard.press('Digit4');
  await page.keyboard.press('KeyT');
  await hooks(page, (h) => h.waitFrames(3));
  expect(await hooks(page, (h) => [h.mode(), h.timeOfDay()])).toEqual(['playing', 17 + 35 / 60]);
  await page.keyboard.press('F3');
  await page.keyboard.press('Digit4');
  await hooks(page, (h) => h.waitFrames(3));
  expect(await hooks(page, (h) => h.mode())).toBe('fly');
  expect(errors).toEqual([]);
});
