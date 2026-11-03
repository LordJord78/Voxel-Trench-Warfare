import { expect, test, type Page } from '@playwright/test';
import { encodeGear, type Gear } from '../../src/net/gear';
import { STATE } from '../../src/net/protocol';
import { hooks, openGame, type Hooks } from './support/app';

// The loadout in the browser: the menu chooses it; every gun with its fit, the pistol and the shovel
// are drawn where the CPU's trace of their models says (their models uploaded over the rifle's);
// aimed, the view closes in and the sight's reticle (or the scope's circle) shows; and the others
// are drawn with what they carry.

type Kit = Hooks & {
  setLoadout(l: unknown): void;
  loadout(): { primary: string; secondary: string; tracer: string; fits: Record<string, Record<string, string>> };
  aim(held: boolean): void;
  hands(): { held: number; ready: number; aimed: number; gun: string; light: boolean; model: [number, number, number] };
  rifleCheck(n: number): Promise<{ visible: boolean; samples: { px: [number, number]; gpu: number; cpu: number | null }[] }>;
  rifleVisible(): boolean;
  showRifle(on: boolean): void;
  puppets(list: unknown[]): void;
  soldiersDrawn(): unknown[];
};

const kit = <T>(page: Page, fn: (h: Kit, arg: unknown) => T | Promise<T>, arg?: unknown): Promise<T> => hooks(page, fn as unknown as (h: Hooks, arg: unknown) => T | Promise<T>, arg);

/** Each long gun with a full fit: every slot it takes filled. */
const FULL: Record<string, Record<string, string>> = {
  ak74: { optic: 'reddot', muzzle: 'suppressor', under: 'vertical', side: 'flashlight' },
  m4: { optic: 'holo', muzzle: 'compensator', under: 'angled', side: 'laser' },
  mp5: { optic: 'reddot', muzzle: 'suppressor', under: 'vertical', side: 'flashlight' },
  svd: { optic: 'scope', muzzle: 'suppressor', side: 'laser' },
  m249: { optic: 'scope', muzzle: 'compensator', under: 'vertical', side: 'flashlight' },
  m870: { optic: 'holo', side: 'flashlight' },
};

/** Playing in the bay, still, jitter off (so the pixels' rays are the CPU's), at a fixed resolution (so a pixel is the same pixel frame to frame). */
async function inTheBay(page: Page) {
  await kit(page, (h) => h.play());
  await kit(page, (h) => {
    const v = h.views.bay;
    h.teleport({ position: [v.position[0], v.position[1] - 1.62, v.position[2]], yaw: v.yaw, pitch: 0 });
    h.jitter(false);
    h.setQuality({ dynres: false });
  });
  await kit(page, (h) => h.waitFrames(30));
}

/** Until the hands are as `want` says (the session's ticks are the clock: frames come faster headless). */
async function handsBecome(page: Page, want: Partial<{ held: number; ready: number; aimed: number }>) {
  await page.waitForFunction(
    (w) => {
      const h = (window as unknown as { __trenchline: { hands(): Record<string, number> } }).__trenchline.hands();
      return Object.entries(w).every(([k, v]) => h[k] === v);
    },
    want,
    { timeout: 10_000 },
  );
}

/** Where the drawn model's pass disagrees with the CPU's trace (or with the world where it is not), and how many pixels it drew. */
async function drawnAsTraced(page: Page): Promise<{ drawn: number; wrong: string[] }> {
  const r = await kit(page, (h) => h.rifleCheck(14));
  if (!r.visible) return { drawn: 0, wrong: ['not drawn'] };
  const world = await kit(
    page,
    async (h, px) => {
      h.showRifle(false);
      await h.waitFrames(2);
      const d = await h.depthAt(px as [number, number][]);
      h.showRifle(true);
      await h.waitFrames(2);
      return d;
    },
    r.samples.map((s) => s.px),
  );
  let drawn = 0;
  const wrong: string[] = [];
  r.samples.forEach((s, k) => {
    if (s.cpu !== null && s.cpu < world[k]) {
      if (Math.abs(s.gpu - s.cpu) < 1e-3) drawn++;
      else wrong.push(JSON.stringify({ ...s, world: world[k] }));
      // The world elsewhere: as it is with the model put down (to a centimetre: its depth moves a
      // few millimetres frame to frame on some machines, rifle.spec.ts's known flake).
    } else if (Math.abs(s.gpu - world[k]) >= 1e-2) wrong.push(JSON.stringify({ ...s, world: world[k] }));
  });
  return { drawn, wrong };
}

test('the loadout menu chooses the kit, and Deploy goes in with it', async ({ page }) => {
  const errors = await openGame(page);
  await page.locator('#loadout-open').click();
  await expect(page.locator('#loadout')).toBeVisible();
  await page.locator('.gun-pick', { hasText: 'M4A1' }).click();
  await page.locator('#loadout .fit-row .pick', { hasText: 'Red dot' }).click();
  await page.locator('#loadout .fit-row .pick', { hasText: 'Suppressor' }).click();
  await page.locator('#loadout [data-tracers] .pick', { hasText: 'Green' }).click();
  await page.locator('#loadout-go').click();
  await expect(page.locator('#loadout')).toBeHidden();
  expect(await kit(page, (h) => h.mode())).toBe('playing');
  const l = await kit(page, (h) => h.loadout());
  expect([l.primary, l.fits.m4?.optic, l.fits.m4?.muzzle, l.tracer]).toEqual(['m4', 'reddot', 'suppressor', 'green']);
  expect(await kit(page, (h) => h.hands().gun)).toBe('m4');
  expect(await page.locator('#kit-line').textContent()).toContain('M4A1');
  expect(errors).toEqual([]);
});

test('every gun with its fit, the pistol and the shovel are drawn as their models are', async ({ page }) => {
  const errors = await openGame(page);
  await inTheBay(page);
  for (const [gun, fit] of Object.entries(FULL)) {
    await kit(page, (h, l) => h.setLoadout(l), { primary: gun, secondary: 'm17', fits: { [gun]: fit, m17: { optic: 'reddot', muzzle: 'suppressor', side: 'laser' } }, tracer: 'red' });
    await kit(page, (h) => h.waitFrames(6));
    const r = await drawnAsTraced(page);
    expect(r.wrong, gun).toEqual([]);
    expect(r.drawn, gun).toBeGreaterThan(5);
  }
  // The pistol, on its number.
  await page.keyboard.press('Digit2');
  await handsBecome(page, { held: 1, ready: 1 });
  await kit(page, (h) => h.waitFrames(4));
  expect(await kit(page, (h) => h.hands())).toMatchObject({ held: 1, ready: 1, gun: 'm17' });
  const pistol = await drawnAsTraced(page);
  expect(pistol.wrong).toEqual([]);
  expect(pistol.drawn).toBeGreaterThan(2);
  // The shovel, while F is held; the gun again after.
  await page.keyboard.down('KeyF');
  await handsBecome(page, { held: -1, ready: 1 });
  await kit(page, (h) => h.waitFrames(4));
  const shovel = await drawnAsTraced(page);
  expect(shovel.wrong).toEqual([]);
  expect(shovel.drawn).toBeGreaterThan(2);
  await page.keyboard.up('KeyF');
  await handsBecome(page, { held: 1, ready: 1 });
  expect(errors).toEqual([]);
});

test('aimed, the view closes in and the sight shows; the others carry their own kit', async ({ page }) => {
  const errors = await openGame(page);
  await inTheBay(page);
  const hip = (await kit(page, (h) => h.camera())).fov!;
  // A red dot: the reticle over the gun, which is still drawn.
  await kit(page, (h) => h.setLoadout({ primary: 'm4', secondary: 'm17', fits: { m4: { optic: 'reddot' } }, tracer: 'red' }));
  await kit(page, (h) => h.aim(true));
  await handsBecome(page, { aimed: 1 });
  await kit(page, (h) => h.waitFrames(4));
  expect((await kit(page, (h) => h.camera())).fov!).toBeLessThan(hip * 0.85);
  await expect(page.locator('#hud .reticle .dot')).toBeVisible();
  expect(await kit(page, (h) => h.rifleVisible())).toBe(true);
  // A scope: its circle, and the gun not drawn through it.
  await kit(page, (h) => h.aim(false));
  await kit(page, (h) => h.setLoadout({ primary: 'svd', secondary: 'm17', fits: { svd: { optic: 'scope' } }, tracer: 'off' }));
  await kit(page, (h) => h.aim(true));
  await handsBecome(page, { aimed: 1 });
  await kit(page, (h) => h.waitFrames(4));
  expect((await kit(page, (h) => h.camera())).fov!).toBeLessThan(hip / 3);
  await expect(page.locator('#scope')).toBeVisible();
  expect(await kit(page, (h) => h.rifleVisible())).toBe(false);
  await kit(page, (h) => h.aim(false));
  await handsBecome(page, { aimed: 0 });
  await expect(page.locator('#scope')).toBeHidden();

  // Soldiers before the player, each with their own gear: a scoped machine gun, a pistol with its
  // light, and a shovel at work.
  const gear = (g: Gear) => encodeGear(g);
  const bare = { optic: 'iron', muzzle: 'none', under: 'none', side: 'none' } as const;
  const soldiers = [
    { gear: gear({ gun: 'm249', fit: { optic: 'scope', muzzle: 'compensator', under: 'vertical', side: 'flashlight' }, tracer: 'red', light: true }), flags: 0 },
    { gear: gear({ gun: 'm17', fit: { ...bare, side: 'flashlight' }, tracer: 'off', light: true }), flags: 0 },
    { gear: gear({ gun: null, fit: bare, tracer: 'off', light: false }), flags: STATE.DIGGING },
  ];
  await kit(
    page,
    (h, list) => {
      const p = h.player();
      const v = h.views.bay;
      const yaw = (v.yaw * Math.PI) / 180;
      const f = [Math.sin(yaw), Math.cos(yaw)];
      const r = [Math.cos(yaw), -Math.sin(yaw)];
      h.puppets(
        (list as { gear: number; flags: number }[]).map((s, i) => ({
          team: i % 2 ? 'blue' : 'red',
          position: [p.position[0] + f[0] * 4 + r[0] * (i - 1) * 1.2, p.position[1], p.position[2] + f[1] * 4 + r[1] * (i - 1) * 1.2],
          yaw: v.yaw + 180,
          pitch: 0,
          height: 1.8,
          gear: s.gear,
          flags: s.flags,
        })),
      );
    },
    soldiers,
  );
  await kit(page, (h) => h.waitFrames(20));
  expect((await kit(page, (h) => h.soldiersDrawn())).length).toBe(3);
  await kit(page, (h) => h.puppets([]));
  expect(errors).toEqual([]);
});
