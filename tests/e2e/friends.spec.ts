import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { SHELL_FIELDS } from '../../src/net/shell-fields';
import { goIn, groundAt, h, hostAndJoin, ready, sameWorlds, windows, type Compared, type GamePage, type RoomHooks } from './support/room';

// The paths friends take (the final review's item 15, Task 8b), two pages against the relay on one
// room on the Corridor, its shelling heavy, through three matches:
//
// 1. Deploy: each page at a start of its team's (SHELL_FIELDS, the room's pin), the room's front set and
//    no shells of the visitor's (artillery off, seen before anything sets it), the battle around the
//    page (the battle() hook's seconds) at 0 through the countdown.
// 2. The deploy screen: B stays on it through landings, its world running and the same as A's; A never
//    draws it, and it is never hurt: not even with its body where a shell lands and in the front's
//    sight, whose harm its session reckons but neither tells the room nor shows. Spawn: A, in play at
//    its start with the room's heavy front on, is never hurt; then both, for 30 s more.
// 3. The crest: A crouched on its bay's firing step, the front at light from 185 m firing at it all
//    the while (its rounds counted), is never hurt in 20 s.
// 4. Kills: the front kills B in the open, and the feed says "shot from the line"; A's rounds kill B,
//    and the worlds compare the same with the blood A's page spattered masked.
// 5. The end with a shell in the air and a scoop just dug: no blast and no harm after it, the shell in
//    both pages' last match, the battle the visitor's again; the rematch's ids run on, the scoop is in
//    on B, and the worlds are the same once the rematch has settled.
// 6. A reload in the lobby after a match: the next match's worlds the same, but for the last matches'
//    chars, which a catch-up does not make (the spec's note 5: masked, each char on one page alone).
// 7. A dropped line (page.routeWebSocket closes B's socket): the lost line stays said, the battle the
//    visitor's again; a reload rejoins, and the worlds are the same (the earlier matches' chars masked).

test.describe.configure({ mode: 'serial' });

let A: GamePage;
let B: GamePage;
/** Drops B's line, both ways, as a network gone would: its socket's route (page.routeWebSocket), the latest. */
let dropB: (() => Promise<void>) | null = null;

const says = (c: Compared) => JSON.stringify(c);

/** The page's side, from its seat. */
const teamOf = (page: Page) => h(page, (x) => x.together.seats().find((s) => s.id === x.together.you())?.team ?? null);

/** What the room's battle has done to the page's player: hurts told the room, red flashes, alive, dead for. */
const harmOf = (page: Page) => h(page, (x) => ({ hurts: x.together.hurts(), flashes: x.hitFeedback().flashes, alive: x.session.alive, dead: x.together.deadFor() }));

/** The page's front and shells, and the visitor's settings: { front, side, artillery, settings }. */
const battleOf = (page: Page) => h(page, (x) => ({ front: x.session.front.intensity, side: x.session.frontSide, artillery: x.session.artillery.intensity, settings: x.settings().intensity }));

/** Waits `ms` of the page's time in frames. */
const hold = (page: Page, ms: number) => page.waitForTimeout(ms);

/** Each page's front set here, not through setIntensity (which sets the artillery too: in a room it must stay off). */
const front = (page: Page, i: 'off' | 'light' | 'heavy') =>
  h(
    page,
    (x, a) => {
      x.session.front.intensity = a as 'off' | 'light' | 'heavy';
    },
    i,
  );

/** Back in after being killed, if killed: once the page's player is alive again. */
const alive = (page: Page) => page.waitForFunction(() => (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.deadFor() === null, null, { timeout: 20_000 });

/** Into a match the owner (A) starts now: both pages begun and gone in. */
async function rematch(): Promise<void> {
  await expect(A.page.locator('#start')).toBeEnabled({ timeout: 120_000 });
  await A.page.locator('#start').click();
  for (const p of [A.page, B.page]) await goIn(p);
}

/** Into the open at the rim of the latest crater in no man's land (z 50 to 200 m on the Corridor), facing its middle: loosened ground in the shovel's reach. */
async function toCraterRim(page: Page): Promise<{ id: number; at: [number, number] }> {
  const crater = await h(page, (x) => {
    const landed = x.together.shells().landed;
    return landed.filter((s) => s.at[1] > 50 && s.at[1] < 200).at(-1) ?? null;
  });
  expect(crater, 'a crater in no man\'s land').not.toBeNull();
  const rim: [number, number] = [crater!.at[0], crater!.at[1] - (crater!.radius + 0.6)];
  const y = await groundAt(page, rim[0], rim[1]);
  expect(y).not.toBeNull();
  await h(page, (x, a) => x.teleport({ position: a as [number, number, number], yaw: 0, pitch: -20 }), [rim[0], y!, rim[1]]);
  await h(page, (x) => x.waitFrames(10));
  return { id: crater!.id, at: crater!.at };
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(400_000);
  // B's sockets routed through Playwright, passed through as they are until the test drops one.
  const friendWindow = async (context: BrowserContext) => {
    await context.routeWebSocket(
      (url) => url.pathname.startsWith('/room/'),
      (ws) => {
        const server = ws.connectToServer();
        dropB = async () => {
          await server.close({ code: 1001, reason: 'gone' });
          await ws.close({ code: 4000, reason: 'gone' });
        };
      },
    );
  };
  const { host, friend } = await hostAndJoin(browser, 'corridor', 'heavy', friendWindow);
  A = host;
  B = friend;
});

test.afterAll(async () => {
  await Promise.all(windows.splice(0).map((c) => c.close()));
});

test("deploy: each at a start of its team's, the room's front set, no shells of the visitor's, the battle at 0 through the countdown", async () => {
  test.setTimeout(120_000);
  // Watched from before the start until the match has begun, every frame: before anything sets it.
  for (const p of [A.page, B.page]) {
    await h(p, (x) => {
      const w = window as unknown as { __deploy: { frames: number; battle: number[]; artillery: string[]; front: string[]; feet: [number, number, number] | null; after: string[]; afterFrames: number } };
      const seen = (w.__deploy = { frames: 0, battle: [], artillery: [], front: [], feet: null, after: [], afterFrames: 0 } as typeof w.__deploy);
      const look = () => {
        if (x.together.phase() === 'playing' && !x.together.begun()) {
          seen.frames++;
          const b = x.battle().seconds;
          if (!seen.battle.includes(b)) seen.battle.push(b);
          if (!seen.artillery.includes(x.session.artillery.intensity)) seen.artillery.push(x.session.artillery.intensity);
          const f = `${x.session.front.intensity}/${x.session.frontSide}`;
          if (!seen.front.includes(f)) seen.front.push(f);
          seen.feet = x.player().position;
        }
        if (x.together.begun()) {
          // And for a second's frames after: the shells still the room's alone.
          const a = x.session.artillery.intensity;
          if (!seen.after.includes(a)) seen.after.push(a);
          if (++seen.afterFrames < 60) requestAnimationFrame(look);
          return;
        }
        requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    });
  }
  await A.page.locator('#start').click();
  for (const p of [A.page, B.page]) await p.waitForFunction(() => (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.begun(), null, { timeout: 30_000 });
  await hold(A.page, 1500);
  expect([await teamOf(A.page), await teamOf(B.page)]).toEqual(['red', 'blue']);
  // The room's pin of the Corridor's starts: Red's four, then Blue's; each page's player the first of its team's.
  const spawns = SHELL_FIELDS.corridor.spawns;
  for (const [p, team, start] of [[A.page, 'red', spawns[0]], [B.page, 'blue', spawns[4]]] as const) {
    const seen = await p.evaluate(() => (window as unknown as { __deploy: { frames: number; battle: number[]; artillery: string[]; front: string[]; feet: [number, number, number] | null; after: string[] } }).__deploy);
    console.log(`${team}'s deploy: ${seen.frames} frames of countdown, the battle at ${seen.battle.join(', ')} s, the shells ${seen.artillery.join(', ')}, the front ${seen.front.join(', ')}, the feet at ${seen.feet?.map((v) => v.toFixed(3)).join(', ')}`);
    expect(seen.frames, team).toBeGreaterThan(10);
    expect(seen.artillery, team).toEqual(['off']);
    expect(seen.after, team).toEqual(['off']);
    expect(seen.battle, team).toEqual([0]);
    expect(seen.front, team).toEqual([`heavy/${team === 'red' ? 1 : 0}`]);
    expect(Math.hypot(seen.feet![0] - start[0], seen.feet![2] - start[1]), `${team}'s feet from its start`).toBeLessThanOrEqual(0.01);
  }
  expect(A.errors).toEqual([]);
  expect(B.errors).toEqual([]);
});

test("the deploy screen: B's world runs there and is A's, A never draws it, it is never hurt, even under a shell and in the front's sight; A at its start under the heavy front takes nothing, nor both for 30 s more", async () => {
  test.setTimeout(300_000);
  await goIn(A.page);
  const t0 = { a: await harmOf(A.page), b: await harmOf(B.page), ticks: await h(B.page, (x) => x.session.ticks), landed: await h(A.page, (x) => x.together.shells().landed.length), feet: await h(A.page, (x) => x.player().position) };
  expect([t0.a.alive, t0.a.dead, t0.b.alive, t0.b.dead]).toEqual([true, null, true, null]);
  // On A, every frame: whether B is among the others drawn.
  await h(A.page, (x, you) => {
    const w = window as unknown as { __listed: { frames: number; b: number } };
    const seen = (w.__listed = { frames: 0, b: 0 });
    const look = () => {
      seen.frames++;
      if (x.together.others().some((o) => o.id === (you as number))) seen.b++;
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  }, await h(B.page, (x) => x.together.you()));
  await hold(A.page, 30_000);
  const landed = (await h(A.page, (x) => x.together.shells().landed.length)) - t0.landed;
  const listed = await A.page.evaluate(() => (window as unknown as { __listed: { frames: number; b: number } }).__listed);
  const ticks = (await h(B.page, (x) => x.session.ticks)) - t0.ticks;
  const t1 = { a: await harmOf(A.page), b: await harmOf(B.page), feet: await h(A.page, (x) => x.player().position) };
  console.log(`B on the deploy screen 30 s: ${landed} shells landed, its session ${ticks} ticks on; A drew B in ${listed.b} of ${listed.frames} frames; A ${JSON.stringify(t1.a)} (was ${JSON.stringify(t0.a)}), B ${JSON.stringify(t1.b)}; A moved ${Math.hypot(t1.feet[0] - t0.feet[0], t1.feet[2] - t0.feet[2]).toFixed(3)} m`);
  expect(landed).toBeGreaterThanOrEqual(2);
  expect(ticks).toBeGreaterThan(0);
  expect(listed.frames).toBeGreaterThan(100);
  expect(listed.b).toBe(0);
  // B, not in it: no hurt told, no red flash, alive. A, at its start: nothing either.
  expect(t1.b).toEqual(t0.b);
  expect(t1.a).toEqual(t0.a);
  await expect(B.page.locator('#go')).toBeVisible();
  // B's body in the battle's reach, still on the deploy screen. At its start nothing reaches it (no
  // shell lands within spawn_clear_m of a start, and the front sees no one there), so it is put where
  // they do: first where the next shell told will land, as soon as it is told (its blast's reach);
  // then in the open 25 m out from Red's line, whose front fires at Blue, until a round of it strikes.
  // Its session reckons that harm (harmed), but none is told the room (Together.after: not in play),
  // none is felt (HitFeedback.frame's `felt`, false on the deploy screen), and A draws it nowhere.
  const r0 = { b: await harmOf(B.page), harmed: await h(B.page, (x) => x.together.harmed()) };
  let struck: { id: number; at: [number, number] } | null = null;
  for (let tries = 0; tries < 3 && !struck; tries++) {
    const target = await h(B.page, async (x) => {
      const t0 = performance.now();
      const seen = new Set(x.together.shells().landed.map((s) => s.id));
      for (;;) {
        const next = x.together.shells().next;
        const top = next ? x.footAt(next.at[0], next.at[1]) : null;
        if (next && !seen.has(next.id) && next.landsInS > 1.2 && top !== null) {
          x.teleport({ position: [next.at[0], top + 0.05, next.at[1]], yaw: 0, pitch: 0 });
          return { id: next.id, at: next.at };
        }
        if (performance.now() - t0 > 30_000) return null;
        await x.waitFrames(1);
      }
    });
    if (!target) continue;
    await B.page.waitForFunction((id) => (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.shells().landed.some((s) => s.id === id), target.id, { timeout: 10_000 });
    await hold(B.page, 500);
    struck = target;
  }
  expect(struck, 'a shell landed where B stood on the deploy screen').not.toBeNull();
  const shelled = { b: await harmOf(B.page), harmed: await h(B.page, (x) => x.together.harmed()), at: await h(B.page, (x) => x.player().position) };
  const blast = `shell ${struck!.id} landed ${Math.hypot(shelled.at[0] - struck!.at[0], shelled.at[2] - struck!.at[1]).toFixed(2)} m off, its session reckoning ${shelled.harmed.shell.n - r0.harmed.shell.n} blast(s) of ${(shelled.harmed.shell.hp - r0.harmed.shell.hp).toFixed(0)} hp and ${shelled.harmed.round.n - r0.harmed.round.n} round(s) of the front's; B ${JSON.stringify(shelled.b)} (was ${JSON.stringify(r0.b)})`;
  // In its reach: the session reckoned the blast's harm. None told, felt or fatal.
  expect(shelled.harmed.shell.n, blast).toBeGreaterThan(r0.harmed.shell.n);
  expect(shelled.harmed.shell.hp, blast).toBeGreaterThan(r0.harmed.shell.hp);
  expect(shelled.b, blast).toEqual(r0.b);
  expect(await h(B.page, (x) => x.together.shells().landed.map((s) => s.id))).toContain(struck!.id);
  const red = SHELL_FIELDS.corridor.spawns[0];
  const open = await groundAt(B.page, red[0], red[1] + 25);
  await h(B.page, (x, a) => x.teleport({ position: a as [number, number, number], yaw: 0, pitch: 0 }), [red[0], open!, red[1] + 25]);
  await B.page.waitForFunction((n) => (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.harmed().round.n > (n as number), shelled.harmed.round.n, { timeout: 60_000 });
  await hold(B.page, 500);
  const fronted = { b: await harmOf(B.page), harmed: await h(B.page, (x) => x.together.harmed()) };
  const listedInReach = await A.page.evaluate(() => (window as unknown as { __listed: { frames: number; b: number } }).__listed);
  console.log(`B on the deploy screen in the battle's reach: ${blast}; then in the front's sight, its rounds ${fronted.harmed.round.n - shelled.harmed.round.n} of ${(fronted.harmed.round.hp - shelled.harmed.round.hp).toFixed(0)} hp; B ${JSON.stringify(fronted.b)}; A drew B in ${listedInReach.b} of ${listedInReach.frames} frames`);
  // In the front's sight: the session reckoned its round's harm. None told, felt or fatal; and A drew B nowhere.
  expect(fronted.harmed.round.n).toBeGreaterThan(shelled.harmed.round.n);
  expect(fronted.b).toEqual(r0.b);
  expect(listedInReach.b).toBe(0);
  await expect(B.page.locator('#go')).toBeVisible();
  // Back at its start: Go puts the player in play where its body stands.
  const blue = SHELL_FIELDS.corridor.spawns[4];
  await h(B.page, (x, s) => x.teleport({ position: [(s as number[])[0], x.footAt((s as number[])[0], (s as number[])[1])! + 0.05, (s as number[])[1]], yaw: 0, pitch: 0 }), blue);
  const same = await sameWorlds(A.page, B.page);
  console.log(`B on the deploy screen, ${same.landed[0].length} shells: the worlds ${same.same ? 'hash the same' : 'differ'} (try ${same.tries}, ${same.masked} voxels of blood masked; seconds ${JSON.stringify(same.seconds)})`);
  expect(same.same, says(same)).toBe(true);
  expect(same.landed[1], says(same)).toEqual(same.landed[0]);
  expect(same.landed[0].length, says(same)).toBeGreaterThanOrEqual(2);
  await expect(B.page.locator('#go')).toBeVisible();
  // Both at their starts, in play, 30 s more of the room's heavy front.
  await goIn(B.page);
  const t2 = { a: await harmOf(A.page), b: await harmOf(B.page) };
  await hold(A.page, 30_000);
  const t3 = { a: await harmOf(A.page), b: await harmOf(B.page) };
  console.log(`both at their starts 30 s on heavy: A ${JSON.stringify(t3.a)}, B ${JSON.stringify(t3.b)}`);
  expect(await battleOf(A.page)).toMatchObject({ front: 'heavy', side: 1, artillery: 'off' });
  expect(await battleOf(B.page)).toMatchObject({ front: 'heavy', side: 0, artillery: 'off' });
  expect(t3).toEqual(t2);
  expect(A.errors).toEqual([]);
  expect(B.errors).toEqual([]);
});

test("the crest: crouched on the firing step, the front at light from 185 m firing at it, A takes no hurt in 20 s", async () => {
  test.setTimeout(180_000);
  // The step of A's bay (views.step: the eye over the step's top, standing): Red's first start's bay, 185 m from the enemy's front line.
  const step = await h(A.page, (x) => x.views.step);
  const start = SHELL_FIELDS.corridor.spawns[0];
  expect(Math.hypot(step.position[0] - start[0], step.position[2] - start[1])).toBeLessThan(8);
  // Crouched first, in the bay, then onto the step: never stood there.
  await A.page.keyboard.press('KeyC');
  await A.page.waitForFunction(() => (window as unknown as { __trenchline: RoomHooks }).__trenchline.player().stance === 1, null, { timeout: 5000 });
  await front(A.page, 'light');
  await h(A.page, (x, s) => {
    const v = s as { position: [number, number, number]; yaw: number };
    x.teleport({ position: [v.position[0], v.position[1] - 1.62 + 0.02, v.position[2]], yaw: v.yaw, pitch: 0 });
  }, step);
  await hold(A.page, 1000);
  const t0 = await harmOf(A.page);
  const shot0 = await h(A.page, (x) => ({ cracks: x.audio().kinds.crack ?? 0, fired: x.session.front.fired }));
  await hold(A.page, 20_000);
  const t1 = await harmOf(A.page);
  const shot1 = await h(A.page, (x) => ({ cracks: x.audio().kinds.crack ?? 0, fired: x.session.front.fired }));
  const [fired, cracks] = [shot1.fired - shot0.fired, shot1.cracks - shot0.cracks];
  const where = await h(A.page, (x) => ({ stance: x.player().stance, position: x.player().position }));
  console.log(`crouched on the step 20 s, the front at light: it fired ${fired} rounds at A, ${cracks} cracking by; ${JSON.stringify(t1)} (was ${JSON.stringify(t0)}), at ${where.position.map((v) => v.toFixed(2)).join(', ')}`);
  expect(where.stance).toBe(1);
  expect(Math.abs(where.position[1] - (step.position[1] - 1.62))).toBeLessThan(0.1);
  // The front fired at A all the while (light: 40 a minute, so about 13 in 20 s), and none hurt.
  expect(fired).toBeGreaterThanOrEqual(5);
  expect(t1).toEqual(t0);
  // Back down in the bay at its start, standing, the front at the room's.
  await A.page.keyboard.press('KeyC');
  await front(A.page, 'heavy');
  await h(A.page, (x, s) => x.teleport({ position: [(s as number[])[0], x.footAt((s as number[])[0], (s as number[])[1])! + 0.05, (s as number[])[1]], yaw: 0, pitch: 0 }), start);
  expect(A.errors).toEqual([]);
});

test('kills: the front\'s reads "shot from the line"; a round\'s spatters, and the worlds compare the same with that blood masked', async () => {
  test.setTimeout(240_000);
  await alive(B.page);
  // B in the open 25 m out from Red's line, standing, its front (Red's line, firing at Blue) heavy.
  const start = SHELL_FIELDS.corridor.spawns[0];
  let killedBy = '';
  for (let tries = 0; tries < 3 && !killedBy.includes('shot from the line'); tries++) {
    await alive(B.page);
    const y = await groundAt(B.page, start[0], start[1] + 25);
    await h(B.page, (x, a) => x.teleport({ position: a as [number, number, number], yaw: 0, pitch: 0 }), [start[0], y!, start[1] + 25]);
    await front(B.page, 'heavy');
    await B.page.waitForFunction(() => (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.deadFor() !== null, null, { timeout: 60_000 });
    await hold(A.page, 500);
    killedBy = (await A.page.locator('#hud .feed').textContent()) ?? '';
    console.log(`B in the open: killed; A's feed says "${killedBy}"`);
  }
  expect(killedBy).toContain('shot from the line');
  await expect(B.page.locator('#hud .fallen')).toContainText('Shot from the line');
  await front(B.page, 'off');
  await front(A.page, 'off');
  // A's rounds: A prone in the open at no man's land's middle, B standing 1.2 to 1.8 m off on ground
  // as high as A's, A tapping at its chest until it falls: steeply up. B's spot is chosen so that the
  // line from A's eye through B's chest, and lines 2 degrees about it (the gun's spread, and its climb),
  // meet no voxel between them, nor from just past B to the top of the world: a round that passes B,
  // on either page, leaves the world chipping nothing. A chip is in no log, so a page that reloads
  // later has none of them (the spec's Deferred: a join does not catch up on chips), and a round one
  // page stops in B's body and the other flies on is note 12's accepted drift.
  await alive(B.page);
  const at = await h(A.page, (x) => {
    const v = x.views['nml-night'].position;
    return [v[0], x.footAt(v[0], v[2])!, v[2]] as [number, number, number];
  });
  const spot = await h(A.page, (x, a) => {
    const [ax, ay, az] = a as number[];
    const map = x.world.map as unknown as { dims: { x: number; y: number; z: number }; inBounds(x: number, y: number, z: number): boolean; get(x: number, y: number, z: number): number };
    const v = x.session.voxel;
    const top = map.dims.y * v;
    /** Whether the segment from `p` along unit `d` for `len` metres (to the world's top if null) meets no voxel. */
    const clear = (p: number[], d: number[], len: number | null) => {
      for (let t = 0; len === null || t <= len; t += v / 2) {
        const q = [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t];
        if (q[1] > top) return true;
        const c = [Math.floor(q[0] / v), Math.floor(q[1] / v), Math.floor(q[2] / v)];
        if (!map.inBounds(c[0], Math.max(0, c[1]), c[2])) return true;
        if (c[1] >= 0 && map.get(c[0], c[1], c[2]) !== 0) return false;
      }
      return true;
    };
    const unit = (yaw: number, pitch: number) => {
      const [y, p] = [(yaw * Math.PI) / 180, (pitch * Math.PI) / 180];
      return [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)];
    };
    const eye = [ax, ay + 0.34, az];
    for (const r of [1.2, 1.5, 1.8]) {
      for (let k = 0; k < 16; k++) {
        const bx = ax + r * Math.sin((k * Math.PI) / 8);
        const bz = az + r * Math.cos((k * Math.PI) / 8);
        const ground = x.footAt(bx, bz);
        if (ground === null || Math.abs(ground - ay) > 0.4) continue;
        const chest = [bx, ground + 1.25, bz];
        const f = [chest[0] - eye[0], chest[1] - eye[1], chest[2] - eye[2]];
        const yaw = (Math.atan2(f[0], f[2]) * 180) / Math.PI;
        const pitch = (Math.atan2(f[1], Math.hypot(f[0], f[2])) * 180) / Math.PI;
        const reach = Math.hypot(f[0], f[1], f[2]);
        const ok = [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2], [1.4, 1.4], [-1.4, 1.4], [1.4, -1.4], [-1.4, -1.4]].every(([dy, dp]) => {
          const d = unit(yaw + dy, pitch + dp);
          const from = [eye[0] + d[0] * 0.3, eye[1] + d[1] * 0.3, eye[2] + d[2] * 0.3];
          return clear(from, d, reach - 0.3) && clear([eye[0] + d[0] * (reach + 0.4), eye[1] + d[1] * (reach + 0.4), eye[2] + d[2] * (reach + 0.4)], d, null);
        });
        if (ok) return { b: [bx, ground, bz] as [number, number, number], r, yaw, pitch };
      }
    }
    return null;
  }, at);
  expect(spot, "a spot for B whose rounds past it leave the world").not.toBeNull();
  const bAt: [number, number] = [spot!.b[0], spot!.b[2]];
  await h(B.page, (x, a) => {
    const s = a as { b: number[]; yaw: number };
    x.teleport({ position: [s.b[0], s.b[1] + 0.05, s.b[2]], yaw: s.yaw + 180, pitch: 0 });
  }, spot);
  await h(A.page, (x, a) => {
    const [p, yaw] = a as [number[], number];
    x.teleport({ position: [p[0], p[1] + 0.05, p[2]], yaw, pitch: 0 });
  }, [at, spot!.yaw]);
  await A.page.keyboard.press('KeyZ');
  await A.page.waitForFunction(() => (window as unknown as { __trenchline: RoomHooks }).__trenchline.player().stance === 2, null, { timeout: 5000 });
  await A.page.waitForFunction(
    (b) => {
      const seen = (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.others()[0];
      return seen !== undefined && Math.hypot(seen.position[0] - (b as number[])[0], seen.position[2] - (b as number[])[1]) < 0.3;
    },
    bAt,
    { timeout: 10_000 },
  );
  await hold(A.page, 800);
  const aim = await h(A.page, (x) => {
    const me = x.player().position;
    const them = x.together.others()[0].position;
    const dy = them[1] + 1.25 - (me[1] + 0.34);
    const d = Math.hypot(them[0] - me[0], them[2] - me[2]);
    const pitch = (Math.atan2(dy, d) * 180) / Math.PI;
    x.teleport({ position: me, yaw: (Math.atan2(them[0] - me[0], them[2] - me[2]) * 180) / Math.PI, pitch });
    return { pitch, d, dy, me, them };
  });
  await hold(A.page, 200);
  const t0 = Date.now();
  let dead = false;
  while (!dead && Date.now() - t0 < 15_000) {
    await h(A.page, async (x) => {
      x.trigger(true);
      await x.waitFrames(1);
      x.trigger(false);
    });
    await hold(A.page, 350);
    dead = (await h(B.page, (x) => x.together.deadFor())) !== null;
  }
  console.log(`A prone, aimed ${aim.pitch.toFixed(1)} degrees up at B's chest ${aim.d.toFixed(2)} m off and ${aim.dy.toFixed(2)} m over the eye (A at ${aim.me.map((v) => v.toFixed(2)).join(', ')}, B drawn at ${aim.them.map((v) => v.toFixed(2)).join(', ')}; the spot's line ${spot!.pitch.toFixed(1)} degrees up): B ${dead ? 'killed' : 'standing'} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  // On level ground, as the spot was chosen, and the aim within a degree of the line found clear.
  expect(Math.abs(aim.pitch - spot!.pitch)).toBeLessThan(1);
  expect(dead).toBe(true);
  await expect(A.page.locator('#hud .feed')).toContainText('shot');
  // Out of the open, both, once B is back; A on its feet.
  await A.page.keyboard.press('KeyZ');
  await alive(B.page);
  for (const [p, s] of [[A.page, SHELL_FIELDS.corridor.spawns[0]], [B.page, SHELL_FIELDS.corridor.spawns[4]]] as const) {
    await h(p, (x, a) => x.teleport({ position: [(a as number[])[0], x.footAt((a as number[])[0], (a as number[])[1])! + 0.05, (a as number[])[1]], yaw: 0, pitch: 0 }), s);
  }
  const same = await sameWorlds(A.page, B.page);
  console.log(`after a round's kill, ${same.landed[0].length} shells: the worlds ${same.same ? 'hash the same' : 'differ'} (try ${same.tries}, ${same.masked} voxels of blood masked)`);
  expect(same.masked, says(same)).toBeGreaterThan(0);
  expect(same.same, says(same)).toBe(true);
  expect(A.errors).toEqual([]);
  expect(B.errors).toEqual([]);
});

test('the end with a shell in the air over B and a scoop just dug: no blast, no harm, the shell landed on both, the battle the visitor\'s; the rematch runs on its ids, the scoop in on B', async () => {
  test.setTimeout(300_000);
  await alive(A.page);
  await alive(B.page);
  for (const p of [A.page, B.page]) await front(p, 'off');
  // A digs at a crater's rim, and goes on digging until the end.
  const sent0 = await h(A.page, (x) => x.together.digs().sent);
  await toCraterRim(A.page);
  await A.page.keyboard.down('KeyF');
  await A.page.waitForFunction((n) => (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.digs().sent > (n as number), sent0, { timeout: 30_000 });
  /** What the page heard and felt: blast voices, hurts told the room, red flashes; alive, and dead for. */
  const felt = (p: Page) => h(p, (x) => ({ blasts: x.audio().kinds.blast ?? 0, hurts: x.together.hurts(), flashes: x.hitFeedback().flashes, alive: x.session.alive, dead: x.together.deadFor() }));
  // B stands where the next shell told will land, as soon as it is told; then A ends the match, with it
  // still in the air: landed by the end, quietly, it would have killed B.
  let ended: { id: number; at: [number, number]; landsInS: number; sent: number } | null = null;
  let before: { a: Awaited<ReturnType<typeof felt>>; b: Awaited<ReturnType<typeof felt>> } | null = null;
  for (let tries = 0; tries < 5 && !ended; tries++) {
    const target = await h(B.page, async (x) => {
      const t0 = performance.now();
      const seen = new Set(x.together.shells().landed.map((s) => s.id));
      for (;;) {
        const next = x.together.shells().next;
        const top = next ? x.footAt(next.at[0], next.at[1]) : null;
        if (next && !seen.has(next.id) && next.landsInS > 1.2 && top !== null) {
          x.teleport({ position: [next.at[0], top + 0.05, next.at[1]], yaw: 0, pitch: 0 });
          return { id: next.id, at: next.at };
        }
        if (performance.now() - t0 > 30_000) return null;
        await x.waitFrames(1);
      }
    });
    if (!target) continue;
    before = { a: await felt(A.page), b: await felt(B.page) };
    ended = await h(
      A.page,
      (x, t) => {
        const next = x.together.shells().next;
        if (!next || next.id !== (t as { id: number }).id || next.landsInS < 0.3) return null;
        x.together.end();
        return { id: next.id, at: next.at, landsInS: next.landsInS, sent: x.together.digs().sent };
      },
      target,
    );
  }
  await A.page.keyboard.up('KeyF');
  expect(ended, 'a shell in the air over B at the end').not.toBeNull();
  for (const p of [A.page, B.page]) await p.waitForFunction(() => (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.phase() === 'lobby', null, { timeout: 10_000 });
  // Past when it would have landed.
  await hold(A.page, 3000);
  const after = { a: await felt(A.page), b: await felt(B.page) };
  const last = [await h(A.page, (x) => x.together.lastLanded()), await h(B.page, (x) => x.together.lastLanded())];
  const bAt = await h(B.page, (x) => x.player().position);
  console.log(`ended with shell ${ended!.id} over B (${Math.hypot(bAt[0] - ended!.at[0], bAt[2] - ended!.at[1]).toFixed(2)} m off), ${ended!.landsInS.toFixed(2)} s from landing, ${ended!.sent - sent0} scoops dug: A ${JSON.stringify(after.a)} (was ${JSON.stringify(before!.a)}), B ${JSON.stringify(after.b)} (was ${JSON.stringify(before!.b)}); last landed ${last[0].slice(-3).join(', ')} and ${last[1].slice(-3).join(', ')}`);
  // The blasts were heard before (the check is not of a page gone deaf), and none after: no harm either.
  expect(before!.a.blasts).toBeGreaterThan(0);
  expect(before!.b.blasts).toBeGreaterThan(0);
  expect(after).toEqual(before);
  expect(Math.hypot(bAt[0] - ended!.at[0], bAt[2] - ended!.at[1])).toBeLessThan(0.5);
  expect(last[0]).toContain(ended!.id);
  expect(last[1]).toContain(ended!.id);
  expect(last[1]).toEqual(last[0]);
  for (const p of [A.page, B.page]) {
    const b = await battleOf(p);
    expect(b, "the battle the visitor's again").toEqual({ front: b.settings, side: 1, artillery: b.settings, settings: b.settings });
  }
  // Every scoop A dug, the last just before the end, relayed to B.
  await B.page.waitForFunction((n) => (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.digs().heard >= (n as number), ended!.sent, { timeout: 10_000 });
  expect(await h(B.page, (x) => x.together.digs().heard)).toBe(await h(A.page, (x) => x.together.digs().sent));
  // The rematch: its shells' ids run on from the last match's, on both pages.
  await rematch();
  for (const p of [A.page, B.page]) await front(p, 'off');
  const lastId = Math.max(...last[0]);
  for (const p of [A.page, B.page]) await p.waitForFunction(() => (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.shells().landed.length >= 2, null, { timeout: 60_000 });
  const firsts = [await h(A.page, (x) => x.together.shells().landed[0].id), await h(B.page, (x) => x.together.shells().landed[0].id)];
  expect(firsts).toEqual([lastId + 1, lastId + 1]);
  // Compared once the rematch has begun and settled: in the lobby a page runs no frame, so the end's
  // last craters, and the scoops it carried (together.pending() counts them), wait for the rematch.
  const same = await sameWorlds(A.page, B.page);
  console.log(`the rematch, ${same.landed[0].length} shells (from ${firsts[0]}): the worlds ${same.same ? 'hash the same' : 'differ'} (try ${same.tries}, ${same.masked} voxels of blood masked)`);
  expect(same.same, says(same)).toBe(true);
  expect(same.landed[1], says(same)).toEqual(same.landed[0]);
  expect(A.errors).toEqual([]);
  expect(B.errors).toEqual([]);
});

test('a reload in the lobby after a match: the next match on one world', async () => {
  test.setTimeout(300_000);
  await h(A.page, (x) => x.together.end());
  for (const p of [A.page, B.page]) await p.waitForFunction(() => (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.phase() === 'lobby', null, { timeout: 10_000 });
  const t0 = Date.now();
  await B.page.reload();
  await ready(B.page);
  await B.page.waitForFunction(() => {
    const x = (window as unknown as { __trenchline: RoomHooks }).__trenchline;
    return x.together.room() !== null && x.together.phase() === 'lobby' && x.together.caughtUp() && x.together.catchUps().length > 0;
  }, null, { timeout: 120_000 });
  const caught = await h(B.page, (x) => x.together.catchUps()[0]);
  console.log(`B reloaded in the lobby: caught up on ${caught.total} of the log's entries in ${(caught.ms ?? 0).toFixed(0)} ms, ${((Date.now() - t0) / 1000).toFixed(1)} s after the reload`);
  await rematch();
  for (const p of [A.page, B.page]) await front(p, 'off');
  for (const p of [A.page, B.page]) await p.waitForFunction(() => (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.shells().landed.length >= 2, null, { timeout: 60_000 });
  // B caught up on the last matches in the lobby, quietly, with no battle around it: their fires'
  // chars are not made on its page (the spec's note 5, accepted drift: a char is colour only), so
  // each voxel A charred then and B holds unburnt is masked; any other difference counts.
  const same = await sameWorlds(A.page, B.page, { chars: true });
  console.log(`the match after B's lobby reload, ${same.landed[0].length} shells: the worlds ${same.same ? 'hash the same' : 'differ'} (try ${same.tries}, ${same.masked} voxels masked: ${same.charsMasked} charred on one page alone, the rest blood)`);
  expect(same.same, says(same)).toBe(true);
  expect(same.landed[1], says(same)).toEqual(same.landed[0]);
  expect(A.errors).toEqual([]);
  expect(B.errors).toEqual([]);
});

test('a dropped line: said for good, the battle the visitor\'s again; a reload rejoins on one world', async () => {
  test.setTimeout(300_000);
  expect(dropB).not.toBeNull();
  await dropB!();
  await B.page.waitForFunction(() => (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.phase() === 'lobby', null, { timeout: 10_000 });
  await expect(B.page.locator('#lobby-status')).toContainText('The connection to the game was lost');
  const b = await battleOf(B.page);
  expect(b).toEqual({ front: b.settings, side: 1, artillery: b.settings, settings: b.settings });
  // Past the note's 8 s: still said.
  await hold(B.page, 10_000);
  await expect(B.page.locator('#lobby')).toBeVisible();
  await expect(B.page.locator('#lobby-status')).toContainText('The connection to the game was lost');
  // A plays on, B's seat gone.
  await A.page.waitForFunction(() => (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.seats().length === 1, null, { timeout: 15_000 });
  // The reload rejoins the match, catches up, and goes in.
  await B.page.reload();
  await ready(B.page);
  await goIn(B.page);
  await front(B.page, 'off');
  // The last matches' shells land quietly on B's catch-up (this match's with its battle run along
  // them): their fires' chars are not made there (note 5), so masked as in the lobby reload's test.
  const same = await sameWorlds(A.page, B.page, { chars: true });
  console.log(`after the dropped line and B's reload, ${same.landed[0].length} shells: the worlds ${same.same ? 'hash the same' : 'differ'} (try ${same.tries}, ${same.masked} voxels masked: ${same.charsMasked} charred on one page alone, the rest blood)`);
  expect(same.same, says(same)).toBe(true);
  expect(same.landed[1], says(same)).toEqual(same.landed[0]);
  expect(A.errors).toEqual([]);
  // B's page said nothing was wrong but the line it lost.
  expect(B.errors.filter((e) => !/WebSocket|connection/i.test(e))).toEqual([]);
});
