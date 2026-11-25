/**
 * The relay's timer over a room (the release audit's RELAY-1, ROBUST-4): the room's tick every
 * TICK_MS while a match is on (RoomCore.ticking), and otherwise one timer at a time, for the room's
 * next deadline (RoomCore.wakeAt: a hello overdue, a seat silent too long, the room idle), so a lobby
 * wakes the Durable Object a few times a quarter of an hour, not twenty times a second. None at all
 * once nobody is connected. `pace` after anything that may change what the room has to do: a socket
 * opened or closed, a message.
 *
 * Plain TypeScript with its timers given, so the tests run it on their own clock
 * (tests/net/room-pacer.test.ts); the Durable Object gives it the runtime's.
 */

import type { RoomCore } from '../../src/net/room-core';

/** The room's tick in a match: a frame of every player's state to everyone, twenty a second. */
export const TICK_MS = 50;

/** Timers as the pacer uses them: each set returns its own cancel. */
export interface Timers {
  every(ms: number, fn: () => void): () => void;
  after(ms: number, fn: () => void): () => void;
  now(): number;
}

/** The runtime's own timers, on Date.now() (the room's clock). */
export const RUNTIME_TIMERS: Timers = {
  every: (ms, fn) => {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  },
  after: (ms, fn) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
  now: () => Date.now(),
};

export class Pacer {
  /** The match's interval, while there is one. */
  private ticks: (() => void) | null = null;
  /** The one timer out of a match, and when it falls due. */
  private wake: (() => void) | null = null;
  private wakeAt = Number.POSITIVE_INFINITY;

  constructor(
    private readonly room: Pick<RoomCore, 'ticking' | 'wakeAt' | 'tick'>,
    private readonly timers: Timers,
  ) {}

  pace(): void {
    if (this.room.ticking) {
      this.unwake();
      this.ticks ??= this.timers.every(TICK_MS, () => this.run());
      return;
    }
    if (this.ticks) {
      this.ticks();
      this.ticks = null;
    }
    const at = this.room.wakeAt();
    if (at === null) return this.unwake();
    // One already set for sooner: it wakes the room, which says then when next.
    if (this.wake && this.wakeAt <= at) return;
    this.unwake();
    this.wakeAt = at;
    this.wake = this.timers.after(Math.max(0, at - this.timers.now()), () => {
      this.wake = null;
      this.wakeAt = Number.POSITIVE_INFINITY;
      this.run();
    });
  }

  private run(): void {
    this.room.tick(this.timers.now());
    this.pace();
  }

  private unwake(): void {
    this.wake?.();
    this.wake = null;
    this.wakeAt = Number.POSITIVE_INFINITY;
  }
}
