/**
 * Node side of the room specs (the shared-battle plan's Task 8, and Task 8b's checks after it): pages
 * opened against the local relay, a room hosted and joined, a match started and gone into, and two
 * pages' worlds compared (sameWorlds) through main.ts's hooks.
 *
 * Functions handed to `h` run in the page: they are sent as their source, so they may use only their
 * own arguments (the hooks, and one `arg`).
 */
import { readFileSync } from 'node:fs';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { parse } from 'smol-toml';
import { PALETTE } from '../../../src/world/materials';

/** The relay the config starts (`npm --prefix server run dev`). */
export const RELAY = 'http://127.0.0.1:8787';

/** A fire grows this long to its full burn, when it chars what it burned ([battle.fires] grow_s). */
export const FIRE_GROW_S = (parse(readFileSync('data/tunables.toml', 'utf8')) as { battle: { fires: { grow_s: number } } }).battle.fires.grow_s;

/** A shell as a page's together hooks give it: its id, where it lands ([x, z] metres) and how big. */
export interface ShellSeen {
  id: number;
  at: [number, number];
  radius: number;
}

/**
 * A welcome's catch-up as the page recorded it (main.ts's catchUps): when it began, how long it took
 * (null: running, or failed), each entry done (ms from its start, entries done) of `total`, and where its
 * time went (ms): the destruction workers' jobs done meanwhile, the ms they ran there and the ms beyond
 * that from post to result; the session's destruction ticks; the battle's runs along the log; the
 * breaths and the ms awaiting them; and the page's frames meanwhile and their main-thread ms.
 */
export interface CatchUpSeen {
  from: number;
  ms: number | null;
  total: number;
  done: [number, number][];
  parts: { jobs: number; jobMs: number; tripMs: number; ticks: number; tickMs: number; runs: number; runMs: number; breaths: number; breathMs: number; frames: number; frameMs: number };
}

/** The hooks the room specs use (main.ts's `__trenchline`). */
export interface RoomHooks {
  ready: boolean;
  map: string;
  together: {
    room(): string | null;
    you(): number;
    owner(): number;
    seats(): { id: number; name: string; team: 'red' | 'blue'; ready: boolean; away: boolean }[];
    phase(): string | null;
    begun(): boolean;
    matchSeconds(): number;
    deadFor(): number | null;
    shells(): { heard: number; landed: ShellSeen[]; next: { id: number; at: [number, number]; landsInS: number } | null };
    caughtUp(): boolean;
    digs(): { sent: number; heard: number };
    pending(): number;
    blood(): number[];
    lastLanded(): number[];
    hurts(): number;
    /** The battle's harm the session reckoned on this player, by cause, told or not (main.ts). */
    harmed(): { shell: { n: number; hp: number }; round: { n: number; hp: number } };
    end(): void;
    log(): { shells: number[][]; digs: number[][] } | null;
    catchUps(): CatchUpSeen[];
    /** Every voxel holding one of `ids`, and each sector's content hash (world-compare.ts). */
    cells(ids: readonly number[]): number[];
    sectorHashes(): number[];
    others(): { id: number; team: 'red' | 'blue'; position: [number, number, number] }[];
  };
  session: {
    /** The front: its intensity, and the rounds it has fired (combat/front.ts Front.fired). */
    front: { intensity: 'off' | 'light' | 'heavy'; readonly fired: number };
    artillery: { intensity: 'off' | 'light' | 'heavy' };
    frontSide: 0 | 1;
    alive: boolean;
    ticks: number;
    /** Metres a voxel. */
    voxel: number;
  };
  world: { map: { get(x: number, y: number, z: number): number } };
  views: Record<string, { position: [number, number, number]; yaw: number; pitch: number }>;
  settings(): { intensity: 'off' | 'light' | 'heavy' };
  footAt(x: number, z: number): number | null;
  frames(): number;
  mainMs(): number[];
  hitFeedback(): { flashes: number; voices: Record<string, number> };
  audio(): { state: string; kinds: Record<string, number> };
  trigger(held: boolean): void;
  setIntensity(i: 'off' | 'light' | 'heavy'): void;
  freeze(hz?: number): void;
  thaw(): void;
  waitFrames(n: number): Promise<void>;
  fingerprint(mask?: readonly number[]): Promise<string>;
  battle(): { seconds: number; fires: { t0: number; out?: number }[] };
  timeOfDay(): number;
  teleport(at: { position: [number, number, number]; yaw: number; pitch: number }): void;
  player(): { position: [number, number, number]; stance: number };
}

/** `fn` run in `page` with its hooks and `arg`. */
export const h = <T>(page: Page, fn: (x: RoomHooks, arg: unknown) => T | Promise<T>, arg?: unknown): Promise<T> =>
  page.evaluate(([source, a]) => new Function('x', 'arg', `return (${source})(x, arg)`)((window as unknown as { __trenchline: RoomHooks }).__trenchline, a), [fn.toString(), arg] as const) as Promise<T>;

/** A page of the game, and what it said was wrong. */
export interface GamePage {
  page: Page;
  errors: string[];
}

/** Each window opened (every page its own), for the spec to close: a game page left open goes on drawing on the one GPU. */
export const windows: BrowserContext[] = [];

/**
 * The game at `path` in a window of its own, 800 × 500 as fight.spec's, its errors kept: once it says it
 * is ready. `before`, given the window before the page is opened in it (a route on its sockets).
 */
export async function open(browser: Browser, path: string, before?: (context: BrowserContext) => Promise<void>): Promise<GamePage> {
  const context = await browser.newContext({ viewport: { width: 800, height: 500 } });
  windows.push(context);
  await before?.(context);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(path);
  await ready(page);
  return { page, errors };
}

/** The page has its world and says it is ready (its loading, a reload's, over). */
export async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as { __trenchline?: RoomHooks }).__trenchline?.ready === true, null, { timeout: 180_000 });
}

/**
 * A room on `map` hosted from one page and joined from another (each loading that map, so neither goes
 * to it), the friend on the other team (blue), the room set to `intensity` by its owner; both seated.
 * `friendWindow`, given the friend's window before its page is opened (open's `before`).
 */
export async function hostAndJoin(browser: Browser, map: 'ravine' | 'corridor', intensity: 'off' | 'light' | 'heavy', friendWindow?: (context: BrowserContext) => Promise<void>): Promise<{ host: GamePage; friend: GamePage; room: string }> {
  const host = await open(browser, `/?map=${map}&relay=${RELAY}`);
  await host.page.locator('#host').click();
  await host.page.waitForFunction(() => (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.you() === 0);
  const room = (await h(host.page, (x) => x.together.room()))!;
  // The room set to the host's map (its claim) before the friend comes, so the friend's page stays on it.
  await expect(host.page.locator('#match-settings select[name="map"]')).toHaveValue(map);
  const friend = await open(browser, `/?room=${room}&map=${map}&relay=${RELAY}`, friendWindow);
  for (const p of [host.page, friend.page]) await p.waitForFunction(() => (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.seats().length === 2, null, { timeout: 30_000 });
  await host.page.locator('#match-settings select[name="intensity"]').selectOption(intensity);
  await expect(friend.page.locator('#match-settings select[name="intensity"]')).toHaveValue(intensity);
  return { host, friend, room };
}

/** Into the match on `page`, once it has begun there and Go is offered. */
export async function goIn(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.begun(), null, { timeout: 30_000 });
  await expect(page.locator('#go')).toBeVisible({ timeout: 180_000 });
  await page.locator('#go').click();
  await expect(page.locator('#lobby')).toBeHidden();
}

/** The page's front set here, not through setIntensity (which sets the artillery too: in a room it must stay off). */
export const front = (page: Page, i: 'off' | 'light' | 'heavy') =>
  h(
    page,
    (x, a) => {
      x.session.front.intensity = a as 'off' | 'light' | 'heavy';
    },
    i,
  );

/** Back in after being killed, if killed: once the page's player is alive again. */
export const alive = (page: Page) => page.waitForFunction(() => (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.deadFor() === null, null, { timeout: 20_000 });

/** A line of the kill feed: the killer (their team and name; none for the battle's), how, and the one killed. */
export type FeedLine = { killer: { team: string; name: string } | null; how: string; victim: { team: string; name: string } | null };

/** `page`'s kill feed, newest line first. */
export const feedOf = (page: Page): Promise<FeedLine[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll('#hud .feed li')].map((li) => {
      const spans = [...li.querySelectorAll('span')];
      const how = spans.findIndex((s) => s.className === 'how');
      const who = (s: Element | undefined) => (s ? { team: s.className, name: s.textContent ?? '' } : null);
      return { killer: how > 0 ? who(spans[0]) : null, how: spans[how]?.textContent ?? '', victim: who(spans[how + 1]) };
    }),
  );

/** The page's own name and team, from its seat. */
export const meOf = (page: Page) => h(page, (x) => x.together.seats().find((s) => s.id === x.together.you())!);

/** The world's top at (x, z) metres on `page`: the highest voxel neither air nor water (the footAt hook), as a foot's height (metres, 5 cm over it), or null. */
export const groundAt = (page: Page, x: number, z: number): Promise<number | null> =>
  h(
    page,
    (hooks, a) => {
      const top = hooks.footAt((a as number[])[0], (a as number[])[1]);
      return top === null ? null : top + 0.05;
    },
    [x, z],
  );

/** Two pages' worlds as sameWorlds found them: their hashes, the shells each had landed, how many voxels the blood mask held, and each page's battle and match seconds as it was frozen (read together). */
export interface Compared {
  same: boolean;
  hashes: [string, string];
  landed: [number[], number[]];
  masked: number;
  tries: number;
  seconds: [{ battle: number; match: number }, { battle: number; match: number }];
  /** Why each try before the last good one was not compared, or what differed (worldDiff), for a failure's message. */
  notes: string[];
  /** With `chars`: the voxels masked as a char one page made and the other did not (spec note 5). */
  charsMasked: number;
}

/** What sameWorlds is to do: how many tries; and whether to mask each char one page made and the other did not (`chars`). */
export interface SameOptions {
  tries?: number;
  /**
   * For a page caught up on the log across a match's end (a reload or a join in the lobby, or in a
   * later match): an earlier match's shells land quietly on it, without the battle around the page, so
   * the chars of those matches' fires are not made there (the shared-battle spec's note 5: a char is
   * colour only, an accepted drift). Masked: each voxel that is a char on one page and on the other a
   * shade that burns to it (of the char's kind, unburnt); any other difference there still counts.
   *
   * It masks this match's chars too, which a catch-up does make (the spec's note 10: it runs the battle
   * along the log, each strike given at its second), so it is for a comparison across a match's end
   * alone. Every comparison within a match leaves it off and compares chars unmasked: friends-long's
   * reload after three minutes of heavy, battle.spec, and friends.spec's within-match ones.
   */
  chars?: boolean;
}

/** The palette ids of the chars (CHAR_*), and of each the kind it is (world/char.ts: a char keeps the kind it burned). */
const CHAR_IDS = PALETTE.flatMap((p, id) => (p.name.startsWith('CHAR_') ? [id] : []));
const isChar = (id: number) => CHAR_IDS.includes(id);
/** Whether one of two voxels is a char and the other a shade that burns to it: the same kind, unburnt. */
const charredOnOne = (p: number, q: number) => p !== q && (isChar(p) !== isChar(q)) && PALETTE[p]?.kind === PALETTE[q]?.kind;

/** On a page: every voxel holding one of `ids`, as packed cells (the cells hook: world-compare.ts cellsHolding). */
const cellsHolding = (page: Page, ids: readonly number[]): Promise<number[]> => h(page, (x, a) => x.together.cells(a as number[]), ids);

/** On a page: the voxel at each of `cells` (packed). */
const voxelsAt = (page: Page, cells: readonly number[]): Promise<number[]> =>
  h(
    page,
    (x, a) => {
      const map = x.world.map as unknown as { dims: { x: number; y: number; z: number }; get(x: number, y: number, z: number): number };
      const { x: X, y: Y } = map.dims;
      return (a as number[]).map((c) => map.get(c % X, Math.floor(c / X) % Y, Math.floor(c / (X * Y))));
    },
    cells,
  );

/** A page frozen: its battle's and match's seconds, read in one evaluate, and when each of its fires chars (battle seconds; those yet to). */
interface Frozen {
  battle: number;
  match: number;
  chars: number[];
}

/**
 * Whether two pages' worlds are the same, blood aside, compared at a common moment of the battle (the
 * final review's item 15.9). A fire chars what it burned once, at its full burn (FIRE_GROW_S after it
 * started, on the match's clock: Strike.atS), so two pages frozen at different battle seconds differ by
 * every char due between them. `a` is frozen once it is idle (no crater queued or out, no scoop held or
 * carried: together.pending() 0), no heard shell is due within a second (so `b` can reach the same
 * moment), and no fire of its battle chars within the next 3 s; `b` once it is idle with as many shells
 * landed as `a`. A try is good if no char of either page's fires falls between the two battle seconds
 * they froze at; then each hashes its world with every voxel either page holds blood in masked
 * (fingerprint(mask)), and both thaw, whatever happened. A try where `b` lands more than `a` (a shell
 * came due between), never settles at `a`'s count, has a char between them, or the hashes differ (a
 * crater racing the freeze), is tried again, up to `tries` times; after `b` was found past `a`, `a`
 * runs on to `b`'s count of shells before it is frozen again. With `chars`, each char one page made
 * and the other did not is masked too (SameOptions.chars). Each try not compared, or compared and
 * different (with where: worldDiff), is said as it happens, and kept in `notes`.
 */
export async function sameWorlds(a: Page, b: Page, { tries = 10, chars = false }: SameOptions = {}): Promise<Compared> {
  let last: Compared | null = null;
  const notes: string[] = [];
  const note = (n: string) => {
    notes.push(n);
    console.log(`  sameWorlds ${n}`);
  };
  /** The shells `b` had landed when a try found it past `a`: `a` runs on to them before it is frozen again. */
  let least = 0;
  for (let k = 1; k <= tries; k++) {
    try {
      const atA = await h<Frozen>(
        a,
        async (x, arg) => {
          const [g, n, again] = arg as [number, number, boolean];
          const t0 = performance.now();
          // A try again: a frame run first, so `a` is not frozen at the same moment as the last try.
          if (again) await x.waitFrames(1);
          for (;;) {
            const next = x.together.shells().next;
            const bt = x.battle();
            // When each fire chars: at its full burn, unless put out before it.
            const chars = bt.fires.map((f) => (f.out === undefined || f.out >= f.t0 + g ? f.t0 + g : Number.POSITIVE_INFINITY)).filter((c) => c > bt.seconds && c < Number.POSITIVE_INFINITY);
            if (x.together.pending() === 0 && x.together.shells().landed.length >= n && (next === null || next.landsInS > 1) && chars.every((c) => c > bt.seconds + 3)) {
              x.freeze();
              return { battle: x.battle().seconds, match: x.together.matchSeconds(), chars };
            }
            if (performance.now() - t0 > 90_000) throw new Error(`never idle: ${x.together.pending()} pending, next shell ${JSON.stringify(next)}, chars due at ${chars.join(', ')} (battle ${bt.seconds})`);
            await x.waitFrames(1);
          }
        },
        [FIRE_GROW_S, least, k > 1],
      );
      const count = await h(a, (x) => x.together.shells().landed.length);
      // Frozen at `a`'s moment; or, past it, how many shells it had landed; or null, never settled.
      const atB = await h<Frozen | number | null>(
        b,
        async (x, arg) => {
          const [n, g] = arg as [number, number];
          const t0 = performance.now();
          for (;;) {
            const s = x.together.shells();
            if (s.landed.length > n) return s.landed.length;
            if (x.together.pending() === 0 && s.landed.length === n && (s.next === null || s.next.landsInS > 0)) {
              x.freeze();
              const bt = x.battle();
              const chars = bt.fires.map((f) => (f.out === undefined || f.out >= f.t0 + g ? f.t0 + g : Number.POSITIVE_INFINITY)).filter((c) => c < Number.POSITIVE_INFINITY);
              return { battle: bt.seconds, match: x.together.matchSeconds(), chars };
            }
            if (performance.now() - t0 > 45_000) return null;
            await x.waitFrames(1);
          }
        },
        [count, FIRE_GROW_S],
      );
      if (typeof atB === 'number') {
        least = atB;
        note(`try ${k}: b had landed ${atB} shells, past a's ${count} (a at battle ${atA.battle.toFixed(3)} s): a runs on to them`);
        continue;
      }
      // No char between the two moments, on either page's fires.
      const lo = atB ? Math.min(atA.battle, atB.battle) : 0;
      const hi = atB ? Math.max(atA.battle, atB.battle) : 0;
      const between = atB ? [...atA.chars, ...atB.chars].filter((c) => c > lo && c <= hi) : [];
      if (!atB) note(`try ${k}: b never settled at a's ${count} shells (a at battle ${atA.battle.toFixed(3)} s)`);
      else if (between.length > 0) note(`try ${k}: chars at ${between.join(', ')} between battle ${lo.toFixed(3)} and ${hi.toFixed(3)} s`);
      if (atB && between.length === 0) {
        const blood = [...(await h(a, (x) => x.together.blood())), ...(await h(b, (x) => x.together.blood()))];
        let charsMasked = 0;
        if (chars) {
          const either = [...new Set([...(await cellsHolding(a, CHAR_IDS)), ...(await cellsHolding(b, CHAR_IDS))])];
          const [va, vb] = [await voxelsAt(a, either), await voxelsAt(b, either)];
          const one = either.filter((_, i) => charredOnOne(va[i], vb[i]));
          charsMasked = one.length;
          blood.push(...one);
        }
        const mask = [...new Set(blood)].sort((p, q) => p - q);
        const hashes: [string, string] = [await h(a, (x, m) => x.fingerprint(m as number[]), mask), await h(b, (x, m) => x.fingerprint(m as number[]), mask)];
        const landed: [number[], number[]] = [await h(a, (x) => x.together.shells().landed.map((s) => s.id)), await h(b, (x) => x.together.shells().landed.map((s) => s.id))];
        if (hashes[0] !== hashes[1]) note(`try ${k}: at battle ${atA.battle.toFixed(3)} and ${atB.battle.toFixed(3)} s, ${landed[0].length} and ${landed[1].length} shells: ${await worldDiff(a, b, mask)}`);
        last = { same: hashes[0] === hashes[1], hashes, landed, masked: mask.length, tries: k, seconds: [{ battle: atA.battle, match: atA.match }, { battle: atB.battle, match: atB.match }], notes, charsMasked };
      }
    } finally {
      // Thaw is nothing to a page not frozen: both, whatever the try did.
      for (const p of [a, b]) await h(p, (x) => x.thaw());
    }
    if (last?.same) return last;
  }
  return last ?? { same: false, hashes: ['', ''], landed: [[], []], masked: 0, tries, seconds: [{ battle: 0, match: 0 }, { battle: 0, match: 0 }], notes, charsMasked: 0 };
}

/** On a page, each 32-voxel sector's content hash (the sectorHashes hook: world-compare.ts sectorHashes). */
const sectorHashes = (page: Page): Promise<number[]> => h(page, (x) => x.together.sectorHashes());

/** On a page, sector `si`'s voxels (x fastest, then y, then z) and its first voxel. */
const sectorVoxels = (page: Page, si: number): Promise<{ origin: [number, number, number]; voxels: number[] }> =>
  h(
    page,
    (x, a) => {
      const map = x.world.map as unknown as { sectors: { x: number; y: number; z: number }; inBounds(x: number, y: number, z: number): boolean; get(x: number, y: number, z: number): number };
      const s = a as number;
      const S = map.sectors;
      const o: [number, number, number] = [(s % S.x) * 32, (Math.floor(s / S.x) % S.y) * 32, Math.floor(s / (S.x * S.y)) * 32];
      const voxels: number[] = [];
      for (let k = 0; k < 32; k++) for (let j = 0; j < 32; j++) for (let i = 0; i < 32; i++) voxels.push(map.inBounds(o[0] + i, o[1] + j, o[2] + k) ? map.get(o[0] + i, o[1] + j, o[2] + k) : 0);
      return { origin: o, voxels };
    },
    si,
  );

/**
 * Where two frozen pages' worlds differ, `mask` (packed cells) aside: how many voxels, in how many
 * sectors, each change of material from `a`'s to `b`'s counted, and the box (voxels) they fall in. For
 * a failure's message: sameWorlds' hashes say only that they differ.
 */
export async function worldDiff(a: Page, b: Page, mask: readonly number[]): Promise<string> {
  const [ha, hb] = [await sectorHashes(a), await sectorHashes(b)];
  const sectors = ha.flatMap((v, si) => (v !== hb[si] ? [si] : []));
  if (sectors.length === 0) return 'no sector differs (the masked voxels alone, or a hash of the same content)';
  const dims = await h(a, (x) => (x.world.map as unknown as { dims: { x: number; y: number; z: number } }).dims);
  const masked = new Set(mask);
  const pairs = new Map<string, number>();
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  let n = 0;
  const name = (v: number) => PALETTE[v]?.name ?? String(v);
  for (const si of sectors.slice(0, 16)) {
    const [va, vb] = [await sectorVoxels(a, si), await sectorVoxels(b, si)];
    const [ox, oy, oz] = va.origin;
    for (let c = 0; c < va.voxels.length; c++) {
      if (va.voxels[c] === vb.voxels[c]) continue;
      const p = [ox + (c & 31), oy + ((c >> 5) & 31), oz + (c >> 10)];
      if (masked.has((p[2] * dims.y + p[1]) * dims.x + p[0])) continue;
      n++;
      const key = `${name(va.voxels[c])}>${name(vb.voxels[c])}`;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
      for (let d = 0; d < 3; d++) {
        lo[d] = Math.min(lo[d], p[d]);
        hi[d] = Math.max(hi[d], p[d]);
      }
    }
  }
  const top = [...pairs].sort((p, q) => q[1] - p[1]).slice(0, 12).map(([k, v]) => `${k} ${v}`);
  return `${n} voxels differ in ${Math.min(16, sectors.length)} of ${sectors.length} sectors (${top.join(', ')}), within [${lo.join(', ')}]..[${hi.join(', ')}]`;
}
