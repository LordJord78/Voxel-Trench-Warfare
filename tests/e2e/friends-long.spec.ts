import { expect, test, type Page } from '@playwright/test';
import { decodeDig, decodeShell } from '../../src/net/protocol';
import { SHELL_FIELDS } from '../../src/net/shell-fields';
import { goIn, groundAt, h, hostAndJoin, ready, sameWorlds, windows, type GamePage, type RoomHooks } from './support/room';

// The long paths friends take (the final review's item 15, Task 8b), two pages against the relay on
// one room on the Corridor, its shelling heavy: a page reloaded after three minutes and more of heavy
// shelling and digging catches up on the room's log within its budget, saying how far it has come, Go
// hidden and its session still until it has (items 2 and 15.4); then both pages' frames through a
// minute of heavy fire, the front on (item 15.10). friends.spec.ts has the short paths.

test.describe.configure({ mode: 'serial' });

let A: GamePage;
let B: GamePage;

/** welcome → caught up on a reload, at most (ms): the controller's ruling. */
const CATCH_UP_BUDGET_MS = 60_000;
/** The match's seconds of heavy before B reloads: three minutes and more. */
const HEAVY_S = 185;

/** Each page's front set here, not through setIntensity (which sets the artillery too: in a room it must stay off). */
const front = (page: Page, i: 'off' | 'light' | 'heavy') =>
  h(
    page,
    (x, a) => {
      x.session.front.intensity = a as 'off' | 'light' | 'heavy';
    },
    i,
  );

/** Back in, if killed. */
const alive = (page: Page) => page.waitForFunction(() => (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.deadFor() === null, null, { timeout: 20_000 });

/** Quantiles of `xs`. */
const at = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

test.beforeAll(async ({ browser }) => {
  test.setTimeout(400_000);
  const { host, friend } = await hostAndJoin(browser, 'corridor', 'heavy');
  A = host;
  B = friend;
  await A.page.locator('#start').click();
  for (const p of [A.page, B.page]) {
    await goIn(p);
    await front(p, 'off');
  }
});

test.afterAll(async () => {
  await Promise.all(windows.splice(0).map((c) => c.close()));
});

test('a reload after three minutes of heavy shelling and digging catches up within its budget, saying how far it has come, Go hidden and the session still meanwhile', async () => {
  test.setTimeout(600_000);
  // A digs at the latest crater's rim in no man's land, 6 s at a time, until the match is HEAVY_S old; B stands at its start.
  while ((await h(A.page, (x) => x.together.matchSeconds())) < HEAVY_S) {
    await alive(A.page);
    const crater = await h(A.page, (x) => x.together.shells().landed.filter((s) => s.at[1] > 50 && s.at[1] < 200).at(-1) ?? null);
    if (crater) {
      const rim: [number, number] = [crater.at[0], crater.at[1] - (crater.radius + 0.6)];
      const y = await groundAt(A.page, rim[0], rim[1]);
      if (y !== null) {
        await h(A.page, (x, a) => x.teleport({ position: a as [number, number, number], yaw: 0, pitch: -20 }), [rim[0], y, rim[1]]);
        await A.page.keyboard.down('KeyF');
        await A.page.waitForTimeout(6000);
        await A.page.keyboard.up('KeyF');
      }
    }
    await A.page.waitForTimeout(6000);
  }
  const logged = await h(A.page, (x) => ({ s: x.together.matchSeconds(), shells: x.together.shells().landed.length, digs: x.together.digs().sent }));
  // Watched from the reload's first script, every frame from the welcome until it has caught up: what the way in says, whether Go is drawn, and the session's ticks.
  await B.page.addInitScript(() => {
    const w = window as unknown as { __trenchline?: RoomHooks; __catching: { frames: number; lines: string[]; counted: number; go: number; ticks: number[] } };
    const seen: { frames: number; lines: string[]; counted: number; go: number; ticks: number[] } = { frames: 0, lines: [], counted: 0, go: 0, ticks: [] };
    w.__catching = seen;
    const look = () => {
      const x = w.__trenchline;
      if (x?.together && x.together.room() !== null && x.together.phase() === 'playing' && !x.together.caughtUp()) {
        seen.frames++;
        const line = document.getElementById('deploy-line')?.textContent ?? '';
        if (/^Catching up on the battle… \d+ of \d+$/.test(line)) seen.counted++;
        if (seen.lines.length < 6 && !seen.lines.includes(line)) seen.lines.push(line);
        if (document.getElementById('go')?.checkVisibility()) seen.go++;
        if (!seen.ticks.includes(x.session.ticks)) seen.ticks.push(x.session.ticks);
      }
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
  const t0 = Date.now();
  await B.page.reload();
  await ready(B.page);
  await B.page.waitForFunction(() => (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.catchUps().some((c) => c.ms !== null), null, { timeout: 600_000 });
  const goAfterS = (Date.now() - t0) / 1000;
  const caught = await h(B.page, (x) => x.together.catchUps()[0]);
  const watched = await B.page.evaluate(() => (window as unknown as { __catching: { frames: number; lines: string[]; counted: number; go: number; ticks: number[] } }).__catching);
  // The log's entries in the catch-up's order (RoomBattle.catchUp: by time, a shell before a scoop of the same ms), the first `total` of them due: each entry's cost from the progress said after it.
  const log = (await h(B.page, (x) => x.together.log()))!;
  const entries = [
    ...log.shells.map((w) => ({ at: decodeShell(w)!.landAt, rank: 0, n: decodeShell(w)!.id })),
    ...log.digs.flatMap((w, n) => {
      const d = decodeDig(w);
      return d ? [{ at: d.at, rank: 1, n }] : [];
    }),
  ].sort((a, b) => a.at - b.at || a.rank - b.rank || a.n - b.n);
  const cost = { shell: { n: 0, ms: 0 }, scoop: { n: 0, ms: 0 } };
  for (let k = 1; k < caught.done.length; k++) {
    const [t, done] = caught.done[k];
    const [t1, done1] = caught.done[k - 1];
    if (done !== done1 + 1) continue;
    const kind = entries[done - 1].rank === 0 ? cost.shell : cost.scoop;
    kind.n++;
    kind.ms += t - t1;
  }
  const perShell = cost.shell.ms / Math.max(1, cost.shell.n);
  const perScoop = cost.scoop.ms / Math.max(1, cost.scoop.n);
  const rest = (caught.ms ?? 0) - cost.shell.ms - cost.scoop.ms;
  const project = (shells: number, scoops: number) => ((shells * perShell + scoops * perScoop + rest) / 1000).toFixed(1);
  const scoopsPerS = log.digs.length / logged.s;
  console.log(
    `B reloaded ${logged.s.toFixed(0)} s into heavy, the log ${log.shells.length} shells and ${log.digs.length} scoops (${caught.total} due): welcome to caught up ${((caught.ms ?? 0) / 1000).toFixed(1)} s ` +
      `(shells ${cost.shell.n} at ${perShell.toFixed(0)} ms each, scoops ${cost.scoop.n} at ${perScoop.toFixed(1)} ms each, the rest ${rest.toFixed(0)} ms); Go ${goAfterS.toFixed(1)} s after the reload. ` +
      `Projected: 20 min of light (150 shells, ${Math.round(scoopsPerS * 1200)} scoops at this rate) ${project(150, scoopsPerS * 1200)} s; 20 min of heavy (${Math.round((log.shells.length / logged.s) * 1200)} shells) ${project((log.shells.length / logged.s) * 1200, scoopsPerS * 1200)} s`,
  );
  console.log(`while catching up: ${watched.frames} frames, ${watched.counted} saying how far (${watched.lines.join(' | ')}), Go drawn in ${watched.go}, the session's ticks ${watched.ticks.join(', ')}`);
  expect(log.shells.length).toBeGreaterThanOrEqual(40);
  expect(caught.total).toBeGreaterThanOrEqual(log.shells.length);
  expect(watched.frames).toBeGreaterThan(10);
  expect(watched.counted).toBeGreaterThan(0);
  expect(watched.go).toBe(0);
  expect(watched.ticks).toHaveLength(1);
  expect(caught.ms, 'welcome to caught up (ms)').toBeLessThanOrEqual(CATCH_UP_BUDGET_MS);
  // In, and the same world as A's.
  await goIn(B.page);
  await front(B.page, 'off');
  const same = await sameWorlds(A.page, B.page);
  console.log(`after the reload, ${same.landed[0].length} shells: the worlds ${same.same ? 'hash the same' : 'differ'} (try ${same.tries}, ${same.masked} voxels of blood masked)`);
  expect(same.same, JSON.stringify(same)).toBe(true);
  expect(same.landed[1]).toEqual(same.landed[0]);
  expect(A.errors).toEqual([]);
  expect(B.errors).toEqual([]);
});

test('both pages keep their frames through a minute of heavy shelling with the front firing on', async () => {
  test.setTimeout(240_000);
  // Each at its start, the front heavy on both, firing at each over its bay's crest.
  for (const [p, s] of [[A.page, SHELL_FIELDS.corridor.spawns[0]], [B.page, SHELL_FIELDS.corridor.spawns[4]]] as const) {
    await alive(p);
    await h(p, (x, a) => x.teleport({ position: [(a as number[])[0], x.footAt((a as number[])[0], (a as number[])[1])! + 0.05, (a as number[])[1]], yaw: 0, pitch: 0 }), s);
    await front(p, 'heavy');
  }
  const start = await Promise.all([A.page, B.page].map((p) => h(p, (x) => ({ shells: x.together.shells().landed.length, cracks: x.audio().kinds.crack ?? 0, fired: x.session.front.fired }))));
  // Every frame's interval, and its main thread's time, for 60 s on both at once.
  for (const p of [A.page, B.page]) {
    await h(p, (x) => {
      const w = window as unknown as { __frames: { gaps: number[]; main: number[]; on: boolean } };
      const seen: { gaps: number[]; main: number[]; on: boolean } = { gaps: [], main: [], on: true };
      w.__frames = seen;
      let last = performance.now();
      let frames = x.frames();
      const look = (t: number) => {
        if (!seen.on) return;
        seen.gaps.push(t - last);
        last = t;
        if (x.frames() !== frames) {
          frames = x.frames();
          seen.main.push(x.mainMs().at(-1)!);
        }
        requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    });
  }
  await A.page.waitForTimeout(60_000);
  const runs = await Promise.all(
    [A.page, B.page].map((p) =>
      p.evaluate(() => {
        const w = window as unknown as { __frames: { gaps: number[]; main: number[]; on: boolean } };
        w.__frames.on = false;
        return { gaps: w.__frames.gaps.slice(1), main: w.__frames.main };
      }),
    ),
  );
  const end = await Promise.all([A.page, B.page].map((p) => h(p, (x) => ({ shells: x.together.shells().landed.length, cracks: x.audio().kinds.crack ?? 0, fired: x.session.front.fired }))));
  const lines: string[] = [];
  for (const [k, name] of ['A', 'B'].entries()) {
    const r = runs[k];
    lines.push(`${name}: ${r.gaps.length} frames, interval median ${at(r.gaps, 0.5).toFixed(1)} ms, p95 ${at(r.gaps, 0.95).toFixed(1)}, p99 ${at(r.gaps, 0.99).toFixed(1)}, worst ${Math.max(...r.gaps).toFixed(1)}; main thread p99 ${at(r.main, 0.99).toFixed(1)} ms, worst ${Math.max(...r.main).toFixed(1)}; ${end[k].shells - start[k].shells} shells landed, ${end[k].fired - start[k].fired} rounds of the front fired, ${end[k].cracks - start[k].cracks} cracks heard`);
  }
  console.log(`a minute of heavy, the front on: ${lines.join('; ')}`);
  for (const [k] of runs.entries()) {
    expect(end[k].shells - start[k].shells, lines[k]).toBeGreaterThanOrEqual(10);
    // The front firing on the page all the while (heavy: 500 rounds a minute in bursts).
    expect(end[k].fired - start[k].fired, lines[k]).toBeGreaterThanOrEqual(100);
    expect(runs[k].gaps.length, lines[k]).toBeGreaterThan(60 * 20);
    expect(at(runs[k].gaps, 0.95), lines[k]).toBeLessThanOrEqual(50);
    expect(at(runs[k].main, 0.99), lines[k]).toBeLessThanOrEqual(16);
  }
  expect(A.errors).toEqual([]);
  expect(B.errors).toEqual([]);
});
