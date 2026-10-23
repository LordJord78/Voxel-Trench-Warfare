import type { Page } from '@playwright/test';
import { hooks } from './app';

/** Where the player digs a shelled bay from, and the fixed vantage over them (metres, degrees). */
export interface ShelledBay {
  stand: [number, number, number];
  vantage: [number, number, number];
  yaw: number;
  /** The bay's long axis: 0 x, 2 z. */
  axis: 0 | 2;
}

/**
 * Combat milestone 5's bay: a 3 m shell on the parapet's crest across from the spawn (the highest
 * ground within 4 m toward the enemy) slumps it into the bay; once its crater is in, the player
 * stands on the floor 2.5 m along the bay from it, facing back along the bay at the slump. The
 * vantage is a metre further back and 3.5 m up. The front and its shells are quiet.
 */
export async function shellTheBay(page: Page): Promise<ShelledBay> {
  const plan = await hooks(page, (h) => {
    h.setIntensity('off');
    h.setShelling('off');
    const { position: p, bay } = h.world.spawn;
    const across = bay.longAxis === 0 ? 2 : 0;
    let crest: [number, number, number] = [p[0], -1, p[2]];
    for (let d = 0; d <= 4; d += 0.1) {
      const at: [number, number, number] = [p[0], 0, p[2]];
      at[across] += bay.facing * d;
      let y = 319;
      while (y >= 0 && h.world.map.get(Math.floor(at[0] / 0.1), y, Math.floor(at[2] / 0.1)) === 0) y--;
      if ((y + 1) * 0.1 > crest[1]) crest = [at[0], (y + 1) * 0.1, at[2]];
    }
    const stand: [number, number, number] = [p[0], p[1], p[2]];
    stand[bay.longAxis] -= 2.5;
    const vantage: [number, number, number] = [stand[0], stand[1] + 3.5, stand[2]];
    vantage[bay.longAxis] -= 1.0;
    return { crest, stand, vantage, yaw: bay.longAxis === 0 ? 90 : 0, axis: bay.longAxis };
  });
  await hooks(page, async (h, crest) => {
    await h.shell(crest as [number, number, number], 3);
    await h.waitFrames(60);
  }, plan.crest);
  await hooks(page, async (h, a) => {
    const { stand, yaw } = a as ShelledBay;
    h.teleport({ position: stand, yaw, pitch: -12 });
    await h.waitFrames(30);
  }, plan);
  return { stand: plan.stand, vantage: plan.vantage, yaw: plan.yaw, axis: plan.axis };
}

/**
 * F held for `seconds` as a person digs: every quarter second, a short step forward if nothing is in
 * reach, never more than `maxStep` metres along the bay from where they began; `each` runs at every
 * quarter (its index), before the step.
 */
export async function digAlong(page: Page, bay: ShelledBay, seconds: number, maxStep = 2.5, each?: (k: number) => Promise<void>): Promise<void> {
  const along = (p: { x: number; z: number }) => (bay.axis === 0 ? p.x : p.z);
  const start = along(await hooks(page, (h) => h.session.player.position));
  await page.keyboard.down('KeyF');
  for (let k = 0; k < seconds * 4; k++) {
    await hooks(page, (h) => h.waitFrames(15));
    await each?.(k);
    const now = await hooks(page, (h) => ({ inReach: h.session.entrenching.inReach, at: h.session.player.position }));
    if (!now.inReach && Math.abs(along(now.at) - start) < maxStep) {
      await page.keyboard.down('KeyW');
      await hooks(page, (h) => h.waitFrames(5));
      await page.keyboard.up('KeyW');
    }
  }
  await page.keyboard.up('KeyF');
}
