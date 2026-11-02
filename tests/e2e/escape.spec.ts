import { expect, test, type Page } from '@playwright/test';
import { hooks, openGame } from './support/app';

// Nobody is ever trapped in a trench (the multiplayer spec's M1), played with the keys, on both
// maps: from the spawn, W climbs onto the firing step and Space with it goes over the parapet;
// turned round, Space and W go over the parados from the duckboards.

type Bay = { longAxis: 0 | 2; facing: 1 | -1; crestY: number; floorY: number };

async function playing(page: Page, path: string): Promise<string[]> {
  const errors = await openGame(page, path);
  await page.locator('#play').click();
  await expect(page.locator('#loading')).toBeHidden();
  // The front's fire and shells are off: this is the controller's test, not suppression's.
  await page.keyboard.press('Escape');
  await page.locator('input[name="intensity"][value="off"]').check();
  await page.locator('#resume').click();
  return errors;
}

/** Stand at the spawn facing toward (1) or away from (-1) the firing step; the bay's heights in metres. */
async function atSpawn(page: Page, toward: 1 | -1): Promise<{ crest: number; duck: number }> {
  return hooks(page, async (h, arg) => {
    const bay = h.world.spawn.bay as unknown as Bay;
    const p = h.world.spawn.position;
    const ahead = bay.facing * (arg as 1 | -1);
    const yaw = bay.longAxis === 0 ? (ahead > 0 ? 0 : 180) : ahead > 0 ? 90 : -90;
    h.teleport({ position: [p[0], p[1], p[2]], yaw, pitch: 0 });
    await h.waitFrames(20);
    return { crest: bay.crestY * 0.1, duck: (bay.floorY + 1) * 0.1 };
  }, toward);
}

/** Hold `keys` for up to `seconds`, until `out` holds of the player's height and footing. */
async function holdUntil(page: Page, keys: string[], seconds: number, out: (y: number) => boolean): Promise<number> {
  for (const k of keys) await page.keyboard.down(k);
  const start = Date.now();
  let y = -1;
  while (Date.now() - start < seconds * 1000) {
    const p = await hooks(page, async (h) => {
      await h.waitFrames(2);
      return h.player();
    });
    y = p.position[1];
    if (p.onGround && out(y)) break;
  }
  for (const k of keys) await page.keyboard.up(k);
  return y;
}

for (const [map, path] of [['the Ravine', '/'], ['the Corridor', '/?map=corridor']] as const) {
  test(`on ${map}, from the spawn, W climbs onto the firing step and W with Space goes over the parapet`, async ({ page }) => {
    const errors = await playing(page, path);
    const { crest, duck } = await atSpawn(page, 1);
    const bench = await holdUntil(page, ['KeyW'], 4, (y) => y > duck + 1.0);
    expect(bench).toBeGreaterThan(duck + 1.0);
    // Standing on the bench makes the firing step on the next tick: a few frames on, it has.
    const stance = await hooks(page, async (h) => {
      await h.waitFrames(5);
      return h.player().stance;
    });
    expect(stance).toBe(3);
    // W alone never takes anyone over the top.
    const leaning = await holdUntil(page, ['KeyW'], 1.5, () => false);
    expect(leaning).toBeLessThan(crest - 0.5);
    const over = await holdUntil(page, ['KeyW', 'Space'], 4, (y) => y > crest - 0.05);
    expect(over).toBeGreaterThan(crest - 0.05);
    expect(errors).toEqual([]);
  });

  test(`on ${map}, from the duckboards, W with Space goes over the parados`, async ({ page }) => {
    const errors = await playing(page, path);
    const { duck } = await atSpawn(page, -1);
    const out = await holdUntil(page, ['KeyW', 'Space'], 4, (y) => y > duck + 2.2);
    expect(out).toBeGreaterThan(duck + 2.2);
    expect(errors).toEqual([]);
  });
}
