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
type H = { ready: boolean; together: Together; player(): { position: [number, number, number] }; waitFrames(n: number): Promise<void> };

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
  expect(host.errors).toEqual([]);
  expect(friend.errors).toEqual([]);
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
