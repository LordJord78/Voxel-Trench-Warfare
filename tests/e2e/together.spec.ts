import { expect, test, type Browser, type Page } from '@playwright/test';

// Playing with friends (the multiplayer spec's §2), two players in two windows against the relay
// run locally (`npm run dev` in server/, the config's second web server): one hosts, the other
// follows the link; they see each other in the lobby, on their teams; the host starts the match,
// both go in, and each sees the other where they stand.

const RELAY = 'http://127.0.0.1:8787';

type Together = {
  room(): string | null;
  you(): number;
  owner(): number;
  seats(): { id: number; name: string; team: 'red' | 'blue'; ready: boolean }[];
  phase(): string | null;
  begun(): boolean;
  others(): { id: number; team: string; position: [number, number, number] }[];
};
type H = {
  ready: boolean;
  together: Together;
  player(): { position: [number, number, number] };
  camera(): { yaw: number; pitch: number };
  teleport(at: { position: [number, number, number]; yaw: number; pitch: number }): void;
  trigger(held: boolean): void;
  /** The session's tracers the last frame drew (net/gear.ts TRACER_KIND: amber 1, red 2, blue 3): this player's rounds and the others'. */
  tracerPixels(): { tracers: { kind: number }[] };
  /** The side this page fires for: its own rounds' colour, and the word each of its shots carries. */
  session: { team: 'red' | 'blue' };
  waitFrames(n: number): Promise<void>;
};

const h = <T>(page: Page, fn: (h: H) => T | Promise<T>): Promise<T> =>
  page.evaluate((source) => new Function('h', `return (${source})(h)`)((window as unknown as { __trenchline: H }).__trenchline), fn.toString()) as Promise<T>;

async function open(browser: Browser, path: string): Promise<{ page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 960, height: 600 } });
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

test('one hosts, a friend follows the link: one lobby, two teams, a match, and each sees the other', async ({ browser }) => {
  test.setTimeout(300_000);
  const host = await open(browser, `/?relay=${RELAY}`);
  await host.page.locator('#host').click();
  await expect(host.page.locator('#lobby')).toBeVisible();
  await host.page.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.together.you() === 0);
  const room = (await h(host.page, (x) => x.together.room()))!;
  expect(room).toMatch(/^[A-Z]{5}$/);
  const invite = await host.page.locator('#invite').inputValue();
  expect(new URL(invite).searchParams.get('room')).toBe(room);
  await host.page.locator('#name').fill('Jord');
  await host.page.locator('#name').dispatchEvent('change');

  const friend = await open(browser, `/?room=${room}&relay=${RELAY}`);
  await expect(friend.page.locator('#lobby')).toBeVisible();
  await friend.page.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.together.seats().length === 2);
  await host.page.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.together.seats().length === 2);
  // Alternating teams, the host named, the friend not the owner.
  const seats = await h(host.page, (x) => x.together.seats());
  expect(seats.map((s) => [s.id, s.team])).toEqual([[0, 'red'], [1, 'blue']]);
  expect(seats[0].name).toBe('Jord');
  await expect(friend.page.locator('#red-list')).toContainText('Jord');
  await expect(friend.page.locator('#start')).toBeHidden();
  await expect(host.page.locator('#start')).toBeVisible();

  // The room's front quiet (M6: in a room's match the front fires on its players, at the room's
  // intensity), so the only rounds in the air are the players' own: its amber is no team's colour.
  await host.page.locator('#match-settings select[name="intensity"]').selectOption('off');
  await expect(friend.page.locator('#match-settings select[name="intensity"]')).toHaveValue('off');
  await friend.page.locator('#ready').click();
  await expect(host.page.locator('#blue-list')).toContainText('ready');
  await host.page.locator('#start').click();
  for (const p of [host.page, friend.page]) {
    await expect(p.locator('#deploy-line')).toContainText('You fight for');
    await p.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.together.begun(), null, { timeout: 15_000 });
    await expect(p.locator('#go')).toBeVisible();
    await p.locator('#go').click();
    await expect(p.locator('#lobby')).toBeHidden();
  }
  // Red starts in the front line and Blue in the enemy's, across no man's land.
  const hostAt = await h(host.page, (x) => x.player().position);
  const friendAt = await h(friend.page, (x) => x.player().position);
  expect(friendAt[2] - hostAt[2]).toBeGreaterThan(30);

  // Each sees the other, where they stand, within a few frames of the room's relay.
  for (const [page, other] of [[host.page, friendAt], [friend.page, hostAt]] as const) {
    await page.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.together.others().length === 1, null, { timeout: 10_000 });
    const seen = (await h(page, (x) => x.together.others()))[0];
    expect(Math.hypot(seen.position[0] - other[0], seen.position[2] - other[2])).toBeLessThan(0.3);
  }
  await expect(host.page.locator('#roomline')).toContainText(`Game ${room}`);

  // Each sees the other's rounds in their team's colour (the shots spec §1, done row 2): a short burst
  // from the friend (Blue) is drawn blue on both pages, the shooter's own rounds and the room's copy
  // of them; then one from the host (Red), red on both. Fired well up into the sky, clear of everyone.
  /** A short burst from `shooter`: every kind each page (the host's, the friend's) draws over the next 240 frames, and how many frames drew one. */
  const burst = async (shooter: Page) => {
    for (const p of [host.page, friend.page]) await p.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.tracerPixels().tracers.length === 0, null, { timeout: 15_000 });
    const watch = (p: Page) =>
      h(p, async (x) => {
        const kinds: number[] = [];
        let frames = 0;
        for (let k = 0; k < 240; k++) {
          await x.waitFrames(1);
          const drawn = x.tracerPixels().tracers;
          if (drawn.length > 0) frames++;
          for (const t of drawn) if (!kinds.includes(t.kind)) kinds.push(t.kind);
        }
        return { kinds, frames };
      });
    const seen = Promise.all([watch(host.page), watch(friend.page)]);
    await h(shooter, (x) => {
      x.teleport({ position: x.player().position, yaw: x.camera().yaw, pitch: 35 });
      x.trigger(true);
    });
    await shooter.waitForTimeout(300);
    await h(shooter, (x) => x.trigger(false));
    return seen;
  };
  for (const [shooter, kind, who] of [[friend.page, 3, 'Blue'], [host.page, 2, 'Red']] as const) {
    const [onHost, onFriend] = await burst(shooter);
    expect(onHost.frames, `${who}'s rounds drawn on the host's page`).toBeGreaterThan(0);
    expect(onFriend.frames, `${who}'s rounds drawn on the friend's page`).toBeGreaterThan(0);
    expect(onHost.kinds, `${who}'s rounds on the host's page`).toEqual([kind]);
    expect(onFriend.kinds, `${who}'s rounds on the friend's page`).toEqual([kind]);
  }
  // Another's rounds are drawn in their seat's team's colour whatever their shot's word says (together.ts
  // prepare, shotTracer). The friend's own page made to fight for Red: its rounds are red there, and the
  // word each shot carries says red; the host draws them in the friend's seat's colour, Blue.
  await h(friend.page, (x) => {
    x.session.team = 'red';
  });
  const [onHost, onFriend] = await burst(friend.page);
  expect(onFriend.frames, "the friend's rounds drawn on the friend's page, its word made red").toBeGreaterThan(0);
  expect(onFriend.kinds, "the friend's rounds on the friend's page, its word made red").toEqual([2]);
  expect(onHost.frames, "the friend's rounds drawn on the host's page, its word made red").toBeGreaterThan(0);
  expect(onHost.kinds, "the friend's rounds on the host's page, its word made red: their seat's Blue").toEqual([3]);
  expect(host.errors).toEqual([]);
  expect(friend.errors).toEqual([]);
  // Each window draws the world on the one GPU: let them go before the next test's.
  await host.page.context().close();
  await friend.page.context().close();
});

test('a friend who follows a link to a Corridor game is taken to the Corridor, and each side starts at its end of the wood', async ({ browser }) => {
  test.setTimeout(400_000);
  const host = await open(browser, `/?map=corridor&relay=${RELAY}`);
  expect(await host.page.evaluate(() => (window as unknown as { __trenchline: { map: string } }).__trenchline.map)).toBe('corridor');
  await host.page.locator('#host').click();
  await host.page.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.together.you() === 0);
  const room = (await h(host.page, (x) => x.together.room()))!;
  await expect(host.page.locator('#invite')).toHaveValue(/map=corridor/);
  await expect(host.page.locator('#match-settings select[name="map"]')).toHaveValue('corridor');

  // The link without its map: the friend's page loads the Ravine, finds the room's map, and goes to it.
  const friend = await open(browser, `/?room=${room}&relay=${RELAY}`);
  await friend.page.waitForURL(/map=corridor/, { timeout: 60_000 });
  await friend.page.waitForFunction(() => (window as unknown as { __trenchline?: H }).__trenchline?.ready === true, null, { timeout: 120_000 });
  expect(await friend.page.evaluate(() => (window as unknown as { __trenchline: { map: string } }).__trenchline.map)).toBe('corridor');
  await friend.page.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.together.seats().length === 2, null, { timeout: 30_000 });
  await host.page.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.together.seats().length === 2);

  await host.page.locator('#start').click();
  for (const p of [host.page, friend.page]) {
    await p.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.together.begun(), null, { timeout: 15_000 });
    await p.locator('#go').click();
  }
  // Red at the wood's south end (it starts 50 m in), Blue at its north (it ends 50 m from the far side).
  const red = await h(host.page, (x) => x.player().position);
  const blue = await h(friend.page, (x) => x.player().position);
  expect(red[2]).toBeLessThan(50);
  expect(blue[2]).toBeGreaterThan(206);
  expect(host.errors).toEqual([]);
  expect(friend.errors).toEqual([]);
  await host.page.context().close();
  await friend.page.context().close();
});

test('a link to a game that does not exist says so', async ({ browser }) => {
  const lost = await open(browser, `/?room=QQQQQ&relay=${RELAY}`);
  await expect(lost.page.locator('#lobby-status')).toContainText('no game with that code');
});

test('solo play opens no connection to the relay at all', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const sockets: string[] = [];
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/@vite') && !ws.url().includes('token=')) sockets.push(ws.url());
  });
  const asked: string[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith(RELAY)) asked.push(r.url());
  });
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { __trenchline?: H }).__trenchline?.ready === true, null, { timeout: 120_000 });
  await page.locator('#play').click();
  await page.evaluate(() => (window as unknown as { __trenchline: H }).__trenchline.waitFrames(30));
  expect(sockets).toEqual([]);
  expect(asked).toEqual([]);
});
