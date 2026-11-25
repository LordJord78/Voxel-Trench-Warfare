import { describe, expect, it } from 'vitest';
import { ROOM_IDLE_MS } from '../../src/net/protocol';
import { HELLO_MS, RoomCore, SEAT_SILENT_MS } from '../../src/net/room-core';
import { Pacer, TICK_MS, type Timers } from '../../server/src/pacer';
import { Fake, hello, say } from '../support/fake-room';

// The relay's timer (server/src/pacer.ts), as the Durable Object runs it over a room: every TICK_MS
// while a match is on, and otherwise one timer at a time, for the room's next deadline (the release
// audit's RELAY-1, ROBUST-4: a 50 ms interval ran from the first connection to the last).

/** Timers on a clock the test runs: each job run at its time, in time order. */
class FakeTimers implements Timers {
  t = 0;
  private seq = 0;
  private readonly jobs = new Map<number, { at: number; every: number | null; fn: () => void }>();
  now(): number {
    return this.t;
  }
  every(ms: number, fn: () => void): () => void {
    const id = this.seq++;
    this.jobs.set(id, { at: this.t + ms, every: ms, fn });
    return () => this.jobs.delete(id);
  }
  after(ms: number, fn: () => void): () => void {
    const id = this.seq++;
    this.jobs.set(id, { at: this.t + ms, every: null, fn });
    return () => this.jobs.delete(id);
  }
  /** The intervals and the timeouts set now, and when the timeouts fall due. */
  get set(): { every: number; after: number[] } {
    const jobs = [...this.jobs.values()];
    return { every: jobs.filter((j) => j.every !== null).length, after: jobs.filter((j) => j.every === null).map((j) => j.at) };
  }
  /** On to `to`, each job run as it falls due. */
  runTo(to: number): void {
    for (;;) {
      let next: [number, { at: number; every: number | null; fn: () => void }] | null = null;
      for (const e of this.jobs) if (!next || e[1].at < next[1].at) next = e;
      if (!next || next[1].at > to) break;
      const [id, job] = next;
      this.t = job.at;
      if (job.every !== null) job.at += job.every;
      else this.jobs.delete(id);
      job.fn();
    }
    this.t = to;
  }
}

describe("the relay's timer", () => {
  it('ticks the room every TICK_MS only while a match is on; in the lobby it sets one timer, for the next deadline, and none once the room is empty', () => {
    expect(TICK_MS).toBe(50);
    const timers = new FakeTimers();
    const room = new RoomCore('PACED');
    let ticks = 0;
    const tick = room.tick.bind(room);
    room.tick = (now: number) => {
      ticks++;
      tick(now);
    };
    const pacer = new Pacer(room, timers);
    // What the Durable Object does: each event given the room, then the pacer.
    const open = (c: Fake) => {
      room.open(c, timers.now());
      pacer.pace();
    };
    const send = (c: Fake, msg: object) => {
      say(room, c, msg, timers.now());
      pacer.pace();
    };
    const a = new Fake();
    open(a);
    expect(timers.set).toEqual({ every: 0, after: [HELLO_MS + 1] });
    timers.runTo(100);
    send(a, hello('a'));
    const b = new Fake();
    open(b);
    send(b, hello('b'));
    // Ten minutes of a lobby: pings twice a second from both, and the room wakes only now and then.
    for (let t = 100; t < 600_000; t += 500) {
      timers.runTo(t);
      send(a, { t: 'ping', c: t });
      send(b, { t: 'ping', c: t });
      expect(timers.set.every).toBe(0);
      expect(timers.set.after).toHaveLength(1);
    }
    expect(ticks).toBeLessThanOrEqual(Math.ceil(600_000 / SEAT_SILENT_MS) + 2);
    // The match: 50 ms ticks from its start, through its countdown, and no other timer.
    send(a, { t: 'start' });
    expect(timers.set).toEqual({ every: 1, after: [] });
    ticks = 0;
    const started = timers.now();
    for (let t = started; t <= started + 10_000; t += 500) {
      timers.runTo(t);
      send(a, { t: 'ping', c: t });
      send(b, { t: 'ping', c: t });
    }
    expect(ticks).toBe(10_000 / TICK_MS);
    // The owner ends it: the ticks stop, and one timer waits for the lobby's next deadline.
    send(a, { t: 'end' });
    const ended = timers.now();
    expect(timers.set.every).toBe(0);
    expect(timers.set.after).toEqual([room.wakeAt()]);
    ticks = 0;
    timers.runTo(timers.now() + 10_000);
    expect(ticks).toBe(0);
    // Nobody plays: the room closes itself at its idle deadline, at the timer the pacer set for it.
    for (let t = timers.now(); t < ended + ROOM_IDLE_MS + 1_000; t += 1_000) {
      timers.runTo(t);
      if (a.closed === null) send(a, { t: 'ping', c: t });
      if (b.closed === null) send(b, { t: 'ping', c: t });
    }
    expect([a.closed, b.closed]).toEqual(['idle', 'idle']);
    expect(room.empty).toBe(true);
    expect(timers.set).toEqual({ every: 0, after: [] });
  });

  it('stops with the room emptied, mid-match too', () => {
    const timers = new FakeTimers();
    const room = new RoomCore('EMPTY');
    const pacer = new Pacer(room, timers);
    const a = new Fake();
    room.open(a, 0);
    say(room, a, hello('a'), 0);
    say(room, a, { t: 'start' }, 0);
    pacer.pace();
    expect(timers.set).toEqual({ every: 1, after: [] });
    timers.runTo(5_000);
    room.close(a);
    pacer.pace();
    expect(timers.set).toEqual({ every: 0, after: [] });
  });
});
