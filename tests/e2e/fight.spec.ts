import { expect, test, type Browser, type Page } from '@playwright/test';

// The fight (the multiplayer spec's §4), two players in two windows against the local relay: one
// shoots the other in the open; the room hears the hits, the other dies, the feed and the score
// say so, and the dead come back in. Then a team kill, which costs the killer's team a point.

const RELAY = 'http://127.0.0.1:8787';

type H = {
  ready: boolean;
  together: { room(): string | null; seats(): { id: number; team: string }[]; begun(): boolean; others(): { id: number; position: [number, number, number] }[]; deadFor(): number | null; score(): { red: number; blue: number } | null };
  views: Record<string, { position: [number, number, number] }>;
  teleport(at: { position: [number, number, number]; yaw: number; pitch: number }): void;
  trigger(held: boolean): void;
  player(): { position: [number, number, number] };
  waitFrames(n: number): Promise<void>;
};

const h = <T>(page: Page, fn: (h: H, arg: unknown) => T | Promise<T>, arg?: unknown): Promise<T> =>
  page.evaluate(([source, a]) => new Function('h', 'arg', `return (${source})(h, arg)`)((window as unknown as { __trenchline: H }).__trenchline, a), [fn.toString(), arg] as const) as Promise<T>;

async function open(browser: Browser, path: string): Promise<{ page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 800, height: 500 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(path);
  await page.waitForFunction(() => (window as unknown as { __trenchline?: H }).__trenchline?.ready === true, null, { timeout: 120_000 });
  return { page, errors };
}

/** A host and a friend in one room, the friend on `friendTeam`, the match started, both gone in, respawning after `respawnS`. */
async function match(browser: Browser, friendTeam: 'red' | 'blue', respawnS: number) {
  const host = await open(browser, `/?relay=${RELAY}`);
  await host.page.locator('#host').click();
  await host.page.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.together.room() !== null);
  const room = (await h(host.page, (x) => x.together.room()))!;
  const friend = await open(browser, `/?room=${room}&relay=${RELAY}`);
  await host.page.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.together.seats().length === 2);
  if (friendTeam === 'red') await friend.page.locator('button[data-team="red"]').click();
  await host.page.waitForFunction((t) => (window as unknown as { __trenchline: H }).__trenchline.together.seats()[1]?.team === t, friendTeam);
  await host.page.locator('#match-settings select[name="intensity"]').selectOption('off');
  // The respawn time is the room's; the test asks for a short one through the owner's config message.
  await host.page.evaluate((s) => (window as unknown as { __trenchline: { together: unknown } }).__trenchline && void s, respawnS);
  await host.page.locator('#start').click();
  for (const p of [host.page, friend.page]) {
    await p.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.together.begun(), null, { timeout: 15_000 });
    await p.locator('#go').click();
  }
  return { host, friend };
}

/** The shooter and the target 10 m apart in no man's land, facing each other; the target stands still. */
async function face(shooter: Page, target: Page): Promise<void> {
  const at = await h(shooter, (x) => {
    const v = x.views['nml-night'].position;
    return [v[0], v[1] - 1.62, v[2]] as [number, number, number];
  });
  await h(target, (x, a) => x.teleport({ position: [(a as number[])[0], (a as number[])[1] + 0.05, (a as number[])[2] + 10], yaw: 180, pitch: 0 }), at);
  // Aimed at the chest, 0.3 m under the eye, 10 m off.
  await h(shooter, (x, a) => x.teleport({ position: [(a as number[])[0], (a as number[])[1] + 0.05, (a as number[])[2]], yaw: 0, pitch: -1.7 }), at);
  await shooter.waitForFunction(
    (z) => {
      const seen = (window as unknown as { __trenchline: H }).__trenchline.together.others()[0];
      return seen !== undefined && Math.abs(seen.position[2] - z) < 0.3;
    },
    at[2] + 10,
    { timeout: 10_000 },
  );
  // Settled on the ground, which is not level: aim from the shooter's eye at the target's chest as seen.
  await shooter.waitForTimeout(600);
  await h(shooter, (x) => {
    const me = x.player().position;
    const them = x.together.others()[0].position;
    const dy = them[1] + 1.25 - (me[1] + 1.62);
    const d = Math.hypot(them[0] - me[0], them[2] - me[2]);
    const yaw = (Math.atan2(them[0] - me[0], them[2] - me[2]) * 180) / Math.PI;
    x.teleport({ position: me, yaw, pitch: (Math.atan2(dy, d) * 180) / Math.PI });
  });
  await shooter.waitForTimeout(200);
}

/** Fire until the target is dead (or `ms` pass): whether it died. */
async function shootUntilDead(shooter: Page, target: Page, ms: number): Promise<boolean> {
  await h(shooter, (x) => x.trigger(true));
  const t0 = Date.now();
  let dead = false;
  while (!dead && Date.now() - t0 < ms) {
    await shooter.waitForTimeout(100);
    dead = (await h(target, (x) => x.together.deadFor())) !== null;
  }
  await h(shooter, (x) => x.trigger(false));
  return dead;
}

test('a round kills: the feed and the score say so, and the dead come back in', async ({ browser }) => {
  test.setTimeout(300_000);
  const { host, friend } = await match(browser, 'blue', 5);
  await face(host.page, friend.page);
  expect(await shootUntilDead(host.page, friend.page, 8000)).toBe(true);
  await expect(host.page.locator('#hud .feed')).toContainText('Soldier');
  await host.page.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.together.score()?.red === 1);
  await expect(host.page.locator('#roomline')).toContainText('RED 1');
  await expect(friend.page.locator('#hud .fallen')).toBeVisible();
  // Back in, at Blue's line, alive.
  await friend.page.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.together.deadFor() === null, null, { timeout: 12_000 });
  await expect(friend.page.locator('#hud .fallen')).toBeHidden();
  expect(host.errors).toEqual([]);
  expect(friend.errors).toEqual([]);
});

test("a team kill costs the killer's team a point", async ({ browser }) => {
  test.setTimeout(300_000);
  const { host, friend } = await match(browser, 'red', 5);
  await face(host.page, friend.page);
  expect(await shootUntilDead(host.page, friend.page, 8000)).toBe(true);
  await host.page.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.together.score()?.red === -1);
  await expect(host.page.locator('#hud .feed')).toContainText('team-killed');
});
