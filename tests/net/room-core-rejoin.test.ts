import { describe, expect, it } from 'vitest';
import { PROTECT_MS } from '../../src/net/match-rules';
import { parseClient, PROTOCOL } from '../../src/net/protocol';
import { COUNTDOWN_MS, OVER_MS, REJOIN_MS, RoomCore } from '../../src/net/room-core';
import { Fake, join, say, token } from '../support/fake-room';

// A friend who comes back keeps their place (the release audit's ROBUST-2, ROBUST-3): the page says
// its rejoin token in its hello, and for REJOIN_MS after a seat leaves the room gives that token the
// seat's team, its kills and deaths in the match, and the host role if nobody has been made host by an
// action since. Without the token, a newcomer, as before.

const teams = (room: RoomCore) => room.seats().map((s) => [s.name, s.team]);
const tallies = (c: Fake) => c.last('score')?.ps ?? [];

describe('a friend who comes back', () => {
  it("keeps their team and their kills and deaths through a reload mid-match, though balancing would put them on the other side", () => {
    const room = new RoomCore('RELOD');
    const t = { A: token('a'), B: token('b'), C: token('c'), D: token('d'), E: token('e') };
    const A = join(room, 'A', 0, t.A);
    join(room, 'B', 0, t.B);
    const C = join(room, 'C', 0, t.C);
    let D = join(room, 'D', 0, t.D);
    // Friends pick their sides: Blue has three.
    say(room, C, { t: 'team', team: 'blue' }, 10);
    const E = join(room, 'E', 20, t.E);
    expect(teams(room)).toEqual([['A', 'red'], ['B', 'blue'], ['C', 'blue'], ['D', 'blue'], ['E', 'red']]);
    say(room, A, { t: 'start' }, 100);
    // D kills A and E, and is killed by E.
    const at = 100 + COUNTDOWN_MS + PROTECT_MS + 1;
    say(room, D, { t: 'hit', v: 0, z: 'head' }, at);
    say(room, D, { t: 'hit', v: 4, z: 'head' }, at + 10);
    say(room, E, { t: 'hit', v: 3, z: 'head' }, at + 20);
    expect(tallies(A)).toContainEqual([3, 2, 1]);
    // D's line drops, and the page reloads: fifteen seconds of a world generated, then its hello.
    room.close(D, at + 1_000);
    D = join(room, 'D', at + 16_000, t.D);
    expect(D.last('welcome')).toMatchObject({ you: 3, phase: 'playing' });
    expect(teams(room)).toEqual([['A', 'red'], ['B', 'blue'], ['C', 'blue'], ['D', 'blue'], ['E', 'red']]);
    // Their tallies are theirs again, told to everyone.
    expect(tallies(D)).toContainEqual([3, 2, 1]);
    expect(tallies(A)).toContainEqual([3, 2, 1]);
    expect(room.rules!.fighters.get(3)).toMatchObject({ team: 'blue', kills: 2, deaths: 1 });
    // The score is the teams', as it was.
    expect(A.last('score')).toMatchObject({ red: 1, blue: 2 });
  });

  it('brings the host back as host, and every team as it was, through a map change that reloads every page', () => {
    const room = new RoomCore('MAPCH');
    const t = { host: token('1'), sam: token('2'), lee: token('3') };
    const host = join(room, 'Host', 0, t.host);
    const sam = join(room, 'Sam', 10, t.sam);
    const lee = join(room, 'Lee', 20, t.lee);
    say(room, lee, { t: 'team', team: 'blue' }, 30);
    expect(teams(room)).toEqual([['Host', 'red'], ['Sam', 'blue'], ['Lee', 'blue']]);
    // The host picks the Corridor: every page goes there, its own first.
    say(room, host, { t: 'config', config: { map: 'corridor' } }, 1_000);
    room.close(host, 1_100);
    expect(room.owner).toBe(1);
    room.close(lee, 1_200);
    room.close(sam, 1_300);
    expect(room.empty).toBe(true);
    // The friends' pages are back first: Sam is host meanwhile; the host's return takes it back.
    const sam2 = join(room, 'Sam', 9_000, t.sam);
    expect(sam2.last('welcome')).toMatchObject({ you: 1, owner: 1 });
    const lee2 = join(room, 'Lee', 9_500, t.lee);
    const host2 = join(room, 'Host', 11_000, t.host);
    expect(host2.last('welcome')).toMatchObject({ you: 0, owner: 0 });
    expect(room.owner).toBe(0);
    expect(lee2.last('roster')).toMatchObject({ owner: 0 });
    expect(teams(room)).toEqual([['Host', 'red'], ['Sam', 'blue'], ['Lee', 'blue']]);
    expect(room.config.map).toBe('corridor');
    // The host's settings and start are theirs again.
    say(room, host2, { t: 'start' }, 12_000);
    expect(room.phase).toBe('playing');
  });

  it("keeps the map, the host and every team through a map change though the room's object is evicted while nobody is in it: its memory, kept and restored", () => {
    const room = new RoomCore('EVICT');
    const t = { host: token('1'), sam: token('2'), lee: token('3') };
    const host = join(room, 'Host', 0, t.host);
    const sam = join(room, 'Sam', 10, t.sam);
    const lee = join(room, 'Lee', 20, t.lee);
    say(room, lee, { t: 'team', team: 'blue' }, 30);
    say(room, host, { t: 'config', config: { map: 'corridor', killTarget: 12 } }, 1_000);
    room.close(host, 1_100);
    room.close(lee, 1_200);
    room.close(sam, 1_300);
    // Nobody in it, no timer, no request: the Durable Object is evicted ten seconds on, and its memory
    // with it. What it put in storage is all the next one has (here through JSON, stricter than storage's
    // structured clone).
    const kept = JSON.parse(JSON.stringify(room.snapshot()));
    const again = new RoomCore('EVICT');
    again.restore(kept);
    // Every page is back from its world fifteen seconds on: the room's map is still the Corridor (so no
    // page is sent back to Sukhyi Yar), the host is host, and every team as it was.
    const sam2 = join(again, 'Sam', 15_000, t.sam);
    expect(sam2.last('welcome')!.config).toMatchObject({ map: 'corridor', killTarget: 12 });
    join(again, 'Lee', 16_000, t.lee);
    const host2 = join(again, 'Host', 20_000, t.host);
    expect(host2.last('welcome')).toMatchObject({ you: 0, owner: 0 });
    expect(teams(again)).toEqual([['Host', 'red'], ['Sam', 'blue'], ['Lee', 'blue']]);
    say(again, host2, { t: 'start' }, 21_000);
    expect(again.phase).toBe('playing');
    // Restored late, the seats that left are forgotten as ever, and their claim on the host role; the
    // room's settings are its own until it is forgotten (a day after its last player left).
    const later = new RoomCore('EVICT');
    later.restore(JSON.parse(JSON.stringify(room.snapshot())));
    const lee3 = join(later, 'Lee', 1_300 + REJOIN_MS + 1, t.lee);
    const host3 = join(later, 'Host', 1_300 + REJOIN_MS + 2, t.host);
    expect(lee3.last('welcome')).toMatchObject({ you: 0, owner: 0, config: { map: 'corridor' } });
    expect(host3.last('welcome')).toMatchObject({ you: 1, owner: 0 });
    expect(teams(later)).toEqual([['Lee', 'red'], ['Host', 'blue']]);
  });

  it("gives the host role back to whoever held it as they left, by succession too, unless someone has been made host by an action since; a claim held only in an earlier host's absence lapses on their return", () => {
    const room = new RoomCore('CHAIN');
    const t = { a: token('a'), b: token('b'), c: token('c'), d: token('d') };
    const a = join(room, 'a', 0, t.a);
    let b = join(room, 'b', 10, t.b);
    join(room, 'c', 20, t.c);
    join(room, 'd', 30, t.d);
    // A's line drops: B is host by succession. B reloads before anyone acts as host: B is host again, not C.
    room.close(a, 1_000);
    expect(room.owner).toBe(1);
    room.close(b, 2_000);
    expect(room.owner).toBe(2);
    b = join(room, 'b', 12_000, t.b);
    expect(b.last('welcome')).toMatchObject({ you: 1, owner: 1 });
    // A is back: A's claim is the elder, so A is host; B's, held only in A's absence, lapses with it.
    join(room, 'a', 20_000, t.a);
    expect(room.owner).toBe(0);
    room.close(b, 21_000);
    join(room, 'b', 30_000, t.b);
    expect(room.owner).toBe(0);

    // A before B: A leaves, B holds the role, B leaves, C holds it. A is back first, then B: A stays host.
    const chain = new RoomCore('CHAIM');
    const p = { a: join(chain, 'a', 0, t.a), b: join(chain, 'b', 10, t.b), c: join(chain, 'c', 20, t.c) };
    chain.close(p.a, 1_000);
    chain.close(p.b, 2_000);
    expect(chain.owner).toBe(2);
    join(chain, 'a', 10_000, t.a);
    expect(chain.owner).toBe(0);
    join(chain, 'b', 11_000, t.b);
    expect(chain.owner).toBe(0);
    // C, host by succession, makes it theirs by an action while A is away: neither A nor B has it back.
    const third = new RoomCore('CHAIN');
    const q = { a: join(third, 'a', 0, t.a), b: join(third, 'b', 10, t.b), c: join(third, 'c', 20, t.c) };
    third.close(q.a, 1_000);
    third.close(q.b, 2_000);
    say(third, q.c, { t: 'ready', ready: true }, 2_500);
    expect(third.owner).toBe(2);
    say(third, q.c, { t: 'config', config: { killTarget: 9 } }, 3_000);
    join(third, 'b', 10_000, t.b);
    join(third, 'a', 11_000, t.a);
    expect(third.owner).toBe(2);
  });

  it('is told, joining or back in the seconds after a win, who won, as the others were; one who joins before, nothing of it', () => {
    const room = new RoomCore('WONIT');
    const a = join(room, 'a', 0, token('a'));
    let b = join(room, 'b', 0, token('b'));
    say(room, a, { t: 'config', config: { killTarget: 1 } }, 0);
    say(room, a, { t: 'start' }, 0);
    const begun = COUNTDOWN_MS + PROTECT_MS + 1;
    const early = join(room, 'early', begun - 500);
    expect(early.last('over')).toBeUndefined();
    say(room, a, { t: 'hit', v: 1, z: 'head' }, begun);
    const won = { t: 'over', winner: 'red', red: 1, blue: 0 };
    expect(b.last('over')).toEqual(won);
    // B's page reloads, and a friend's joins: each in the won seconds, and told so after its welcome and score.
    room.close(b, begun + 1_000);
    b = join(room, 'b', begun + 3_000, token('b'));
    const late = join(room, 'late', begun + 4_000);
    for (const p of [b, late]) {
      expect(p.got.slice(0, 3).map((m) => m.t)).toEqual(['welcome', 'score', 'over']);
      expect(p.last('welcome')).toMatchObject({ phase: 'playing' });
      expect(p.last('over')).toEqual(won);
    }
    room.tick(begun + OVER_MS + 1);
    expect(room.phase).toBe('lobby');
    expect(late.last('end')).toEqual({ t: 'end' });
  });

  it('gets the host role back only if nobody has been made host by an action since', () => {
    const room = new RoomCore('HOSTS');
    const a = join(room, 'a', 0, token('a'));
    const b = join(room, 'b', 0, token('b'));
    // A reloads: B is host meanwhile, does nothing as host, and A has it back.
    room.close(a, 1_000);
    expect(room.owner).toBe(1);
    const a2 = join(room, 'a', 5_000, token('a'));
    expect(room.owner).toBe(0);
    // A leaves again; B, host meanwhile, changes the kills to win: B is the host now, and stays it.
    room.close(a2, 6_000);
    say(room, b, { t: 'config', config: { killTarget: 12 } }, 7_000);
    join(room, 'a', 8_000, token('a'));
    expect(room.owner).toBe(1);
    expect(room.config.killTarget).toBe(12);
  });

  it('is a newcomer with a token older than REJOIN_MS: the team balancing gives, and no host role', () => {
    for (const late of [false, true]) {
      const room = new RoomCore('LATER');
      const a = join(room, 'a', 0, token('a'));
      join(room, 'b', 0, token('b'));
      let c = join(room, 'c', 0, token('c'));
      say(room, c, { t: 'team', team: 'blue' }, 10);
      expect(teams(room)).toEqual([['a', 'red'], ['b', 'blue'], ['c', 'blue']]);
      room.close(c, 1_000);
      room.close(a, 1_000);
      expect(room.owner).toBe(1);
      const back = 1_000 + REJOIN_MS + (late ? 1 : 0);
      c = join(room, 'c', back, token('c'));
      join(room, 'a', back, token('a'));
      // Remembered to REJOIN_MS: blue, and A the host. A moment later: Red has none, so C is red; B keeps the host role.
      expect(teams(room), `back ${late ? 'late' : 'in time'}`).toEqual(late ? [['c', 'red'], ['b', 'blue'], ['a', 'red']] : [['a', 'red'], ['b', 'blue'], ['c', 'blue']]);
      expect(room.owner).toBe(late ? 1 : 0);
    }
  });

  it("takes nobody's place with another's name, a made-up or short token, or another room's: a token is random and the room's own", () => {
    const room = new RoomCore('MINES');
    const host = join(room, 'Jordan', 0, token('a'));
    const sam = join(room, 'Sam', 0, token('b'));
    say(room, host, { t: 'team', team: 'blue' }, 10);
    say(room, sam, { t: 'team', team: 'red' }, 10);
    say(room, host, { t: 'config', config: { killTarget: 7 } }, 20);
    expect(teams(room)).toEqual([['Jordan', 'blue'], ['Sam', 'red']]);
    room.close(host, 1_000);
    room.close(sam, 1_000);
    // A friend in another browser (no token), with the host's name: a newcomer, not the host's seat.
    const other = join(room, 'Jordan', 2_000);
    expect(other.last('welcome')).toMatchObject({ you: 0 });
    expect(room.seats().find((s) => s.name === 'Jordan')!.team).toBe('red');
    // A made-up token, and one too short to be a page's (a guess): newcomers, on the balanced side (not Sam's red).
    const madeUp = join(room, 'Sam', 2_100, token('f'));
    expect(room.seats().find((s) => s.id === madeUp.last('welcome')!.you)!.team).toBe('blue');
    expect(parseClient(JSON.stringify({ t: 'hello', v: PROTOCOL, build: 'b1', name: 'x', token: 'aaaa' }))).toEqual({ t: 'hello', v: PROTOCOL, build: 'b1', name: 'x' });
    // The host's token in another room is nothing there.
    const elsewhere = new RoomCore('OTHER');
    join(elsewhere, 'Lee', 0, token('c'));
    join(elsewhere, 'Jordan', 100, token('a'));
    expect(elsewhere.owner).toBe(0);
    expect(elsewhere.seats().map((s) => s.team)).toEqual(['red', 'blue']);
    // Here, the host's own token still finds the host's place: their team and the host role.
    join(room, 'Jordan', 3_000, token('a'));
    expect(room.seats().at(-1)).toMatchObject({ name: 'Jordan', team: 'blue' });
    expect(room.owner).toBe(room.seats().at(-1)!.id);
  });

  it("takes its own seat back on a new line while its old line still holds it (a reload before the close came, a line gone dead): the old line is let go, told why", () => {
    const room = new RoomCore('AGAIN');
    const a = join(room, 'a', 0, token('a'));
    const b = join(room, 'b', 0, token('b'));
    join(room, 'c', 0, token('c'));
    join(room, 'd', 0, token('d'));
    // B on Red with A and C: without B, balancing would put a newcomer on Blue.
    say(room, b, { t: 'team', team: 'red' }, 10);
    say(room, a, { t: 'start' }, 100);
    const at = 100 + COUNTDOWN_MS + PROTECT_MS + 1;
    say(room, b, { t: 'hit', v: 3, z: 'head' }, at);
    // B's line goes dead without a close; its page reloads and comes back on a new one.
    const b2 = join(room, 'b', at + 12_000, token('b'));
    expect([b.closed, b.code]).toEqual(['replaced', 4001]);
    expect(b.last('closing')).toEqual({ t: 'closing', reason: 'replaced' });
    expect(b2.last('welcome')).toMatchObject({ you: 1 });
    expect(room.seats()).toHaveLength(4);
    expect(room.seats().find((s) => s.id === 1)!.team).toBe('red');
    expect(tallies(b2)).toContainEqual([1, 1, 0]);
    // A full room takes the same tab's line back too: its old line's seat is its own.
    const full = new RoomCore('FULLR');
    const lines = Array.from({ length: 8 }, (_, k) => join(full, `p${k}`, 0, token(String(k))));
    const again = join(full, 'p3', 1_000, token('3'));
    expect(again.last('welcome')).toMatchObject({ you: 3 });
    expect(lines[3].closed).toBe('replaced');
    expect(join(full, 'ninth', 1_100, token('9')).last('refused')).toEqual({ t: 'refused', reason: 'full' });
  });
});
