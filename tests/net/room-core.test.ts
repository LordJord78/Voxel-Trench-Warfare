import { describe, expect, it } from 'vitest';
import { encodeShot, encodeState, parseRoom, PROTOCOL, type RoomMsg } from '../../src/net/protocol';
import { PROTECT_MS } from '../../src/net/match-rules';
import { AWAY_MS, COUNTDOWN_MS, OVER_MS, RoomCore, type Conn } from '../../src/net/room-core';

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
