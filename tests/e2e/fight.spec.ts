import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

// The fight (the multiplayer spec's §4), two players in two windows against the local relay: one
// shoots the other in the open; the room hears the hits, the other dies, the feed and the score
// say so, and the dead come back in. The hit feedback (the shots spec's §4): the shooter's crosshair
// marks the kill when the room says it, red, and KILL under it names the victim in their team's
// colour; the one shot sees the red flash of each round into them, and as they die, whether or not
// the round that killed them reached their page first. A headshot kill says HEADSHOT once, the room's
// word naming the victim in the round's pop without starting it again, and the shooter's ear hears
// its crack and gush. Then a team kill, which costs the killer's team a point.

const RELAY = 'http://127.0.0.1:8787';

type H = {
  ready: boolean;
  together: { room(): string | null; you(): number; seats(): { id: number; team: string; name: string }[]; begun(): boolean; others(): { id: number; position: [number, number, number] }[]; deadFor(): number | null; score(): { red: number; blue: number } | null };
  hitFeedback(): { marker: 'hit' | 'head' | 'kill' | null; pop: string | null; voices: Record<string, number>; flashes: number; markers: Record<'hit' | 'head' | 'kill', number> };
  views: Record<string, { position: [number, number, number] }>;
  teleport(at: { position: [number, number, number]; yaw: number; pitch: number }): void;
  trigger(held: boolean): void;
  player(): { position: [number, number, number] };
  waitFrames(n: number): Promise<void>;
  range(on: boolean): void;
  rangeState(): { up: boolean; dummies: unknown[]; plates: unknown[]; readout: string | null };
};

const h = <T>(page: Page, fn: (h: H, arg: unknown) => T | Promise<T>, arg?: unknown): Promise<T> =>
  page.evaluate(([source, a]) => new Function('h', 'arg', `return (${source})(h, arg)`)((window as unknown as { __trenchline: H }).__trenchline, a), [fn.toString(), arg] as const) as Promise<T>;

/**
 * Each test's windows, closed as it ends, passed or failed: a game page left open goes on drawing, and
 * the next spec in the worker waits on a GPU and a CPU it shares with them.
 */
const windows: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(windows.splice(0).map((c) => c.close()));
});

async function open(browser: Browser, path: string): Promise<{ page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 800, height: 500 } });
  windows.push(context);
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
  // The start screen is taller than this 800 × 500 window: it scrolls with its head in reach, as the
  // pause menu and the lobby do, rather than rise off the top, so Host lies inside the window.
  await expect(host.page.locator('#host')).toBeInViewport({ ratio: 1 });
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
  // The range never stands in a room (G2): not from the click that goes in, as solo's would, nor
  // asked for by hand on either page, at once or a few frames on.
  const down = { up: false, dummies: [], plates: [], readout: null };
  for (const [p, ask] of [[host.page, false], [friend.page, true]] as const) {
    const seen = await h(
      p,
      async (x, a) => {
        await x.waitFrames(3);
        const gone = x.rangeState();
        if (!a) return { gone, asked: null, later: null };
        x.range(true);
        const asked = x.rangeState();
        await x.waitFrames(3);
        return { gone, asked, later: x.rangeState() };
      },
      ask,
    );
    expect(seen.gone, 'the range in a room, gone in').toEqual(down);
    if (ask) {
      expect(seen.asked, 'the range in a room, asked for').toEqual(down);
      expect(seen.later, 'the range in a room, asked for, frames on').toEqual(down);
    }
  }
  return { host, friend };
}

/** The shooter and the target 10 m apart in no man's land, facing each other; the target stands still; the shooter aims `aimAt` m over the target's feet (the chest, unless told). */
async function face(shooter: Page, target: Page, aimAt = 1.25): Promise<void> {
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
  await h(
    shooter,
    (x, a) => {
      const me = x.player().position;
      const them = x.together.others()[0].position;
      const dy = them[1] + (a as number) - (me[1] + 1.62);
      const d = Math.hypot(them[0] - me[0], them[2] - me[2]);
      const yaw = (Math.atan2(them[0] - me[0], them[2] - me[2]) * 180) / Math.PI;
      x.teleport({ position: me, yaw, pitch: (Math.atan2(dy, d) * 180) / Math.PI });
    },
    aimAt,
  );
  await shooter.waitForTimeout(200);
}

/**
 * On `page`, from now: the first frame the crosshair's marker shows a kill (its kind, its class and
 * colour, the words under it, their name's class, and whether the words' pop is the one a HEADSHOT
 * unnamed last started, going on), the first the red flash shows (its opacity), and the first the
 * page's player is dead (whether the red flash shows then, its opacity, and how long ago it last
 * showed, ms), each kept as the page's `__seen` for `seen` to read.
 */
async function watch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __trenchline: H; __seen: Record<string, unknown>; __headshot?: Animation; __flashAt?: number };
    w.__seen = {};
    const look = () => {
      const f = w.__trenchline.hitFeedback();
      const marker = document.querySelector<HTMLElement>('#hud .marker')!;
      const pop = document.querySelector<HTMLElement>('#hud .hit-pop')!.getAnimations()[0];
      if (f.pop === 'HEADSHOT') w.__headshot = pop;
      if (f.marker === 'kill' && !w.__seen.kill) {
        w.__seen.kill = { marker: f.marker, pop: f.pop, className: marker.className, colour: getComputedStyle(marker.querySelector('i')!).backgroundColor, name: document.querySelector('#hud .hit-pop .name')!.className, samePop: pop !== undefined && pop === w.__headshot };
      }
      const flash = document.querySelector<HTMLElement>('#hurt-flash')!;
      if (!flash.hidden) w.__flashAt = performance.now();
      if (!flash.hidden && !w.__seen.flash) w.__seen.flash = { opacity: Number(getComputedStyle(flash).opacity) };
      if (w.__trenchline.together.deadFor() !== null && !w.__seen.death) {
        w.__seen.death = { flash: !flash.hidden, opacity: Number(getComputedStyle(flash).opacity), ago: w.__flashAt === undefined ? null : performance.now() - w.__flashAt };
      }
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
}

const seen = (page: Page) =>
  page.evaluate(() => (window as unknown as { __seen: Record<string, { marker?: string; pop?: string | null; className?: string; colour?: string; name?: string; samePop?: boolean; opacity?: number; flash?: boolean; ago?: number | null }> }).__seen);

/**
 * As the one shot died, the red flash showed: at that frame, or (a round felt within kill_window_s
 * before, whose flash the room's word does not repeat, fading over hurt_flash_s, 50 ms longer) at the
 * frames just before it.
 */
const redAsTheyDied = (death: { flash?: boolean; ago?: number | null } | undefined) => death !== undefined && death.ago !== null && death.ago !== undefined && death.ago < 100;

/** The other seat's name, as `page` has the room's seats. */
const otherName = (page: Page) => h(page, (x) => x.together.seats().find((s) => s.id !== x.together.you())!.name);

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

/**
 * Fire a round at a time, a tap every 0.35 s, until the target is dead (or `ms` pass): whether it
 * died. Each round goes where the shooter is aimed, its recoil settled since the last (a held burst
 * climbs, over a head held at); the first may land while the room still protects the newly deployed.
 */
async function tapUntilDead(shooter: Page, target: Page, ms: number): Promise<boolean> {
  const t0 = Date.now();
  let dead = false;
  while (!dead && Date.now() - t0 < ms) {
    await h(shooter, async (x) => {
      x.trigger(true);
      await x.waitFrames(1);
      x.trigger(false);
    });
    await shooter.waitForTimeout(350);
    dead = (await h(target, (x) => x.together.deadFor())) !== null;
  }
  return dead;
}

test('a round kills: the feed and the score say so, the shooter sees the kill marked and named, the one shot sees red, and the dead come back in', async ({ browser }) => {
  test.setTimeout(300_000);
  const { host, friend } = await match(browser, 'blue', 5);
  await face(host.page, friend.page);
  await watch(host.page);
  await watch(friend.page);
  expect(await tapUntilDead(host.page, friend.page, 8000)).toBe(true);
  await expect(host.page.locator('#hud .feed')).toContainText('Soldier');
  // The room's death on the shooter's page: the red kill marker, and KILL with the victim's name in Blue's colour.
  await host.page.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.hitFeedback().markers.kill === 1, null, { timeout: 5000 });
  const name = await otherName(host.page);
  const shooter = await seen(host.page);
  const fed = await h(host.page, (x) => x.hitFeedback());
  const said = JSON.stringify({ name, shooter, fed });
  // (KILL's pop is its own: no HEADSHOT pop went on into it.)
  expect(shooter.kill, said).toEqual({ marker: 'kill', pop: `KILL ${name}`, className: 'marker kill', colour: 'rgb(255, 59, 47)', name: 'name blue', samePop: false });
  // Chest rounds: each a thwack at the shooter's ear, none a headshot.
  expect(fed.markers.hit, said).toBeGreaterThanOrEqual(1);
  expect(fed.voices.hit, said).toBeGreaterThanOrEqual(1);
  expect([fed.markers.head, fed.voices.head ?? 0, fed.voices.gush ?? 0, fed.voices.kill], said).toEqual([0, 0, 0, 1]);
  // The one shot: each round of the shooter's into their body as their page fired it, a red flash and
  // a hurt; and as they die, the red flash, the killing round's or the room's word's.
  const victim = await h(friend.page, async (x) => {
    await x.waitFrames(3);
    return x.hitFeedback();
  });
  const struck = await seen(friend.page);
  expect(victim.flashes, JSON.stringify({ victim, struck })).toBeGreaterThanOrEqual(1);
  expect(victim.voices.hurt, JSON.stringify(victim)).toBe(victim.flashes);
  expect(struck.flash?.opacity ?? 0, JSON.stringify(struck)).toBeGreaterThan(0);
  expect(redAsTheyDied(struck.death), JSON.stringify(struck)).toBe(true);
  expect(victim.markers, JSON.stringify(victim)).toEqual({ hit: 0, head: 0, kill: 0 });
  await host.page.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.together.score()?.red === 1);
  await expect(host.page.locator('#roomline')).toContainText('RED 1');
  await expect(friend.page.locator('#hud .fallen')).toBeVisible();
  // Back in, at Blue's line, alive.
  await friend.page.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.together.deadFor() === null, null, { timeout: 12_000 });
  await expect(friend.page.locator('#hud .fallen')).toBeHidden();
  expect(host.errors).toEqual([]);
  expect(friend.errors).toEqual([]);
});

test("a headshot kill: the shooter's ear hears its crack and gush, and HEADSHOT names the victim when the room says", async ({ browser }) => {
  test.setTimeout(300_000);
  const { host, friend } = await match(browser, 'blue', 5);
  // At the head: an AK's round there kills (105), one round, which may reach the one shot's page
  // after the room's word that they are dead.
  await face(host.page, friend.page, 1.62);
  await watch(host.page);
  await watch(friend.page);
  expect(await tapUntilDead(host.page, friend.page, 8000)).toBe(true);
  await host.page.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.hitFeedback().markers.kill === 1, null, { timeout: 5000 });
  const name = await otherName(host.page);
  const shooter = await seen(host.page);
  const fed = await h(host.page, (x) => x.hitFeedback());
  const said = JSON.stringify({ name, shooter, fed });
  // HEADSHOT popped once: the room's word named the victim in the pop the round started, going on.
  expect(shooter.kill, said).toMatchObject({ marker: 'kill', pop: `HEADSHOT ${name}`, className: 'marker kill', name: 'name blue', samePop: true });
  expect(fed.markers.head, said).toBeGreaterThanOrEqual(1);
  expect(fed.voices.head, said).toBeGreaterThanOrEqual(1);
  expect(fed.voices.gush, said).toBeGreaterThanOrEqual(1);
  expect(fed.voices.kill, said).toBe(1);
  // The one shot felt it as they died: the red flash, at full strength if the room's word gave it; and its hurt.
  const victim = await h(friend.page, async (x) => {
    await x.waitFrames(3);
    return x.hitFeedback();
  });
  const struck = await seen(friend.page);
  const felt = JSON.stringify({ victim, struck });
  console.log(`the one shot, killed by a headshot: ${victim.flashes} red flashes, the flash ${struck.death?.flash ? `showing at ${struck.death.opacity?.toFixed(2)}` : `last shown ${struck.death?.ago?.toFixed(0)} ms before`} as they died`);
  expect(redAsTheyDied(struck.death), felt).toBe(true);
  expect(victim.flashes, felt).toBeGreaterThanOrEqual(1);
  expect(victim.voices.hurt, felt).toBe(victim.flashes);
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
