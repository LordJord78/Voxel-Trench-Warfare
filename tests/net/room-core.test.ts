import { describe, expect, it } from 'vitest';
import { DIG_CELLS_MAX, encodeShell, encodeShot, encodeState, parseRoom, PROTOCOL, type RoomMsg, type WireShell } from '../../src/net/protocol';
import { PROTECT_MS } from '../../src/net/match-rules';
import { AWAY_MS, COUNTDOWN_MS, LOG_CHARS_MAX, OVER_MS, RoomCore, type Conn } from '../../src/net/room-core';
import { SHELL_FIELDS } from '../../src/net/shell-fields';
import { Shelling, shellingSeed } from '../../src/net/shelling';

class Fake implements Conn {
  readonly got: RoomMsg[] = [];
  closed: string | null = null;
  send(text: string): void {
    const m = parseRoom(text);
    if (!m) throw new Error(`the room sent something malformed: ${text}`);
    this.got.push(m);
  }
  close(_code: number, reason: string): void {
    this.closed = reason;
  }
  last<T extends RoomMsg['t']>(t: T): Extract<RoomMsg, { t: T }> | undefined {
    return [...this.got].reverse().find((m) => m.t === t) as Extract<RoomMsg, { t: T }> | undefined;
  }
}

const say = (room: RoomCore, c: Fake, msg: object, now: number) => room.message(c, JSON.stringify(msg), now);

function join(room: RoomCore, name: string, now = 0, build = 'b1'): Fake {
  const c = new Fake();
  room.open(c, now);
  say(room, c, { t: 'hello', v: PROTOCOL, build, name }, now);
  return c;
}

/** Every shell `c` has been told, in order. */
const shells = (c: Fake): WireShell[] => c.got.flatMap((m) => (m.t === 'shell' ? [m.s] : []));

/** The room ticked every 50 ms over (from, to]: each shell `c` was told then, with the room's clock it was told at. */
function tickTo(room: RoomCore, from: number, to: number, c: Fake): { s: WireShell; at: number }[] {
  const told: { s: WireShell; at: number }[] = [];
  for (let now = from + 50; now <= to; now += 50) {
    const before = c.got.length;
    room.tick(now);
    for (const m of c.got.slice(before)) if (m.t === 'shell') told.push({ s: m.s, at: now });
  }
  return told;
}

/** The shells a match started at `startAt` on `map` (seed `seed`) tells by `throughS`, as the wire carries them. */
const expected = (map: string, seed: number, startAt: number, throughS: number, intensity: 'light' | 'heavy' = 'heavy', firstId = 1) =>
  new Shelling(SHELL_FIELDS[map], shellingSeed(startAt, seed), intensity, firstId).between(0, throughS).map((s) => encodeShell(s, startAt));

const state = { tick: 1, position: [1, 2, 3] as [number, number, number], velocity: [0, 0, 0] as [number, number, number], yaw: 90, pitch: 0, stance: 0, height: 1.8, flags: 1 };

describe('a room', () => {
  it('seats players on alternating teams, the first as owner, and tells everyone', () => {
    const room = new RoomCore('KXQRT');
    const a = join(room, 'Jord');
    const b = join(room, 'Sam', 10);
    const c = join(room, 'Lee', 20);
    expect(a.last('welcome')).toMatchObject({ you: 0, owner: 0, room: 'KXQRT', phase: 'lobby' });
    expect(room.seats().map((s) => [s.id, s.name, s.team])).toEqual([[0, 'Jord', 'red'], [1, 'Sam', 'blue'], [2, 'Lee', 'red']]);
    expect(a.last('roster')!.seats).toHaveLength(3);
    expect(c.last('welcome')!.seats).toHaveLength(3);
    // A team picked unreadies its player; everyone hears.
    say(room, c, { t: 'ready', ready: true }, 30);
    say(room, c, { t: 'team', team: 'blue' }, 40);
    expect(b.last('roster')!.seats.find((s) => s.id === 2)).toMatchObject({ team: 'blue', ready: false });
  });

  it('refuses a ninth player, and one of another build', () => {
    const room = new RoomCore('ROOMS');
    for (let i = 0; i < 8; i++) join(room, `p${i}`, i);
    const ninth = join(room, 'late', 9);
    expect(ninth.last('refused')).toEqual({ t: 'refused', reason: 'full' });
    expect(ninth.closed).toBe('full');
    const other = new RoomCore('OTHER');
    join(other, 'a');
    const stale = join(other, 'b', 1, 'b0');
    expect(stale.last('refused')).toEqual({ t: 'refused', reason: 'version' });
  });

  it('gives the owner alone the settings and the start, and passes ownership on', () => {
    const room = new RoomCore('OWNER');
    const a = join(room, 'a');
    const b = join(room, 'b', 1);
    say(room, b, { t: 'config', config: { killTarget: 5 } }, 2);
    say(room, b, { t: 'start' }, 2);
    expect(room.config.killTarget).toBe(30);
    expect(room.phase).toBe('lobby');
    say(room, a, { t: 'config', config: { killTarget: 5, intensity: 'heavy' } }, 3);
    expect(b.last('config')!.config).toMatchObject({ killTarget: 5, intensity: 'heavy' });
    room.close(a);
    expect(room.owner).toBe(1);
    expect(b.last('roster')!.owner).toBe(1);
  });

  it('starts after a countdown, relays every state in one frame a tick, and ends back in the lobby', () => {
    const room = new RoomCore('MATCH');
    const a = join(room, 'a');
    const b = join(room, 'b', 1);
    say(room, a, { t: 'start' }, 100);
    expect(b.last('start')!.match).toMatchObject({ startAt: 100 + COUNTDOWN_MS, seed: 7 });
    say(room, a, { t: 's', s: encodeState(state) }, 3200);
    say(room, b, { t: 's', s: encodeState({ ...state, position: [4, 5, 6] }) }, 3210);
    room.tick(3250);
    const f = a.last('f')!;
    expect(f.s).toBe(3250);
    expect(f.ps.map((p) => p[0])).toEqual([0, 1]);
    expect(f.ps[1].slice(2, 5)).toEqual([4000, 5000, 6000]);
    // Late to the match: welcomed into it.
    const c = join(room, 'c', 3300);
    expect(c.last('welcome')).toMatchObject({ phase: 'playing' });
    expect(c.last('welcome')!.match!.startAt).toBe(100 + COUNTDOWN_MS);
    say(room, a, { t: 'end' }, 4000);
    expect(room.phase).toBe('lobby');
    expect(b.last('end')).toEqual({ t: 'end' });
  });

  it('marks a quiet player away, and back when they are heard again', () => {
    const room = new RoomCore('QUIET');
    const a = join(room, 'a');
    const b = join(room, 'b');
    say(room, a, { t: 'start' }, 0);
    say(room, b, { t: 's', s: encodeState(state) }, 100);
    for (let now = 200; now < 200 + AWAY_MS + 200; now += 50) {
      say(room, a, { t: 's', s: encodeState(state) }, now);
      room.tick(now);
    }
    expect(a.last('roster')!.seats.find((s) => s.id === 1)!.away).toBe(true);
    expect(a.last('f')!.ps.map((p) => p[0])).not.toContain(1);
    say(room, b, { t: 's', s: encodeState(state) }, 5000);
    expect(a.last('roster')!.seats.find((s) => s.id === 1)!.away).toBe(false);
    say(room, b, { t: 'away', away: true }, 5100);
    expect(a.last('roster')!.seats.find((s) => s.id === 1)!.away).toBe(true);
  });

  it('answers pings with its clock, closes a socket that never says hello, and cuts off a flood', () => {
    const room = new RoomCore('PINGS');
    const a = join(room, 'a');
    say(room, a, { t: 'ping', c: 123 }, 456);
    expect(a.last('pong')).toEqual({ t: 'pong', c: 123, s: 456 });
    const mute = new Fake();
    room.open(mute, 0);
    room.tick(20_000);
    expect(mute.closed).toBe('no hello');
    for (let k = 0; k < 400; k++) say(room, a, { t: 'ping', c: k }, 1000);
    expect(a.closed).toBe('too many messages');
  });

  it("relays shots, takes a shooter's hits to a death and a score, and ends at the kill target", () => {
    const room = new RoomCore('FIGHT');
    const a = join(room, 'a');
    const b = join(room, 'b');
    say(room, a, { t: 'config', config: { killTarget: 1 } }, 0);
    say(room, a, { t: 'start' }, 0);
    const begun = COUNTDOWN_MS + PROTECT_MS + 1;
    const shot = encodeShot({ tick: 5, origin: [1, 2, 3], dir: [1, 0, 0], tracer: false });
    say(room, a, { t: 's', s: encodeState(state), sh: [shot] }, begun);
    room.tick(begun + 10);
    expect(b.last('f')!.sh).toEqual([[0, ...shot]]);
    room.tick(begun + 60);
    expect(b.last('f')!.sh).toEqual([]);
    // A torso, then a head: hurt (told to the hurt alone), then dead, scored, and won.
    say(room, a, { t: 'hit', v: 1, z: 'torso' }, begun + 100);
    expect(b.last('hurt')).toEqual({ t: 'hurt', hp: 45, from: 0 });
    expect(a.last('hurt')).toBeUndefined();
    say(room, a, { t: 'hit', v: 1, z: 'head' }, begun + 200);
    expect(a.last('death')).toEqual({ t: 'death', v: 1, k: 0, z: 'head', tk: false, c: 'round' });
    expect(a.last('score')).toMatchObject({ red: 1, blue: 0 });
    expect(b.last('over')).toEqual({ t: 'over', winner: 'red', red: 1, blue: 0 });
    room.tick(begun + 200 + OVER_MS + 1);
    expect(room.phase).toBe('lobby');
    expect(b.last('end')).toEqual({ t: 'end' });
  });

  it('brings the dead back, and hears the battle hurt a player', () => {
    const room = new RoomCore('AGAIN');
    const a = join(room, 'a');
    const b = join(room, 'b');
    say(room, a, { t: 'config', config: { respawnS: 2 } }, 0);
    say(room, a, { t: 'start' }, 0);
    const t = COUNTDOWN_MS + PROTECT_MS + 1;
    say(room, b, { t: 'hurt', a: 150, c: 'shell' }, t);
    expect(a.last('death')).toEqual({ t: 'death', v: 1, k: -1, z: null, tk: false, c: 'shell' });
    room.tick(t + 1999);
    expect(a.last('respawn')).toBeUndefined();
    room.tick(t + 2000);
    expect(a.last('respawn')).toMatchObject({ id: 1 });
  });
});

describe("a room's shelling and its log", () => {
  /** A room of two, a and b, its owner a, at `intensity`; the start called at `at`. */
  function match(code: string, intensity: 'off' | 'light' | 'heavy', at = 0, config: object = {}) {
    const room = new RoomCore(code);
    const a = join(room, 'a');
    const b = join(room, 'b');
    say(room, a, { t: 'config', config: { intensity, ...config } }, 0);
    say(room, a, { t: 'start' }, at);
    return { room, a, b, startAt: at + COUNTDOWN_MS };
  }

  it('tells everyone each shell once, 1.5 s before it lands', () => {
    const { room, a, b, startAt } = match('SHELL', 'heavy');
    const told = tickTo(room, 0, startAt + 63_000, a);
    expect(shells(b)).toEqual(shells(a));
    expect(told.map((t) => t.s[0])).toEqual(told.map((_, i) => i + 1));
    for (const { s, at } of told) {
      expect(s[1] - at, `shell ${s[0]}`).toBeGreaterThanOrEqual(1450);
      expect(s[1] - at, `shell ${s[0]}`).toBeLessThanOrEqual(1550);
    }
    // Told through landS 64.5: the room's own schedule over its map's field, from the match's seed.
    expect(told.length).toBeGreaterThanOrEqual(16);
    expect(told.length).toBeLessThanOrEqual(25);
    expect(told.map((t) => t.s)).toEqual(expected('ravine', 7, startAt, 64.5));
  });

  it('refuses a hello of protocol 1', () => {
    const room = new RoomCore('PROTO');
    const old = new Fake();
    room.open(old, 0);
    say(room, old, { t: 'hello', v: 1, build: 'b1', name: 'old' }, 0);
    expect(old.last('refused')).toEqual({ t: 'refused', reason: 'version' });
    expect(old.closed).toBe('version');
    expect(room.seats()).toEqual([]);
  });

  it("relays a dig to the others, stamped with the room's clock, and logs it, from a match's start on its world until the map changes", () => {
    const room = new RoomCore('DIGS');
    const a = join(room, 'a');
    const b = join(room, 'b');
    const relayed = () => b.got.flatMap((m) => (m.t === 'dig' ? [m.d] : []));
    // None before a match has begun on the room's world.
    say(room, a, { t: 'dig', c: [9] }, 100);
    expect(relayed()).toEqual([]);
    // From its start, the countdown too (a digger whose clock runs a little ahead of the room's).
    say(room, a, { t: 'start' }, 1000);
    say(room, a, { t: 'dig', c: [8] }, 1000 + COUNTDOWN_MS - 1);
    say(room, a, { t: 'dig', c: [1, 2, 3] }, 12_000);
    expect(relayed()).toEqual([[0, 1000 + COUNTDOWN_MS - 1, 8], [0, 12_000, 1, 2, 3]]);
    expect(a.last('dig')).toBeUndefined();
    // The owner ends the match. A scoop its digger sent before the end reached them comes after it: the
    // digger dug it, and the world is the room's still, so it is stamped, relayed and logged.
    say(room, a, { t: 'end' }, 13_000);
    expect(room.phase).toBe('lobby');
    say(room, a, { t: 'dig', c: [4] }, 13_080);
    expect(relayed().at(-1)).toEqual([0, 13_080, 4]);
    // The same after a match won, back in the lobby OVER_MS after its winning kill.
    say(room, a, { t: 'config', config: { killTarget: 1, intensity: 'off' } }, 13_500);
    say(room, a, { t: 'start' }, 14_000);
    const killAt = 14_000 + COUNTDOWN_MS + PROTECT_MS + 100;
    say(room, a, { t: 'hit', v: 1, z: 'head' }, killAt);
    expect(a.last('over')).toMatchObject({ winner: 'red' });
    const overAt = killAt + OVER_MS;
    tickTo(room, overAt - 100, overAt + 50, a);
    expect(room.phase).toBe('lobby');
    say(room, b, { t: 'dig', c: [6] }, overAt + 100);
    expect(a.got.filter((m) => m.t === 'dig').at(-1)).toEqual({ t: 'dig', d: [1, overAt + 100, 6] });
    const c = join(room, 'c', overAt + 200);
    expect(c.last('welcome')!.log).toEqual({
      shells: [],
      digs: [[0, 1000 + COUNTDOWN_MS - 1, 8], [0, 12_000, 1, 2, 3], [0, 13_080, 4], [1, overAt + 100, 6]],
    });
    // Another map is another world: a scoop of the last one's, still on its way, is dropped, until a
    // match begins on the new one.
    say(room, a, { t: 'config', config: { map: 'corridor' } }, overAt + 300);
    say(room, b, { t: 'dig', c: [7] }, overAt + 400);
    expect(a.got.filter((m) => m.t === 'dig').at(-1)).toEqual({ t: 'dig', d: [1, overAt + 100, 6] });
    expect(join(room, 'e', overAt + 500).last('welcome')!.log).toEqual({ shells: [], digs: [] });
    say(room, a, { t: 'start' }, overAt + 600);
    say(room, b, { t: 'dig', c: [5] }, overAt + 700);
    expect(a.got.filter((m) => m.t === 'dig').at(-1)).toEqual({ t: 'dig', d: [1, overAt + 700, 5] });
  });

  it('welcomes a late joiner with the log so far, a shell still in the air among it', () => {
    const { room, a } = match('LATER', 'heavy');
    tickTo(room, 0, 23_000, a);
    expect(shells(a).length).toBeGreaterThan(3);
    // On to the next shell told, then half a second more.
    let now = 23_000;
    const before = shells(a).length;
    while (shells(a).length === before) room.tick((now += 50));
    expect(tickTo(room, now, now + 500, a)).toEqual([]);
    const c = join(room, 'c', now + 500);
    const log = c.last('welcome')!.log;
    expect(log.shells).toEqual(shells(a));
    expect(log.shells.at(-1)![1]).toBeGreaterThan(now + 500);
    expect(log.digs).toEqual([]);
  });

  it('keeps its log through a rematch on the same map, numbering on; a new map clears it, and so does the last player leaving', () => {
    const { room, a, b } = match('AGAIN', 'heavy');
    tickTo(room, 0, 20_000, a);
    const first = shells(a);
    expect(first.length).toBeGreaterThan(3);
    say(room, a, { t: 'end' }, 20_000);
    say(room, a, { t: 'start' }, 21_000);
    say(room, b, { t: 'dig', c: [5] }, 30_000);
    tickTo(room, 21_000, 40_000, a);
    const both = shells(a);
    expect(both.length).toBeGreaterThan(first.length);
    expect(both[first.length][0]).toBe(first.at(-1)![0] + 1);
    expect(both.map((s) => s[0])).toEqual(both.map((_, i) => i + 1));
    expect(both.slice(first.length)).toEqual(expected('ravine', 7, 21_000 + COUNTDOWN_MS, (40_000 - 21_000 - COUNTDOWN_MS) / 1000 + 1.5, 'heavy', first.length + 1));
    const c = join(room, 'c', 40_000);
    expect(c.last('welcome')!.log).toEqual({ shells: both, digs: [[1, 30_000, 5]] });
    // Back in the lobby: the same map set again keeps it, another clears it.
    say(room, a, { t: 'end' }, 40_000);
    say(room, a, { t: 'config', config: { map: 'ravine' } }, 40_100);
    const d = join(room, 'd', 40_200);
    expect(d.last('welcome')!.log.shells).toEqual(both);
    say(room, a, { t: 'config', config: { map: 'corridor' } }, 40_300);
    const e = join(room, 'e', 40_400);
    expect(e.last('welcome')!.log).toEqual({ shells: [], digs: [] });
    // The Corridor's shells, from its own field and seed, numbered from 1.
    say(room, a, { t: 'start' }, 41_000);
    const told = tickTo(room, 41_000, 60_000, a).map((t) => t.s);
    expect(told[0][0]).toBe(1);
    expect(told).toEqual(expected('corridor', 11, 41_000 + COUNTDOWN_MS, (60_000 - 41_000 - COUNTDOWN_MS) / 1000 + 1.5));
    // Everyone gone: the next to come finds no log, and its first shell is 1 again.
    for (const p of [a, b, c, d, e]) room.close(p);
    expect(room.empty).toBe(true);
    const f = join(room, 'f', 70_000);
    expect(f.last('welcome')!.log).toEqual({ shells: [], digs: [] });
    say(room, f, { t: 'start' }, 70_000);
    tickTo(room, 70_000, 90_000, f);
    expect(shells(f)[0][0]).toBe(1);
  });

  it('keeps its log under LOG_CHARS_MAX, dropping its oldest digs, never a shell', () => {
    const { room, a, b } = match('FULLS', 'heavy');
    tickTo(room, 0, 30_000, a);
    expect(shells(a).length).toBeGreaterThan(5);
    const cells = Array.from({ length: DIG_CELLS_MAX }, (_, i) => 2147483647 - i);
    const entry = JSON.stringify([0, 30_000, ...cells]).length + 1;
    const sent = Math.ceil(LOG_CHARS_MAX / entry) + 50;
    // Fifty scoops a second, within the room's rate, and the shelling ticking on through them.
    let now = 30_000;
    for (let k = 0; k < sent; k++) {
      now += 20;
      say(room, a, { t: 'dig', c: cells }, now);
      if (k % 3 === 2) room.tick(now);
    }
    const relayed = b.got.flatMap((m) => (m.t === 'dig' ? [m.d] : []));
    expect(relayed).toHaveLength(sent);
    const log = join(room, 'c', now + 10).last('welcome')!.log;
    expect(log.shells).toEqual(shells(a));
    expect(log.shells.length).toBeGreaterThan(10);
    const chars = [...log.shells, ...log.digs].reduce((n, e) => n + JSON.stringify(e).length + 1, 0);
    expect(chars).toBeLessThanOrEqual(LOG_CHARS_MAX);
    // Only as many dropped as it had to: the newest kept, in order.
    expect(chars).toBeGreaterThan(LOG_CHARS_MAX - 2 * entry);
    expect(log.digs.length).toBeLessThan(sent);
    expect(log.digs).toEqual(relayed.slice(relayed.length - log.digs.length));
  });

  it('shells nothing when off, nor once the match is won', () => {
    const off = match('QUIET', 'off');
    tickTo(off.room, 0, off.startAt + 63_000, off.a);
    expect(shells(off.a)).toEqual([]);
    const won = match('WONIT', 'heavy', 0, { killTarget: 1 });
    tickTo(won.room, 0, 20_000, won.a);
    const before = shells(won.a).length;
    expect(before).toBeGreaterThan(3);
    say(won.room, won.a, { t: 'hit', v: 1, z: 'head' }, 20_000);
    expect(won.a.last('over')).toMatchObject({ winner: 'red' });
    tickTo(won.room, 20_000, 20_000 + OVER_MS - 100, won.a);
    expect(won.room.phase).toBe('playing');
    expect(shells(won.a)).toHaveLength(before);
  });
});
