/**
 * Node side of the room specs (the shared-battle plan's Task 8, and Task 8b's checks after it): pages
 * opened against the local relay, a room hosted and joined, a match started and gone into, and two
 * pages' worlds compared (sameWorlds) through main.ts's hooks.
 *
 * Functions handed to `h` run in the page: they are sent as their source, so they may use only their
 * own arguments (the hooks, and one `arg`).
 */
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

/** The relay the config starts (`npm --prefix server run dev`). */
export const RELAY = 'http://127.0.0.1:8787';

/** A shell as a page's together hooks give it: its id, where it lands ([x, z] metres) and how big. */
export interface ShellSeen {
  id: number;
  at: [number, number];
  radius: number;
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
    shells(): { heard: number; landed: ShellSeen[]; next: { at: [number, number]; landsInS: number } | null };
    caughtUp(): boolean;
    digs(): { sent: number; heard: number };
    pending(): number;
    blood(): number[];
  };
  session: { front: { intensity: 'off' | 'light' | 'heavy' }; frontSide: 0 | 1; alive: boolean };
  world: { map: { get(x: number, y: number, z: number): number } };
  setIntensity(i: 'off' | 'light' | 'heavy'): void;
  freeze(hz?: number): void;
  thaw(): void;
  waitFrames(n: number): Promise<void>;
  fingerprint(mask?: readonly number[]): Promise<string>;
  battle(): { seconds: number };
  timeOfDay(): number;
  teleport(at: { position: [number, number, number]; yaw: number; pitch: number }): void;
  player(): { position: [number, number, number] };
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

/** The game at `path` in a window of its own, 800 × 500 as fight.spec's, its errors kept: once it says it is ready. */
export async function open(browser: Browser, path: string): Promise<GamePage> {
  const context = await browser.newContext({ viewport: { width: 800, height: 500 } });
  windows.push(context);
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
 */
export async function hostAndJoin(browser: Browser, map: 'ravine' | 'corridor', intensity: 'off' | 'light' | 'heavy'): Promise<{ host: GamePage; friend: GamePage; room: string }> {
  const host = await open(browser, `/?map=${map}&relay=${RELAY}`);
  await host.page.locator('#host').click();
  await host.page.waitForFunction(() => (window as unknown as { __trenchline: RoomHooks }).__trenchline.together.you() === 0);
  const room = (await h(host.page, (x) => x.together.room()))!;
  // The room set to the host's map (its claim) before the friend comes, so the friend's page stays on it.
  await expect(host.page.locator('#match-settings select[name="map"]')).toHaveValue(map);
  const friend = await open(browser, `/?room=${room}&map=${map}&relay=${RELAY}`);
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

/** The world's top at (x, z) metres on `page`: the highest voxel neither air nor water, as a foot's height (metres), or null. */
export const groundAt = (page: Page, x: number, z: number): Promise<number | null> =>
  h(
    page,
    (hooks, a) => {
      const [gx, gz] = (a as number[]).map((m) => Math.floor(m / 0.1));
      for (let y = 319; y >= 0; y--) {
        const v = hooks.world.map.get(gx, y, gz);
        if (v !== 0 && v !== 34) return (y + 1) * 0.1 + 0.05;
      }
      return null;
    },
    [x, z],
  );

/** Two pages' worlds as sameWorlds found them: their hashes, the shells each had landed, and how many voxels the blood mask held. */
export interface Compared {
  same: boolean;
  hashes: [string, string];
  landed: [number[], number[]];
  masked: number;
  tries: number;
}

/**
 * Whether two pages' worlds are the same, blood aside. `a` is frozen once it is idle (no crater queued
 * or out, no scoop held: together.pending() 0; and no heard shell due within a second, so `b` can reach
 * the same moment); `b` once it is idle with as many shells landed as `a`; then each hashes its world
 * with every voxel either page holds blood in masked (fingerprint(mask)), and both thaw. A try where `b`
 * lands more than `a` (a shell came due between), or never settles at `a`'s count, or the hashes
 * differ (a char or a crater racing the freeze), is tried again, up to `tries` times.
 */
export async function sameWorlds(a: Page, b: Page, tries = 10): Promise<Compared> {
  let last: Compared | null = null;
  for (let k = 1; k <= tries; k++) {
    await h(a, async (x) => {
      const t0 = performance.now();
      for (;;) {
        const next = x.together.shells().next;
        if (x.together.pending() === 0 && (next === null || next.landsInS > 1)) {
          x.freeze();
          return;
        }
        if (performance.now() - t0 > 60_000) throw new Error(`never idle: ${x.together.pending()} pending, next shell ${JSON.stringify(next)}`);
        await x.waitFrames(1);
      }
    });
    const count = await h(a, (x) => x.together.shells().landed.length);
    const met = await h(
      b,
      async (x, n) => {
        const t0 = performance.now();
        for (;;) {
          const s = x.together.shells();
          if (s.landed.length > (n as number)) return false;
          if (x.together.pending() === 0 && s.landed.length === n && (s.next === null || s.next.landsInS > 0)) {
            x.freeze();
            return true;
          }
          if (performance.now() - t0 > 30_000) return false;
          await x.waitFrames(1);
        }
      },
      count,
    );
    if (met) {
      const blood = [...(await h(a, (x) => x.together.blood())), ...(await h(b, (x) => x.together.blood()))];
      const mask = [...new Set(blood)].sort((p, q) => p - q);
      const hashes: [string, string] = [await h(a, (x, m) => x.fingerprint(m as number[]), mask), await h(b, (x, m) => x.fingerprint(m as number[]), mask)];
      const landed: [number[], number[]] = [await h(a, (x) => x.together.shells().landed.map((s) => s.id)), await h(b, (x) => x.together.shells().landed.map((s) => s.id))];
      last = { same: hashes[0] === hashes[1], hashes, landed, masked: mask.length, tries: k };
    }
    for (const p of [a, b]) await h(p, (x) => x.thaw());
    if (last?.same) return last;
  }
  return last ?? { same: false, hashes: ['', ''], landed: [[], []], masked: 0, tries };
}
