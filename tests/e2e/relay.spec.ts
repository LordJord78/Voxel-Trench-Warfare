import { expect, test } from '@playwright/test';
import { LOG_CHARS_MAX } from '../../src/net/room-core';
import { DIG_CELLS_MAX, decodeShell, PROTOCOL, ROOM_TEXT_MAX, WORLD_DIMS, type RoomShell } from '../../src/net/protocol';
import { SHELLING } from '../../src/net/shelling';
import { makeRoom, RelayClient, type Heard } from './support/relay-client';

// The relay itself (the final review's item 15.7), under `wrangler dev` as playwright.config.ts starts
// it: players in Node on real WebSockets, no page, no world. The room's log grown to its cap by the
// players' scoops and carried whole in a newcomer's welcome; every shell told before it lands, its ids
// running on without a gap, the same to every player, and none told once the match is won; the owner
// gone mid-match, the shelling going on and the next owner ending the match; the room emptied, and a
// fresh start from an empty log and shell 1; and a page of the first protocol turned away.

test.describe.configure({ mode: 'serial' });

/** Every client opened here, closed at the end whatever happened. */
const clients: RelayClient[] = [];
const client = (room: string, name: string, hello?: { v?: number; build?: string } | null): RelayClient => {
  const c = new RelayClient(room, name, hello);
  clients.push(c);
  return c;
};
test.afterAll(() => {
  for (const c of clients) c.close();
});

/** The shells a client heard, decoded, each with when it came. */
const shellsOf = (c: RelayClient): { shell: RoomShell; heard: Heard }[] => c.all('shell').map((heard) => ({ shell: decodeShell(heard.msg.s)!, heard }));

/** A shovel's scoop of DIG_CELLS_MAX cells of ten digits each (near the world's far end, packed by WORLD_DIMS), 32 × 2 voxels: within DIG_SPAN_MAX. */
const FAT_SCOOP = Array.from({ length: DIG_CELLS_MAX }, (_, k) => (2500 * WORLD_DIMS.y + 150 + (k >> 5)) * WORLD_DIMS.x + 2500 + (k & 31));

test('a newcomer is turned away for a page of the first protocol, and welcomed for one of this', async () => {
  test.setTimeout(60_000);
  const room = await makeRoom();
  const old = client(room, 'Old', { v: 1 });
  const refused = await old.next('refused');
  expect(refused.msg.reason).toBe('version');
  await RelayClient.until(() => old.closed !== null, 10_000, 'the old page let go');
  expect(old.closed).toEqual({ code: 1008, reason: 'version' });
  expect(old.all('welcome')).toEqual([]);
  const now = client(room, 'Now', { v: PROTOCOL });
  const welcome = await now.next('welcome');
  expect(welcome.msg.you).toBe(0);
});

test("the log grown to its cap by the players' scoops, a newcomer's welcome carries it whole", async () => {
  test.setTimeout(180_000);
  // Seven players dig fat scoops as fast as the room takes them (DIG_RATE a second a seat); the eighth seat is the newcomer's.
  const room = await makeRoom();
  const diggers = Array.from({ length: 7 }, (_, k) => client(room, `Digger ${k}`));
  await Promise.all(diggers.map((d) => d.next('welcome')));
  diggers[0].say({ t: 'config', config: { map: 'corridor', intensity: 'off' } });
  await diggers[0].next('config');
  diggers[0].say({ t: 'start' });
  await Promise.all(diggers.map((d) => d.next('start')));
  // A scoop is taken once a match has begun on the world: from the start.
  const perSeat = 260;
  await Promise.all(
    diggers.map(async (d) => {
      for (let k = 0; k < perSeat; k++) {
        d.say({ t: 'dig', c: FAT_SCOOP });
        // 7.5 a second, under the room's 8 (and its burst of 16 first).
        await new Promise((r) => setTimeout(r, k < 14 ? 5 : 134));
      }
    }),
  );
  // Each digger hears the others' (relayed as taken): how many the room took in all is what the
  // second heard, and the second's own as the first heard them.
  await new Promise((r) => setTimeout(r, 500));
  const second = diggers[1].all('welcome')[0].msg.you;
  const taken = diggers[1].all('dig').length + diggers[0].all('dig').filter((h) => h.msg.d[0] === second).length;
  const newcomer = client(room, 'Newcomer');
  const welcome = await newcomer.next('welcome', 0, 60_000);
  const log = welcome.msg.log;
  const chars = log.shells.reduce((n, e) => n + JSON.stringify(e).length + 1, 0) + log.digs.reduce((n, e) => n + JSON.stringify(e).length + 1, 0);
  const entry = JSON.stringify(log.digs[0]).length + 1;
  console.log(`the log at its cap: ${log.digs.length} scoops of ${entry} characters (${taken} taken by the room), ${chars} of LOG_CHARS_MAX ${LOG_CHARS_MAX}; the welcome ${welcome.chars} characters of ROOM_TEXT_MAX ${ROOM_TEXT_MAX}`);
  // More taken than the log keeps: its oldest scoops went, and it sits within a scoop of its cap.
  expect(taken).toBeGreaterThan(log.digs.length);
  expect(chars).toBeLessThanOrEqual(LOG_CHARS_MAX);
  expect(chars).toBeGreaterThan(LOG_CHARS_MAX - entry);
  expect(welcome.chars).toBeGreaterThan(LOG_CHARS_MAX);
  expect(welcome.chars).toBeLessThanOrEqual(ROOM_TEXT_MAX);
  // Whole: every scoop the newcomer was given is one the room relayed, the newest last.
  const relayed = diggers[0].all('dig').at(-1)!.msg.d;
  expect(log.digs.some((d) => d[1] === relayed[1] && d[0] === relayed[0])).toBe(true);
  for (const c of [...diggers, newcomer]) c.close();
});

test("every shell told before it lands, its ids running on without a gap, the same to both players, and none once the match is won", async () => {
  test.setTimeout(120_000);
  const room = await makeRoom();
  const a = client(room, 'A');
  await a.next('welcome');
  const b = client(room, 'B');
  const bw = await b.next('welcome');
  a.say({ t: 'config', config: { map: 'corridor', intensity: 'heavy', killTarget: 1 } });
  await b.next('config');
  a.say({ t: 'start' });
  const start = await b.next('start');
  const startAt = start.msg.match.startAt;
  // Six shells on both, then A claims B's head: one kill wins.
  await RelayClient.until(() => shellsOf(a).length >= 6 && shellsOf(b).length >= 6, 60_000, 'six shells told');
  await RelayClient.until(() => Date.now() > startAt + 2500, 10_000, 'past the start and its protection');
  for (let k = 0; k < 3 && a.all('over').length === 0; k++) {
    a.say({ t: 'hit', v: bw.msg.you, z: 'head' });
    await new Promise((r) => setTimeout(r, 200));
  }
  const over = [await a.next('over'), await b.next('over')];
  // The room back in its lobby OVER_MS later: nothing more told meanwhile.
  await Promise.all([a.next('end', 0, 20_000), b.next('end', 0, 20_000)]);
  const told = [shellsOf(a), shellsOf(b)];
  const ids = told.map((t) => t.map((s) => s.shell.id));
  const leads = told.flatMap((t) => t.map((s) => s.shell.landAt - s.heard.at));
  console.log(`${ids[0].length} shells told before the win (ids ${ids[0][0]}-${ids[0].at(-1)}), each ${Math.min(...leads)}-${Math.max(...leads)} ms before it landed; won ${((over[0].at - startAt) / 1000).toFixed(1)} s into the match`);
  expect(ids[1]).toEqual(ids[0]);
  expect(ids[0]).toEqual(Array.from({ length: ids[0].length }, (_, k) => 1 + k));
  // Told its lead before it lands, near enough (the room tells each within a tick of it): never after.
  expect(Math.min(...leads)).toBeGreaterThan(1000 * SHELLING.leadS - 200);
  expect(Math.max(...leads)).toBeLessThanOrEqual(1000 * SHELLING.leadS + 5);
  // None after the win, through the room's going back to its lobby.
  for (const [k, c] of [a, b].entries()) expect(c.heard.slice(c.heard.indexOf(over[k])).filter((h) => h.msg.t === 'shell')).toEqual([]);

  // The owner leaves mid-match: the shelling goes on, and the next owner ends the match.
  a.say({ t: 'start' });
  await b.next('start', 1);
  const before = shellsOf(b).length;
  await RelayClient.until(() => shellsOf(b).length >= before + 2, 30_000, 'the rematch shelling');
  // Its ids run on from the last match's.
  expect(shellsOf(b)[before].shell.id).toBe(ids[0].at(-1)! + 1);
  a.close();
  await RelayClient.until(() => b.all('roster').some((r) => r.msg.owner === bw.msg.you), 10_000, 'B the owner');
  const left = shellsOf(b).length;
  await RelayClient.until(() => shellsOf(b).length >= left + 2, 30_000, 'the shelling going on with its owner gone');
  b.say({ t: 'end' });
  await b.next('end', 1, 10_000);
  const after = shellsOf(b).map((s) => s.shell.id);
  expect(after).toEqual(Array.from({ length: after.length }, (_, k) => 1 + k));

  // The last one out: the room forgets its world. A fresh join has an empty log, and its first shell is 1.
  b.close();
  await RelayClient.until(() => b.closed !== null, 10_000, 'the last one gone');
  await new Promise((r) => setTimeout(r, 500));
  const c = client(room, 'C');
  const fresh = await c.next('welcome');
  expect(fresh.msg.log).toEqual({ shells: [], digs: [] });
  expect([fresh.msg.you, fresh.msg.owner, fresh.msg.phase]).toEqual([0, 0, 'lobby']);
  c.say({ t: 'config', config: { map: 'corridor', intensity: 'heavy' } });
  await c.next('config');
  c.say({ t: 'start' });
  const first = await c.next('shell', 0, 30_000);
  expect(decodeShell(first.msg.s)!.id).toBe(1);
  c.close();
});
