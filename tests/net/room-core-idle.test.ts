import { describe, expect, it } from 'vitest';
import { PROTECT_MS } from '../../src/net/match-rules';
import { encodeState, ROOM_IDLE_MS, type PlayerState } from '../../src/net/protocol';
import { AWAY_MS, COUNTDOWN_MS, HELLO_MS, OVER_MS, RoomCore, SEAT_SILENT_MS } from '../../src/net/room-core';
import { Fake, hello, join, say } from '../support/fake-room';

// The relay idles (the release audit's RELAY-1, ROBUST-4) and lets a dead line go (ROBUST-1): the room
// ticks only while a match is on, wakes otherwise only for its next deadline, closes when nobody has
// played in it for ROOM_IDLE_MS, and lets go of a seat that has sent nothing for SEAT_SILENT_MS.

const still: PlayerState = { tick: 1, position: [10, 2, 30], velocity: [0, 0, 0], yaw: 90, pitch: 0, stance: 0, height: 1.8, flags: 1 };
const ping = (c: number) => ({ t: 'ping', c });

describe("a room's tick, and its waking out of a match", () => {
  it('ticks only while a match is on, its countdown and its won seconds too; out of one it wakes only for its next deadline', () => {
    const room = new RoomCore('TICKS');
    expect([room.ticking, room.wakeAt()]).toEqual([false, null]);
    // A socket that has not said hello: the room wakes to close it, HELLO_MS on.
    const a = new Fake();
    room.open(a, 0);
    expect(room.wakeAt()).toBe(HELLO_MS + 1);
    say(room, a, hello('a'), 100);
    const b = join(room, 'b', 200);
    // Seated: the first of them to fall silent, or the room's idling, whichever comes first.
    expect(room.wakeAt()).toBe(100 + SEAT_SILENT_MS + 1);
    say(room, a, ping(1), 5_000);
    expect(room.wakeAt()).toBe(200 + SEAT_SILENT_MS + 1);
    expect(room.ticking).toBe(false);
    // The match: its countdown ticks, then the match; the owner's end stops it.
    say(room, a, { t: 'start' }, 6_000);
    expect(room.ticking).toBe(true);
    room.tick(6_000 + COUNTDOWN_MS - 50);
    expect(room.ticking).toBe(true);
    say(room, a, { t: 'end' }, 20_000);
    expect(room.ticking).toBe(false);
    // A match won ticks on until the room is back in its lobby, OVER_MS after the winning kill.
    say(room, a, { t: 'config', config: { killTarget: 1, intensity: 'off' } }, 21_000);
    say(room, a, { t: 'start' }, 21_000);
    const kill = 21_000 + COUNTDOWN_MS + PROTECT_MS + 1;
    say(room, b, ping(2), kill);
    say(room, a, { t: 'hit', v: 1, z: 'head' }, kill);
    expect(a.last('over')).toMatchObject({ winner: 'red' });
    room.tick(kill + OVER_MS - 1);
    expect(room.ticking).toBe(true);
    room.tick(kill + OVER_MS);
    expect([room.phase, room.ticking]).toEqual(['lobby', false]);
    // Everyone gone: nothing to wake for.
    room.close(a);
    room.close(b);
    expect([room.ticking, room.wakeAt()]).toEqual([false, null]);
  });
});

describe('a room nobody plays in', () => {
  it('is closed ROOM_IDLE_MS after anyone last played, every socket told it was idle; pings are not playing', () => {
    expect(ROOM_IDLE_MS).toBe(20 * 60_000);
    const room = new RoomCore('IDLES');
    const a = join(room, 'a', 0);
    const b = join(room, 'b', 0);
    // B plays (anything but a ping or an unchanged state): the room's idling counts from here.
    say(room, b, { t: 'ready', ready: true }, 60_000);
    // Both tabs left open in the lobby: their pings go on, and the room wakes when it would.
    let now = 60_000;
    while (now < 60_000 + ROOM_IDLE_MS - 1_000) {
      now += 1_000;
      say(room, a, ping(now), now);
      say(room, b, ping(now), now);
      room.tick(now);
    }
    room.tick(60_000 + ROOM_IDLE_MS - 1);
    expect([a.closed, b.closed]).toEqual([null, null]);
    expect(room.wakeAt()).toBe(60_000 + ROOM_IDLE_MS);
    room.tick(60_000 + ROOM_IDLE_MS);
    expect([a.closed, b.closed]).toEqual(['idle', 'idle']);
    expect(a.code).toBe(4000);
    for (const c of [a, b]) expect(c.last('closing')).toEqual({ t: 'closing', reason: 'idle' });
    expect(room.empty).toBe(true);
    expect(room.wakeAt()).toBeNull();
  });

  it("is closed mid-match, a forgotten tab's states unchanged but for their ticks, its pings and the battle's hurts not playing; a state that moves is", () => {
    const room = new RoomCore('LEFTO');
    const a = join(room, 'a', 0);
    const b = join(room, 'b', 0);
    say(room, a, { t: 'config', config: { intensity: 'heavy' } }, 0);
    say(room, a, { t: 'start' }, 1_000);
    let tick = 0;
    const state = (s: Partial<PlayerState> = {}) => ({ t: 's', s: encodeState({ ...still, ...s, tick: ++tick }) });
    // B walks for a minute; A stands still from the start. States go twice a second here (enough for
    // AWAY_MS), each one's tick new; the room ticks between.
    let now = 4_000;
    for (; now <= 64_000; now += 500) {
      say(room, a, state(), now);
      say(room, b, state({ position: [10 + now / 1000, 2, 30] }), now);
      room.tick(now + 250);
    }
    const moved = now - 500;
    // Then both forgotten: still, pinging, B hurt by the battle now and then.
    for (; now < moved + ROOM_IDLE_MS; now += 500) {
      say(room, a, state(), now);
      say(room, b, state({ position: [10 + moved / 1000, 2, 30] }), now);
      if (now % 2_000 === 0) say(room, a, ping(now), now);
      if (now % 60_000 === 0) say(room, b, { t: 'hurt', a: 5, c: 'shell' }, now);
      room.tick(now + 250 < moved + ROOM_IDLE_MS ? now + 250 : moved + ROOM_IDLE_MS - 1);
    }
    expect([a.closed, b.closed]).toEqual([null, null]);
    expect(room.phase).toBe('playing');
    room.tick(moved + ROOM_IDLE_MS);
    expect([a.closed, b.closed]).toEqual(['idle', 'idle']);
    expect(b.last('closing')).toEqual({ t: 'closing', reason: 'idle' });
    expect(room.empty).toBe(true);
  });
});

describe('a seat silent for SEAT_SILENT_MS', () => {
  it('is let go, its seat and the host role passing on; a hidden tab pinging once a minute, at its timers’ slowest, keeps its seat', () => {
    // A hidden tab's timers run once a minute at their slowest (Chrome's intensive throttling, five
    // minutes hidden): its pings must not fall silent for the room, with room to spare.
    expect(SEAT_SILENT_MS).toBe(90_000);
    expect(SEAT_SILENT_MS - 60_000).toBeGreaterThanOrEqual(30_000);
    const room = new RoomCore('GHOST');
    const host = join(room, 'host', 0);
    const hidden = join(room, 'hidden', 0);
    const friend = join(room, 'friend', 0);
    // The host's last word, then its laptop lid shuts: nothing more from it, and no close.
    say(room, host, { t: 'config', config: { killTarget: 5 } }, 1_000);
    const minute = (now: number) => now % 60_000 === 0;
    let now = 1_000;
    for (; now < 1_000 + SEAT_SILENT_MS; now += 500) {
      say(room, friend, ping(now), now);
      if (minute(now)) say(room, hidden, ping(now), now);
      room.tick(now);
    }
    room.tick(1_000 + SEAT_SILENT_MS);
    expect(host.closed).toBeNull();
    room.tick(1_000 + SEAT_SILENT_MS + 1);
    expect([host.closed, host.code]).toEqual(['silent', 4002]);
    expect(room.seats().map((s) => s.name)).toEqual(['hidden', 'friend']);
    // The host role to the next seated, at once: the room is not stuck.
    expect(room.owner).toBe(1);
    expect(friend.last('roster')).toMatchObject({ owner: 1 });
    // Ten minutes more: the hidden tab, pinging once a minute, is still seated.
    for (now = 1_000 + SEAT_SILENT_MS + 500; now < 600_000; now += 500) {
      say(room, friend, ping(now), now);
      if (minute(now)) say(room, hidden, ping(now), now);
      room.tick(now);
    }
    expect([hidden.closed, friend.closed]).toEqual([null, null]);
    expect(room.seats().map((s) => s.name)).toEqual(['hidden', 'friend']);
  });

  it('in a match is away after AWAY_MS, as before, and let go after SEAT_SILENT_MS', () => {
    const room = new RoomCore('DEADM');
    const a = join(room, 'a', 0);
    const b = join(room, 'b', 0);
    say(room, a, { t: 'config', config: { intensity: 'off' } }, 0);
    say(room, a, { t: 'start' }, 0);
    say(room, b, { t: 's', s: encodeState(still) }, COUNTDOWN_MS);
    let now = COUNTDOWN_MS;
    for (; now <= COUNTDOWN_MS + AWAY_MS + 100; now += 50) {
      say(room, a, ping(now), now);
      room.tick(now);
    }
    expect(a.last('roster')!.seats.find((s) => s.id === 1)!.away).toBe(true);
    expect(b.closed).toBeNull();
    for (; now <= COUNTDOWN_MS + SEAT_SILENT_MS + 50; now += 50) {
      say(room, a, ping(now), now);
      room.tick(now);
    }
    expect(b.closed).toBe('silent');
    expect(room.seats().map((s) => s.id)).toEqual([0]);
  });
});
