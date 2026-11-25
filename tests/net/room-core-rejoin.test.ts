import { describe, expect, it } from 'vitest';
import { PROTECT_MS } from '../../src/net/match-rules';
import { parseClient, PROTOCOL } from '../../src/net/protocol';
import { COUNTDOWN_MS, REJOIN_MS, RoomCore } from '../../src/net/room-core';
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
