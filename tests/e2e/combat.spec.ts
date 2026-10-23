import { expect, test } from '@playwright/test';
import { hooks, openGame, type Hooks } from './support/app';

// The rifle in the game: fired from the trench at its front wall, reloaded with R, and silent
// outside play. Spoil, rubble and air are what a mark leaves (destruction.chip).
const MARKS = [0, 11, 35];

/** Stand on the spawn bay's duckboards facing its front wall, the eye 10° down; the voxels in a box ahead of the feet. */
async function faceTheWall(page: import('@playwright/test').Page) {
  return hooks(page, (h: Hooks) => {
    const sp = h.world.spawn;
    const yaw = sp.bay.longAxis === 0 ? (sp.bay.facing > 0 ? 0 : 180) : sp.bay.facing > 0 ? 90 : -90;
    h.teleport({ position: sp.position, yaw, pitch: -10 });
  });
}

function boxAhead(page: import('@playwright/test').Page): Promise<number[]> {
  return hooks(page, (h: Hooks) => {
    const sp = h.world.spawn;
    const v = 0.1;
    const [fx, fz] = sp.bay.longAxis === 0 ? [0, sp.bay.facing] : [sp.bay.facing, 0];
    const x0 = Math.floor(sp.position[0] / v);
    const y0 = Math.floor(sp.position[1] / v);
    const z0 = Math.floor(sp.position[2] / v);
    const out: number[] = [];
    for (let a = 0; a <= 30; a++) {
      for (let b = -10; b <= 10; b++) {
        for (let y = 0; y < 25; y++) {
          const x = x0 + fx * a + (fx === 0 ? b : 0);
          const z = z0 + fz * a + (fz === 0 ? b : 0);
          out.push(h.world.map.get(x, y0 + y, z));
        }
      }
    }
    return out;
  });
}

test("holding the trigger at the bay's front wall marks it, and the GPU draws on", async ({ page }) => {
  const errors = await openGame(page);
  await hooks(page, (h) => h.play());
  await faceTheWall(page);
  await hooks(page, (h) => h.waitFrames(30));
  const before = await boxAhead(page);
  await hooks(page, (h) => h.trigger(true));
  await page.waitForTimeout(1000);
  await hooks(page, (h) => h.trigger(false));
  const fired = 30 - (await hooks(page, (h) => h.session.weapon.rounds));
  console.log(`one second on the trigger: ${fired} rounds`);
  expect(fired).toBeGreaterThanOrEqual(8);
  expect(fired).toBeLessThanOrEqual(14);
  const after = await boxAhead(page);
  const changed = after.flatMap((p, k) => (p !== before[k] ? [p] : []));
  expect(changed.length).toBeGreaterThan(0);
  for (const p of changed) expect(MARKS).toContain(p);
  await hooks(page, (h) => h.waitFrames(10));
  expect(errors).toEqual([]);
});

test('R reloads', async ({ page }) => {
  const errors = await openGame(page);
  await hooks(page, (h) => h.play());
  await faceTheWall(page);
  await hooks(page, (h) => h.trigger(true));
  await page.waitForTimeout(500);
  await hooks(page, (h) => h.trigger(false));
  expect(await hooks(page, (h) => h.session.weapon.rounds)).toBeLessThan(30);
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(2600);
  expect(await hooks(page, (h) => h.session.weapon.rounds)).toBe(30);
  expect(errors).toEqual([]);
});

test('the click that starts play, the pause menu and fly mode fire nothing', async ({ page }) => {
  const errors = await openGame(page);
  const rounds = () => hooks(page, (h) => h.session.weapon.rounds);
  await page.locator('#play').click();
  await page.waitForTimeout(300);
  expect(await rounds()).toBe(30);
  await page.keyboard.press('Escape');
  expect(await hooks(page, (h) => h.mode())).toBe('paused');
  await page.mouse.down();
  await hooks(page, (h) => h.trigger(true));
  await page.waitForTimeout(500);
  await hooks(page, (h) => h.trigger(false));
  await page.mouse.up();
  expect(await rounds()).toBe(30);
  await hooks(page, (h) => h.view('bay'));
  expect(await hooks(page, (h) => h.mode())).toBe('fly');
  await hooks(page, (h) => h.trigger(true));
  await page.waitForTimeout(500);
  await hooks(page, (h) => h.trigger(false));
  expect(await rounds()).toBe(30);
  expect(errors).toEqual([]);
});

test('a click, through the mouse with the pointer locked, fires one round', async ({ page }) => {
  const errors = await openGame(page);
  // Clicking the prompt takes the pointer lock, as a visitor's click does.
  await page.locator('#play').click();
  await faceTheWall(page);
  await hooks(page, (h) => h.waitFrames(10));
  await page.mouse.click(800, 500);
  await hooks(page, (h) => h.waitFrames(10));
  expect(await hooks(page, (h) => h.session.weapon.rounds)).toBe(29);
  expect(errors).toEqual([]);
});
