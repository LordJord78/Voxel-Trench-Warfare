/**
 * The room's clock as a player knows it: each ping's round trip gives the room's time at about its
 * middle, and the offset from the trip with the least round trip of the last few is believed,
 * since a slow trip is mostly one leg's queueing and says least about the other's.
 *
 * Times are in milliseconds; the caller supplies its own clock (performance.now in the app), so
 * this stays deterministic and testable.
 */

import type { RoomConfig } from './protocol';

const KEEP = 8;

/** A step of the battle longer than this (seconds) is a jump, run silently: a hidden tab come back, a join mid-match. */
export const SILENT_STEP_S = 1;

/** The match's seconds at the room's `serverNowMs`, from its start at `startAtMs`: never before 0. */
export function matchSeconds(serverNowMs: number, startAtMs: number): number {
  return Math.max(0, (serverNowMs - startAtMs) / 1000);
}

/** The match's time of day, in hours, `seconds` in: the config's start, run on by its lapse (game minutes a second), round the clock. */
export function matchHours(config: Pick<RoomConfig, 'timeOfDay' | 'lapse'>, seconds: number): number {
  return (config.timeOfDay + (config.lapse * seconds) / 60) % 24;
}

/**
 * The battle, given `givenS` of the match so far, run on to the match's `nowS`: by the difference,
 * never back (a clock sample that pulls the room's time back holds the battle until it catches up),
 * and silently past SILENT_STEP_S, so a jump is not heard all at once.
 */
export function battleStep(givenS: number, nowS: number): { stepS: number; silent: boolean } {
  const stepS = Math.max(0, nowS - givenS);
  return { stepS, silent: stepS > SILENT_STEP_S };
}

export class ServerClock {
  private readonly samples: { rtt: number; offset: number }[] = [];
  private best: { rtt: number; offset: number } | null = null;

  /** A pong: the client's time it sent the ping, the room's time in the pong, and the client's time now. */
  sample(sentAt: number, serverAt: number, now: number): void {
    const rtt = Math.max(0, now - sentAt);
    this.samples.push({ rtt, offset: serverAt - (sentAt + rtt / 2) });
    if (this.samples.length > KEEP) this.samples.shift();
    this.best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
  }

  /** Whether any pong has come back. */
  get synced(): boolean {
    return this.best !== null;
  }

  /** The least round trip lately, in ms (0 before any). */
  get rtt(): number {
    return this.best?.rtt ?? 0;
  }

  /** The room's time at the client's `now`. */
  serverAt(now: number): number {
    return now + (this.best?.offset ?? 0);
  }

  /** The client's time at the room's `serverAt`. */
  localAt(serverAt: number): number {
    return serverAt - (this.best?.offset ?? 0);
  }
}
