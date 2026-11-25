import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { MAX_PLAYERS, PROTOCOL } from '../../src/net/protocol';
import { PROTECT_MS } from '../../src/net/match-rules';
import { makeRoom, RelayClient } from './support/relay-client';

// Playing with friends (the multiplayer spec's §2), two players in two windows against the relay
// run locally (`npm run dev` in server/, the config's second web server): one hosts, the other
// follows the link; they see each other in the lobby, on their teams; the host starts the match,
// both go in, and each sees the other where they stand. The first test quiets the room's battle, so the
// only rounds drawn are the players'; the second leaves it at the room's default, light (the final
// review's item 15.10), the front's amber rounds drawn among theirs.

const RELAY = 'http://127.0.0.1:8787';

type Together = {
  room(): string | null;
  you(): number;
  owner(): number;
  seats(): { id: number; name: string; team: 'red' | 'blue'; ready: boolean }[];
  phase(): string | null;
  begun(): boolean;
  others(): { id: number; team: string; position: [number, number, number] }[];
  /** Each player's kills and deaths as the room last told them: [seat, kills, deaths]. */
  tallies(): [number, number, number][];
  /** The start screen's word on a join, and whether the start screen is up. */
  joinNote(): { up: boolean; text: string };
  caughtUp(): boolean;
};
type H = {
  ready: boolean;
  /** The page's build (main.ts __TRENCHLINE_BUILD__): a room takes one. */
  build: string;
  map: string;
  mode(): string;
  loseDevice(): void;
  together: Together;
  player(): { position: [number, number, number] };
  camera(): { yaw: number; pitch: number };
  teleport(at: { position: [number, number, number]; yaw: number; pitch: number }): void;
  trigger(held: boolean): void;
  /** The session's tracers the last frame drew (net/gear.ts TRACER_KIND: amber 1, red 2, blue 3): this player's rounds and the others'. */
  tracerPixels(): { tracers: { kind: number }[] };
  /**
   * The side this page fires for: its own rounds' colour, and the word each of its shots carries; the
   * front (its intensity, from which side, and the rounds it has fired: Front.fired); the visitor's shells.
   */
  session: { team: 'red' | 'blue'; front: { intensity: string; readonly fired: number }; frontSide: number; artillery: { intensity: string } };
  waitFrames(n: number): Promise<void>;
};

const h = <T>(page: Page, fn: (h: H) => T | Promise<T>): Promise<T> =>
  page.evaluate((source) => new Function('h', `return (${source})(h)`)((window as unknown as { __trenchline: H }).__trenchline), fn.toString()) as Promise<T>;

async function open(browser: Browser, path: string, before?: (context: BrowserContext) => Promise<void>): Promise<{ page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 960, height: 600 } });
  await before?.(context);
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

/** A tracer's kind (net/gear.ts TRACER_KIND): the front's rounds are amber, no team's colour. */
const AMBER = 1;

/**
 * A short burst from `shooter`, fired well up into the sky: every kind each of `pages` draws over the
 * next 240 frames, how many frames drew one, and how many drew each kind.
 */
async function burstOn(pages: readonly Page[], shooter: Page): Promise<{ kinds: number[]; frames: number; framesOf: Record<number, number> }[]> {
  for (const p of pages) await p.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.tracerPixels().tracers.length === 0, null, { timeout: 15_000 });
  const watch = (p: Page) =>
    h(p, async (x) => {
      const kinds: number[] = [];
      const framesOf: Record<number, number> = {};
      let frames = 0;
      for (let k = 0; k < 240; k++) {
        await x.waitFrames(1);
        const drawn = x.tracerPixels().tracers;
        if (drawn.length > 0) frames++;
        for (const kind of new Set(drawn.map((t) => t.kind))) framesOf[kind] = (framesOf[kind] ?? 0) + 1;
        for (const t of drawn) if (!kinds.includes(t.kind)) kinds.push(t.kind);
      }
      return { kinds, frames, framesOf };
    });
  const seen = Promise.all(pages.map(watch));
  await h(shooter, (x) => {
    x.teleport({ position: x.player().position, yaw: x.camera().yaw, pitch: 35 });
    x.trigger(true);
  });
  await shooter.waitForTimeout(300);
  await h(shooter, (x) => x.trigger(false));
  return seen;
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
  const burst = (shooter: Page) => burstOn([host.page, friend.page], shooter);
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

test("under the room's default light battle, the front firing on both: each sees the other where they stand, and the other's rounds in their team's colour beside the front's amber", async ({ browser }) => {
  test.setTimeout(300_000);
  const host = await open(browser, `/?relay=${RELAY}`);
  await host.page.locator('#host').click();
  await host.page.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.together.you() === 0);
  const room = (await h(host.page, (x) => x.together.room()))!;
  const friend = await open(browser, `/?room=${room}&relay=${RELAY}`);
  for (const p of [host.page, friend.page]) await p.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.together.seats().length === 2);
  // The lobby's battle left as it is: light, the room's default.
  for (const p of [host.page, friend.page]) await expect(p.locator('#match-settings select[name="intensity"]')).toHaveValue('light');
  await host.page.locator('#start').click();
  for (const p of [host.page, friend.page]) {
    await p.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.together.begun(), null, { timeout: 15_000 });
    await p.locator('#go').click();
    await expect(p.locator('#lobby')).toBeHidden();
  }
  // On each page the room's battle, light: its front from the line across from the page's team, the shells the room's alone.
  const battleOf = (p: Page) => h(p, (x) => ({ front: x.session.front.intensity, side: x.session.frontSide, artillery: x.session.artillery.intensity }));
  expect(await battleOf(host.page)).toEqual({ front: 'light', side: 1, artillery: 'off' });
  expect(await battleOf(friend.page)).toEqual({ front: 'light', side: 0, artillery: 'off' });
  const fired0 = [await h(host.page, (x) => x.session.front.fired), await h(friend.page, (x) => x.session.front.fired)];
  // Each sees the other, where they stand.
  const hostAt = await h(host.page, (x) => x.player().position);
  const friendAt = await h(friend.page, (x) => x.player().position);
  for (const [page, other] of [[host.page, friendAt], [friend.page, hostAt]] as const) {
    await page.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.together.others().length === 1, null, { timeout: 10_000 });
    const seen = (await h(page, (x) => x.together.others()))[0];
    expect(Math.hypot(seen.position[0] - other[0], seen.position[2] - other[2])).toBeLessThan(0.3);
  }
  // Each one's rounds in their team's colour on both pages, Blue's and then Red's; any other drawn the front's, amber.
  const amber: number[] = [];
  for (const [shooter, kind, who] of [[friend.page, 3, 'Blue'], [host.page, 2, 'Red']] as const) {
    const [onHost, onFriend] = await burstOn([host.page, friend.page], shooter);
    console.log(`${who}'s burst under the light battle: the host's page drew ${JSON.stringify(onHost.framesOf)}, the friend's ${JSON.stringify(onFriend.framesOf)} (frames of each kind)`);
    for (const [on, page] of [[onHost, "the host's"], [onFriend, "the friend's"]] as const) {
      expect(on.framesOf[kind] ?? 0, `${who}'s rounds drawn on ${page} page`).toBeGreaterThan(0);
      expect(on.kinds.filter((k) => k !== AMBER), `${who}'s rounds on ${page} page, the front's amber aside`).toEqual([kind]);
      amber.push(on.framesOf[AMBER] ?? 0);
    }
  }
  // The front fired at each all the while (light: 40 a minute).
  const fired = [(await h(host.page, (x) => x.session.front.fired)) - fired0[0], (await h(friend.page, (x) => x.session.front.fired)) - fired0[1]];
  console.log(`the front fired ${fired[0]} rounds at the host and ${fired[1]} at the friend; its amber drawn in ${amber.join(', ')} frames of the bursts' watches`);
  expect(fired[0]).toBeGreaterThan(0);
  expect(fired[1]).toBeGreaterThan(0);
  expect(host.errors).toEqual([]);
  expect(friend.errors).toEqual([]);
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

test('a link to a game that does not exist goes back to the start screen, saying so, and the page plays solo from there', async ({ browser }) => {
  // The release audit's UX-1: the friend was left on a bare world, the reason in a hidden lobby.
  const lost = await open(browser, `/?room=QQQQQ&relay=${RELAY}`);
  await expect(lost.page.locator('#join-note')).toHaveText('No game with that code', { timeout: 30_000 });
  await expect(lost.page.locator('#join-note')).toBeVisible();
  await expect(lost.page.locator('#loading')).toBeVisible();
  await expect(lost.page.locator('#lobby')).toBeHidden();
  for (const id of ['#play', '#host', '#join-go']) await expect(lost.page.locator(id)).toBeEnabled();
  // The address forgets the room: a reload would only try it again.
  expect(new URL(lost.page.url()).searchParams.has('room')).toBe(false);
  // Past the 8 s a note would have lasted: still said.
  await lost.page.waitForTimeout(9_000);
  await expect(lost.page.locator('#join-note')).toHaveText('No game with that code');
  await lost.page.locator('#play').click();
  await expect(lost.page.locator('#loading')).toBeHidden();
  expect(await h(lost.page, (x) => x.mode())).toBe('playing');
  expect(lost.errors.filter((e) => !/WebSocket/i.test(e))).toEqual([]);
  await lost.page.context().close();
});

test('a typed code with an I or an O is checked before anything is asked of the relay', async ({ browser }) => {
  const page = await open(browser, `/?relay=${RELAY}`);
  const sockets: string[] = [];
  page.page.on('websocket', (ws) => {
    if (ws.url().includes('/room/')) sockets.push(ws.url());
  });
  await page.page.locator('#join-code').fill('house');
  await page.page.locator('#join-go').click();
  await expect(page.page.locator('#join-note')).toHaveText('Codes never use I or O: check the code');
  await expect(page.page.locator('#loading')).toBeVisible();
  expect(sockets).toEqual([]);
  await page.page.context().close();
});

test('a full game turns a friend back to the start screen, saying so', async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await open(browser, `/?relay=${RELAY}`);
  // The room takes one build (its first hello's): the bots say the page's, so the page is refused for being full, not for its version.
  const build = await h(page.page, (x) => x.build);
  const room = await makeRoom();
  const seated = Array.from({ length: MAX_PLAYERS }, (_, k) => new RelayClient(room, `Bot ${k}`, { v: PROTOCOL, build }));
  try {
    await Promise.all(seated.map((c) => c.next('welcome')));
    // The friend types the code next to Join.
    await page.page.locator('#join-code').fill(room);
    await page.page.locator('#join-go').click();
    await expect(page.page.locator('#join-note')).toHaveText(`That game is full (${MAX_PLAYERS} players)`, { timeout: 30_000 });
    await expect(page.page.locator('#loading')).toBeVisible();
    await expect(page.page.locator('#lobby')).toBeHidden();
    expect(new URL(page.page.url()).searchParams.has('room')).toBe(false);
    for (const id of ['#play', '#host', '#join-go']) await expect(page.page.locator(id)).toBeEnabled();
    // A game whose first player is on another build: the friend is told to reload.
    const other = await makeRoom();
    const old = new RelayClient(other, 'Old', { v: PROTOCOL, build: `${build}-old` });
    seated.push(old);
    await old.next('welcome');
    await page.page.locator('#join-code').fill(other);
    await page.page.locator('#join-go').click();
    await expect(page.page.locator('#join-note')).toHaveText('That game is on another version: reload the page', { timeout: 30_000 });
    await expect(page.page.locator('#loading')).toBeVisible();
    await page.page.context().close();
  } finally {
    for (const c of seated) c.close();
  }
});

/** A game hosted from a page of its own: the page (seat 0, Red, the host) and the game's code. */
async function hosted(browser: Browser): Promise<{ host: { page: Page; errors: string[] }; room: string }> {
  const host = await open(browser, `/?relay=${RELAY}`);
  await host.page.locator('#host').click();
  await host.page.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.together.you() === 0, null, { timeout: 30_000 });
  return { host, room: (await h(host.page, (x) => x.together.room()))! };
}

/** A player in Node seated in `room` (of the pages' `build`), pinging as a page does now and then, so the room keeps its seat: it fights by its word alone (the room takes a shooter's claims). */
function bot(room: string, name: string, build: string): { c: RelayClient; stop(): void } {
  const c = new RelayClient(room, name, { v: PROTOCOL, build });
  const pings = setInterval(() => c.say({ t: 'ping', c: Date.now() }), 5_000);
  return { c, stop: () => (clearInterval(pings), c.close()) };
}

/** Until `page`'s room has `n` seated. */
const seatedIn = (page: Page, n: number) => page.waitForFunction((k) => (window as unknown as { __trenchline?: H }).__trenchline?.together?.seats().length === k, n, { timeout: 60_000 });

/** Until the room's clock is past `at` (ms; the relay's is Date.now() on this machine). */
const past = async (at: number) => {
  while (Date.now() < at) await new Promise((r) => setTimeout(r, 100));
};

test('a page that stops lets go of its game: the others see its player leave, and the host role passes on', async ({ browser }) => {
  // The release audit's ROBUST-5: a stopped page kept its socket, a frozen soldier to kill again and again.
  test.setTimeout(300_000);
  const { host, room } = await hosted(browser);
  const friend = await open(browser, `/?room=${room}&relay=${RELAY}`);
  for (const p of [host.page, friend.page]) await seatedIn(p, 2);
  // The host's GPU goes: its page stops, and says so.
  await h(host.page, (x) => x.loseDevice());
  await expect(host.page.locator('#status')).toContainText('graphics device was lost', { timeout: 15_000 });
  await seatedIn(friend.page, 1);
  expect(await h(friend.page, (x) => x.together.owner() === x.together.you())).toBe(true);
  await expect(friend.page.locator('#start')).toBeVisible();
  for (const p of [host, friend]) await p.page.context().close();
});

test('a friend who reloads mid-match comes back on their side, with their kills and deaths', async ({ browser }) => {
  // The release audit's ROBUST-3: they came back on the smaller side, at 0 and 0.
  test.setTimeout(400_000);
  const { host, room } = await hosted(browser);
  const enemy = bot(room, 'Enemy', await h(host.page, (x) => x.build));
  try {
    await enemy.c.next('welcome');
    const friend = await open(browser, `/?room=${room}&relay=${RELAY}`);
    await seatedIn(friend.page, 3);
    const me = await h(friend.page, (x) => x.together.you());
    // The friend picks Blue: Blue has two and Red one, so a newcomer would be put on Red.
    await friend.page.locator('#lobby button[data-team="blue"]').click();
    await host.page.waitForFunction((id) => (window as unknown as { __trenchline: H }).__trenchline.together.seats().find((s) => s.id === id)?.team === 'blue', me);
    await host.page.locator('#match-settings select[name="intensity"]').selectOption('off');
    await expect(host.page.locator('#start')).toBeEnabled({ timeout: 60_000 });
    await host.page.locator('#start').click();
    const start = await enemy.c.next('start');
    // Past the countdown and the spawn's protection, the enemy's round kills the friend.
    await past(start.msg.match.startAt + PROTECT_MS + 500);
    enemy.c.say({ t: 'hit', v: me, z: 'head' });
    await friend.page.waitForFunction((id) => (window as unknown as { __trenchline: H }).__trenchline.together.tallies().some(([s, , d]) => s === id && d === 1), me, { timeout: 15_000 });
    await friend.page.reload();
    await friend.page.waitForFunction(() => (window as unknown as { __trenchline?: H }).__trenchline?.ready === true, null, { timeout: 180_000 });
    await friend.page.waitForFunction(() => {
      const x = (window as unknown as { __trenchline?: H }).__trenchline;
      return (x?.together?.you() ?? -1) >= 0 && x!.together.caughtUp();
    }, null, { timeout: 120_000 });
    expect(await h(friend.page, (x) => x.together.you())).toBe(me);
    expect(await h(friend.page, (x) => x.together.seats().map((s) => [s.id, s.team]))).toContainEqual([me, 'blue']);
    expect(await h(friend.page, (x) => x.together.tallies())).toContainEqual([me, 0, 1]);
    expect(await h(host.page, (x) => x.together.tallies())).toContainEqual([me, 0, 1]);
    for (const p of [host, friend]) await p.page.context().close();
  } finally {
    enemy.stop();
  }
});

test('a map change in the lobby brings everyone back on their side, the host still the host', async ({ browser }) => {
  // The release audit's ROBUST-2: whichever page came back first was host, and the sides were dealt again.
  test.setTimeout(500_000);
  const { host, room } = await hosted(browser);
  const friend = await open(browser, `/?room=${room}&relay=${RELAY}`);
  for (const p of [host.page, friend.page]) await seatedIn(p, 2);
  // The friend joins Red with the host: a newcomer would be put on Blue.
  await friend.page.locator('#lobby button[data-team="red"]').click();
  await host.page.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.together.seats().every((s) => s.team === 'red'));
  await host.page.locator('#match-settings select[name="map"]').selectOption('corridor');
  for (const p of [host.page, friend.page]) {
    await p.waitForURL(/map=corridor/, { timeout: 60_000 });
    await p.waitForFunction(() => (window as unknown as { __trenchline?: H }).__trenchline?.ready === true, null, { timeout: 180_000 });
  }
  for (const p of [host.page, friend.page]) await seatedIn(p, 2);
  expect(await h(host.page, (x) => x.map)).toBe('corridor');
  await host.page.waitForFunction(() => {
    const t = (window as unknown as { __trenchline: H }).__trenchline.together;
    return t.owner() === t.you();
  }, null, { timeout: 30_000 });
  for (const p of [host.page, friend.page]) expect(await h(p, (x) => x.together.seats().map((s) => s.team))).toEqual(['red', 'red']);
  await expect(host.page.locator('#start')).toBeVisible();
  await expect(friend.page.locator('#start')).toBeHidden();
  for (const p of [host, friend]) await p.page.context().close();
});

test('a room gone silent: the page says the line was lost, once a ping has gone unanswered for room_silent_s', async ({ browser }) => {
  // The release audit's ROBUST-7: on a half-open line the others stood as statues, and nothing was said.
  test.setTimeout(300_000);
  const { host, room } = await hosted(browser);
  let mute = false;
  const friend = await open(browser, `/?room=${room}&relay=${RELAY}`, async (context) => {
    await context.routeWebSocket(
      (url) => url.pathname.startsWith('/room/'),
      (ws) => {
        const server = ws.connectToServer();
        ws.onMessage((m) => server.send(m));
        // The room's words to the page, until the line goes quiet.
        server.onMessage((m) => {
          if (!mute) ws.send(m);
        });
      },
    );
  });
  await seatedIn(friend.page, 2);
  await friend.page.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.together.caughtUp(), null, { timeout: 60_000 });
  const t0 = Date.now();
  mute = true;
  await expect(friend.page.locator('#lobby-status')).toContainText('The connection to the game was lost', { timeout: 25_000 });
  const s = (Date.now() - t0) / 1000;
  console.log(`the friend's page said the line was lost ${s.toFixed(1)} s after the room went quiet`);
  // [net] room_silent_s is 10: not before (the first ping after the quiet is the wait's start).
  expect(s).toBeGreaterThan(9.5);
  await expect(friend.page.locator('#leave')).toHaveText('Back to the start');
  for (const p of [host, friend]) await p.page.context().close();
});

test('in the seconds after a win, the way in says who won and that the next match starts in the lobby, with no Go', async ({ browser }) => {
  // The release audit's ROBUST-8: it said the match was on, and offered Go into a finished match.
  test.setTimeout(300_000);
  const { host, room } = await hosted(browser);
  const enemy = bot(room, 'Enemy', await h(host.page, (x) => x.build));
  try {
    await enemy.c.next('welcome');
    const friend = await open(browser, `/?room=${room}&relay=${RELAY}`);
    await seatedIn(host.page, 3);
    // One kill wins; the room's battle quiet.
    await host.page.locator('#match-settings input[name="killTarget"]').fill('1');
    await host.page.locator('#match-settings input[name="killTarget"]').blur();
    await host.page.locator('#match-settings select[name="intensity"]').selectOption('off');
    await expect(friend.page.locator('#match-settings input[name="killTarget"]')).toHaveValue('1');
    await expect(host.page.locator('#start')).toBeEnabled({ timeout: 60_000 });
    await host.page.locator('#start').click();
    const start = await enemy.c.next('start');
    // The friend (Red, with the host) waits on the way in, Go offered.
    await expect(friend.page.locator('#go')).toBeVisible({ timeout: 60_000 });
    await expect(friend.page.locator('#deploy-line')).toHaveText('The match is on. You fight for Red.');
    // The enemy (Blue) kills the host: Blue wins.
    await past(start.msg.match.startAt + PROTECT_MS + 500);
    enemy.c.say({ t: 'hit', v: 0, z: 'head' });
    await enemy.c.next('over', 0, 10_000);
    await expect(friend.page.locator('#deploy-line')).toHaveText('Blue won 1\u20130. The next match starts in the lobby.', { timeout: 5_000 });
    await expect(friend.page.locator('#go')).toBeHidden();
    // The room's lobby, OVER_MS on.
    await friend.page.waitForFunction(() => (window as unknown as { __trenchline: H }).__trenchline.together.phase() === 'lobby', null, { timeout: 20_000 });
    for (const p of [host, friend]) await p.page.context().close();
  } finally {
    enemy.stop();
  }
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
