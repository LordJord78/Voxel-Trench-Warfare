/**
 * The room's clock as a player knows it: each ping's round trip gives the room's time at about its
 * middle, and the offset from the trip with the least round trip of the last few is believed,
 * since a slow trip is mostly one leg's queueing and says least about the other's.
 *
 * Times are in milliseconds; the caller supplies its own clock (performance.now in the app), so
 * this stays deterministic and testable.
 */

const KEEP = 8;

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
