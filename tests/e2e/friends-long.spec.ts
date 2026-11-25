import { expect, test, type Page } from '@playwright/test';
import { decodeDig, decodeShell } from '../../src/net/protocol';
import { SHELL_FIELDS } from '../../src/net/shell-fields';
import { alive, front, goIn, groundAt, h, hostAndJoin, ready, sameWorlds, windows, type CatchUpSeen, type GamePage, type RoomHooks } from './support/room';

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
/** The catch-up's gate (Task 8c): the median shell's cost at most (ms), and 20 minutes of heavy (386 shells, and the scoops at the rate dug here) projected at most (s). */
const SHELL_MEDIAN_MS = 120;
const HEAVY_20_MIN_S = 60;
const HEAVY_20_MIN_SHELLS = 386;
/** The longest the page's main thread may be held at once while it catches up (ms). */
const BLOCK_MAX_MS = 250;

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
  // Watched from the reload's first script, every frame from the welcome until it has caught up: what the way in says, whether Go is drawn, the session's ticks,
  // and the worst interval between frames; and every task that held the main thread 50 ms or more (the Long Tasks API), when and for how long.
  type Watched = { frames: number; lines: string[]; counted: number; go: number; ticks: number[]; worstGap: number; long: [number, number][] };
  await B.page.addInitScript(() => {
    const w = window as unknown as { __trenchline?: RoomHooks; __catching: Watched };
    const seen: Watched = { frames: 0, lines: [], counted: 0, go: 0, ticks: [], worstGap: 0, long: [] };
    w.__catching = seen;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) seen.long.push([e.startTime, e.duration]);
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      // No Long Tasks API: the worst frame interval alone.
    }
    let last: number | null = null;
    const look = (t: number) => {
      const x = w.__trenchline;
      if (x?.together && x.together.room() !== null && x.together.phase() === 'playing' && !x.together.caughtUp()) {
        seen.frames++;
        if (last !== null) seen.worstGap = Math.max(seen.worstGap, t - last);
        last = t;
        const line = document.getElementById('deploy-line')?.textContent ?? '';
        if (/^Catching up on the battle… \d+ of \d+$/.test(line)) seen.counted++;
        if (seen.lines.length < 6 && !seen.lines.includes(line)) seen.lines.push(line);
        if (document.getElementById('go')?.checkVisibility()) seen.go++;
        if (!seen.ticks.includes(x.session.ticks)) seen.ticks.push(x.session.ticks);
      } else last = null;
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
  const t0 = Date.now();
  await B.page.reload();
  await ready(B.page);
  await B.page.waitForFunction(() => (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.catchUps().some((c) => c.ms !== null), null, { timeout: 600_000 });
  const goAfterS = (Date.now() - t0) / 1000;
  const caught: CatchUpSeen = await h(B.page, (x) => x.together.catchUps()[0]);
  const watched = await B.page.evaluate(() => (window as unknown as { __catching: Watched }).__catching);
  // The log's entries in the catch-up's order (RoomBattle.catchUp: by time, a shell before a scoop of the same ms), the first `total` of them due: each entry's cost from the progress said after it.
  const log = (await h(B.page, (x) => x.together.log()))!;
  const entries = [
    ...log.shells.map((w) => ({ at: decodeShell(w)!.landAt, rank: 0, n: decodeShell(w)!.id })),
    ...log.digs.flatMap((w, n) => {
      const d = decodeDig(w);
      return d ? [{ at: d.at, rank: 1, n }] : [];
    }),
  ].sort((a, b) => a.at - b.at || a.rank - b.rank || a.n - b.n);
  const cost = { shell: [] as number[], scoop: [] as number[] };
  for (let k = 1; k < caught.done.length; k++) {
    const [t, done] = caught.done[k];
    const [t1, done1] = caught.done[k - 1];
    if (done !== done1 + 1) continue;
    (entries[done - 1].rank === 0 ? cost.shell : cost.scoop).push(t - t1);
  }
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const perShell = sum(cost.shell) / Math.max(1, cost.shell.length);
  const shellMedian = at(cost.shell, 0.5);
  const perScoop = sum(cost.scoop) / Math.max(1, cost.scoop.length);
  const rest = (caught.ms ?? 0) - sum(cost.shell) - sum(cost.scoop);
  const project = (shells: number, scoops: number) => (shells * perShell + scoops * perScoop + rest) / 1000;
  const scoopsPerS = log.digs.length / logged.s;
  const heavy20 = project(HEAVY_20_MIN_SHELLS, scoopsPerS * 1200);
  // Where the catch-up's time went, per shell of the log (main.ts's catchUps parts).
  const p = caught.parts;
  const n = Math.max(1, cost.shell.length);
  const per = (ms: number) => (ms / n).toFixed(1);
  const longest = watched.long.filter(([start, ms]) => start + ms >= caught.from && start <= caught.from + (caught.ms ?? 0)).reduce((a, [, ms]) => Math.max(a, ms), 0);
  console.log(
    `B reloaded ${logged.s.toFixed(0)} s into heavy, the log ${log.shells.length} shells and ${log.digs.length} scoops (${caught.total} due): welcome to caught up ${((caught.ms ?? 0) / 1000).toFixed(1)} s ` +
      `(shells ${cost.shell.length} at ${perShell.toFixed(0)} ms each, median ${shellMedian.toFixed(0)}, p90 ${at(cost.shell, 0.9).toFixed(0)}; scoops ${cost.scoop.length} at ${perScoop.toFixed(1)} ms each; the rest ${rest.toFixed(0)} ms); Go ${goAfterS.toFixed(1)} s after the reload. ` +
      `Projected: 20 min of light (150 shells, ${Math.round(scoopsPerS * 1200)} scoops at this rate) ${project(150, scoopsPerS * 1200).toFixed(1)} s; 20 min of heavy (${HEAVY_20_MIN_SHELLS} shells) ${heavy20.toFixed(1)} s`,
  );
  console.log(
    `where it went, ms a shell (${n} shells): the workers' jobs ${per(p.jobMs)} (${p.jobs} jobs), their round trips beyond the job ${per(p.tripMs)}; destruction ticks ${per(p.tickMs)} (${(p.ticks / n).toFixed(1)} a shell); ` +
      `the battle's runs ${per(p.runMs)} (${p.runs}); breaths ${(p.breaths / n).toFixed(1)} a shell, awaited ${per(p.breathMs)}; frames meanwhile ${p.frames} (${(p.frames / n).toFixed(1)} a shell), their main thread ${per(p.frameMs)}; ` +
      `the longest task ${longest.toFixed(0)} ms (${watched.long.length} of 50 ms or more on the page), the worst frame interval ${watched.worstGap.toFixed(0)} ms`,
  );
  console.log(`while catching up: ${watched.frames} frames, ${watched.counted} saying how far (${watched.lines.join(' | ')}), Go drawn in ${watched.go}, the session's ticks ${watched.ticks.join(', ')}`);
  expect(log.shells.length).toBeGreaterThanOrEqual(40);
  expect(caught.total).toBeGreaterThanOrEqual(log.shells.length);
  expect(watched.frames).toBeGreaterThan(10);
  // Every frame says how far it has come, but the welcome's first.
  expect(watched.counted).toBeGreaterThanOrEqual(watched.frames - 1);
  expect(watched.go).toBe(0);
  expect(watched.ticks).toHaveLength(1);
  expect(caught.ms, 'welcome to caught up (ms)').toBeLessThanOrEqual(CATCH_UP_BUDGET_MS);
  expect(shellMedian, 'the median shell (ms)').toBeLessThanOrEqual(SHELL_MEDIAN_MS);
  expect(heavy20, '20 minutes of heavy, projected (s)').toBeLessThanOrEqual(HEAVY_20_MIN_S);
  expect(longest, 'the longest task while catching up (ms)').toBeLessThanOrEqual(BLOCK_MAX_MS);
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
    // 60 frames a second for at least 40 of the minute's; the intervals at 60 Hz but for one in twenty; the main thread's work well inside a frame.
    expect(runs[k].gaps.length, lines[k]).toBeGreaterThan(60 * 40);
    expect(at(runs[k].gaps, 0.95), lines[k]).toBeLessThanOrEqual(25);
    expect(at(runs[k].main, 0.99), lines[k]).toBeLessThanOrEqual(8);
  }
  expect(A.errors).toEqual([]);
  expect(B.errors).toEqual([]);
});
