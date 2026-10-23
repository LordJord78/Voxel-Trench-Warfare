import { expect, test } from '@playwright/test';
import { hooks, openGame } from './support/app';

// Peak combat (the combat spec's done table, row 6) as one driver: the player plays a standing view,
// or the camera spectates one (the overview) while the session runs; a magazine on full auto, a shell
// a second 20–50 m off and the front's heavy fire; and everything calm again after.
test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const DUSK = 17 + 35 / 60;

test("spectating runs the session under a held camera: the player's rounds fly, the camera stays, the HUD and rifle stay hidden", async ({ page }) => {
  const errors = await openGame(page);
  await page.locator('#play').click();
  await expect(page.locator('#loading')).toBeHidden();
  const before = await hooks(page, (h) => h.session.weapon.rounds);
  const r = await hooks(page, async (h) => {
    const v = h.views.overview;
    h.spectate({ position: v.position, yaw: v.yaw, pitch: v.pitch });
    h.trigger(true);
    await h.waitFrames(40);
    h.trigger(false);
    await h.waitFrames(10);
    return { rounds: h.session.weapon.rounds, camera: h.camera(), mode: h.mode(), hud: h.hud(), rifle: h.rifleVisible(), view: v };
  });
  expect(r.rounds).toBeLessThan(before);
  expect(r.mode).toBe('fly');
  expect(r.camera.position).toEqual(r.view.position);
  expect(r.hud.visible).toBe(false);
  expect(r.rifle).toBe(false);
  await hooks(page, (h) => h.spectate(null));
  await hooks(page, (h) => h.waitFrames(5));
  expect(await hooks(page, (h) => h.mode())).toBe('playing');
  expect(await hooks(page, (h) => h.rifleVisible())).toBe(true);
  expect(errors).toEqual([]);
});

test('a view under fire: shots, shells and incoming every second, and calm again after', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await openGame(page);
  await page.locator('#play').click();
  await expect(page.locator('#loading')).toBeHidden();
  for (const view of ['bay', 'overview'] as const) {
    const r = await hooks(page, (h, a) => h.underFire((a as { view: string }).view, (a as { hours: number }).hours, 4), { view, hours: DUSK });
    const seen = JSON.stringify(r);
    expect(r.view, seen).toBe(view);
    expect(r.shots, seen).toBeGreaterThan(30);
    expect(r.shells, seen).toBeGreaterThanOrEqual(4);
    expect(r.frames, seen).toBeGreaterThan(100);
    expect(r.gpu!.p95, seen).toBeGreaterThan(0);
    expect(r.main.p99, seen).toBeGreaterThan(0);
    const after = await hooks(page, (h) => ({ fire: h.session.intent.fire, front: h.session.front.intensity, pending: h.session.destruction.pending, mode: h.mode() }));
    expect(after, seen).toEqual({ fire: false, front: 'off', pending: 0, mode: 'playing' });
  }
  expect(errors).toEqual([]);
});
