import { expect, test, type Page } from '@playwright/test';
import { goIn, groundAt, h, hostAndJoin, ready, sameWorlds, windows, type Compared, type GamePage, type RoomHooks } from './support/room';

// The shared battle (the shared-battle spec; its plan's Task 8), two pages against the relay, as
// fight.spec.ts opens them: one match on the Corridor, its shelling heavy, the room's. Its shells land
// the same on both pages, on the battle's clock; a scoop dug on one is dug on the other; a page that
// reloads mid-match catches up on the room's log and finds the craters and scoops there; and a shell
// that lands on a player kills them, the feed and their fallen line saying so.
//
// The front is each page's own: once a page has deployed (and test 1 has seen it set as the room is),
// it turns its front off (setIntensity('off')), so the players are not shot from the line as they stand
// in the open; the room's shells go on. A page that deploys again (the reload) turns it off again, as
// each deploy sets the room's intensity. Every comparison of the two worlds (sameWorlds) masks blood,
// which each page spatters on its own.

test.describe.configure({ mode: 'serial' });

let A: GamePage;
let B: GamePage;

const says = (c: Compared) => JSON.stringify(c);

/** The page's side, from its seat. */
const teamOf = (page: Page) => h(page, (x) => x.together.seats().find((s) => s.id === x.together.you())?.team ?? null);

/** How far the battle around the page is from the match's clock (s), read in one go. */
const battleOff = (page: Page) => h(page, (x) => Math.abs(x.battle().seconds - x.together.matchSeconds()));

test.beforeAll(async ({ browser }) => {
  test.setTimeout(400_000);
  const { host, friend } = await hostAndJoin(browser, 'corridor', 'heavy');
  A = host;
  B = friend;
  await A.page.locator('#start').click();
});

test.afterAll(async () => {
  await Promise.all(windows.splice(0).map((c) => c.close()));
});

test("the room's shells land the same on both pages, on the battle's clock", async () => {
  test.setTimeout(300_000);
  for (const p of [A.page, B.page]) {
    await p.waitForFunction(() => (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.begun(), null, { timeout: 30_000 });
    // Deployed as the room's intensity says, the front firing from the line across from the page's side.
    const team = await teamOf(p);
    const front = await h(p, (x) => ({ intensity: x.session.front.intensity, side: x.session.frontSide }));
    expect(front, `the front on ${team}'s page`).toEqual({ intensity: 'heavy', side: team === 'red' ? 1 : 0 });
    await h(p, (x) => x.setIntensity('off'));
    await goIn(p);
  }
  expect([await teamOf(A.page), await teamOf(B.page)]).toEqual(['red', 'blue']);
  await A.page.waitForFunction(() => (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.shells().landed.length >= 4, null, { timeout: 90_000 });
  const same = await sameWorlds(A.page, B.page);
  console.log(`after ${same.landed[0].length} shells: the worlds ${same.same ? 'hash the same' : 'differ'} (try ${same.tries}, ${same.masked} voxels of blood masked)`);
  expect(same.same, says(same)).toBe(true);
  expect(same.landed[0].length, says(same)).toBeGreaterThanOrEqual(4);
  expect(same.landed[1], says(same)).toEqual(same.landed[0]);
  for (const p of [A.page, B.page]) {
    await h(p, (x) => x.waitFrames(10));
    expect(await battleOff(p)).toBeLessThan(0.25);
  }
  const hours = [await h(A.page, (x) => x.timeOfDay()), await h(B.page, (x) => x.timeOfDay())];
  expect(Math.abs(hours[0] - hours[1])).toBeLessThan(0.01);
  expect(A.errors).toEqual([]);
  expect(B.errors).toEqual([]);
});

test('a scoop on one page is dug on the other', async () => {
  test.setTimeout(300_000);
  // At the rim of the last crater in no man's land (z 42 to 211.5 m on the Corridor), facing its
  // middle: its loosened ground in the shovel's reach.
  const crater = (await h(A.page, (x) => {
    const landed = x.together.shells().landed;
    return landed.filter((s) => s.at[1] > 50 && s.at[1] < 200).at(-1) ?? landed.at(-1);
  }))!;
  const home = await h(A.page, (x) => x.player().position);
  const rim: [number, number] = [crater.at[0], crater.at[1] - (crater.radius + 0.6)];
  const y = await groundAt(A.page, rim[0], rim[1]);
  expect(y).not.toBeNull();
  const before = await h(A.page, (x) => x.together.digs().sent);
  await h(A.page, (x, a) => x.teleport({ position: a as [number, number, number], yaw: 0, pitch: -20 }), [rim[0], y!, rim[1]]);
  await h(A.page, (x) => x.waitFrames(10));
  await A.page.keyboard.down('KeyF');
  await A.page.waitForTimeout(3000);
  await A.page.keyboard.up('KeyF');
  const sent = (await h(A.page, (x) => x.together.digs().sent)) - before;
  console.log(`a scoop on one page: ${sent} sent from the rim of shell ${crater.id}'s crater (radius ${crater.radius} m)`);
  expect(sent).toBeGreaterThan(0);
  // Out of the open, back where it stood.
  await h(A.page, (x, a) => x.teleport({ position: a as [number, number, number], yaw: 0, pitch: 0 }), home);
  await B.page.waitForFunction((n) => (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.digs().heard === n, before + sent, { timeout: 15_000 });
  expect(await h(B.page, (x) => x.together.digs().heard)).toBe(await h(A.page, (x) => x.together.digs().sent));
  const same = await sameWorlds(A.page, B.page);
  console.log(`after the scoops, ${same.landed[0].length} shells: the worlds ${same.same ? 'hash the same' : 'differ'} (try ${same.tries}, ${same.masked} voxels of blood masked)`);
  expect(same.same, says(same)).toBe(true);
  expect(A.errors).toEqual([]);
  expect(B.errors).toEqual([]);
});

test('a reload mid-match finds the craters and scoops there', async () => {
  test.setTimeout(400_000);
  // Watching from the reload's first script: whether Go is ever offered (drawn: its section shows only
  // on the deploy screen) before the page has caught up.
  await B.page.addInitScript(() => {
    const w = window as unknown as { __trenchline?: RoomHooks; __goEarly: number; __goSeen: boolean };
    w.__goEarly = 0;
    w.__goSeen = false;
    const look = () => {
      const go = document.getElementById('go');
      if (go?.checkVisibility()) {
        w.__goSeen = true;
        if (!w.__trenchline?.together?.caughtUp?.()) w.__goEarly++;
      }
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
  const logged = await h(A.page, (x) => x.together.shells().landed.length);
  const t0 = Date.now();
  await B.page.reload();
  await ready(B.page);
  await B.page.waitForFunction(() => (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.begun(), null, { timeout: 60_000 });
  await expect(B.page.locator('#go')).toBeVisible({ timeout: 300_000 });
  const caughtUp = await h(B.page, (x) => x.together.caughtUp());
  const watched = await B.page.evaluate(() => {
    const w = window as unknown as { __goEarly: number; __goSeen: boolean };
    return { early: w.__goEarly, seen: w.__goSeen };
  });
  console.log(`B reloaded with ${logged} shells logged: Go offered ${((Date.now() - t0) / 1000).toFixed(1)} s after the reload`);
  expect(caughtUp).toBe(true);
  expect(watched).toEqual({ early: 0, seen: true });
  await h(B.page, (x) => x.setIntensity('off'));
  await goIn(B.page);
  await h(B.page, (x) => x.waitFrames(30));
  expect(await battleOff(B.page)).toBeLessThan(0.25);
  const same = await sameWorlds(A.page, B.page);
  console.log(`after the reload, ${same.landed[0].length} shells: the worlds ${same.same ? 'hash the same' : 'differ'} (try ${same.tries}, ${same.masked} voxels of blood masked)`);
  expect(same.same, says(same)).toBe(true);
  expect(same.landed[0].length, says(same)).toBeGreaterThanOrEqual(logged);
  expect(same.landed[1], says(same)).toEqual(same.landed[0]);
  expect(A.errors).toEqual([]);
  expect(B.errors).toEqual([]);
});

test('a shell kills: the feed says shelled', async () => {
  test.setTimeout(180_000);
  // B, in play and long past its protection, stands where the next shell will land while it is still
  // more than a second away.
  expect(await h(B.page, (x) => x.together.deadFor())).toBeNull();
  const stood = await h(B.page, async (x) => {
    const t0 = performance.now();
    for (;;) {
      const next = x.together.shells().next;
      if (next && next.landsInS > 1) {
        const [gx, gz] = next.at.map((m) => Math.floor(m / 0.1));
        let y = 319;
        while (y > 0 && (x.world.map.get(gx, y, gz) === 0 || x.world.map.get(gx, y, gz) === 34)) y--;
        x.teleport({ position: [next.at[0], (y + 1) * 0.1 + 0.05, next.at[1]], yaw: 0, pitch: 0 });
        return { at: next.at, landsInS: next.landsInS };
      }
      if (performance.now() - t0 > 30_000) return null;
      await x.waitFrames(1);
    }
  });
  expect(stood).not.toBeNull();
  await B.page.waitForFunction(() => (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.deadFor() !== null, null, { timeout: 10_000 });
  console.log(`B stood where a shell landed ${stood!.landsInS.toFixed(2)} s later, at ${stood!.at.join(', ')}, and died of it`);
  await expect(A.page.locator('#hud .feed')).toContainText('shelled');
  await expect(B.page.locator('#hud .fallen')).toContainText('Killed by the shelling');
  expect(A.errors).toEqual([]);
  expect(B.errors).toEqual([]);
});
