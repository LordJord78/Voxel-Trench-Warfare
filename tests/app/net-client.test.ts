import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetClient, type NetEvents } from '../../src/app/net-client';
import { defaultConfig } from '../../src/net/protocol';

// One player's line to their room (net-client.ts), spoken through a stub socket the test opens and
// answers, on a page clock the test sets: the welcome is the hello's reply, so it is the room's clock's
// first sample, and the match's seconds are the room's from the match's start.

/** The socket the client made: the test opens it and speaks the room's side. */
class StubSocket {
  static readonly OPEN = 1;
  static last: StubSocket | null = null;
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  private readonly listeners = new Map<string, ((e: unknown) => void)[]>();
  constructor(readonly url: string) {
    StubSocket.last = this;
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = StubSocket.OPEN;
    for (const fn of this.listeners.get('open') ?? []) fn({});
  }
  say(msg: Record<string, unknown>): void {
    for (const fn of this.listeners.get('message') ?? []) fn({ data: JSON.stringify(msg) });
  }
}

const quiet: NetEvents = { changed() {}, started() {}, ended() {}, lost() {}, hurt() {}, death() {}, respawn() {}, over() {} };
const seats = [{ id: 0, name: 'Jordan', team: 'red', ready: false, away: false }];
const welcome = (now: number, match: Record<string, unknown> | null = null) => ({ t: 'welcome', you: 0, room: 'ABCDE', owner: 0, seats, config: defaultConfig(), phase: match ? 'playing' : 'lobby', match, now });

describe("a player's line to the room", () => {
  let page = 0;
  /** A client on the page's clock, its socket opened at page time 1000: the hello goes. */
  const joined = () => {
    const client = new NetClient('http://relay.test', 'ABCDE', 'Jordan', 'build', quiet, () => page);
    page = 1000;
    StubSocket.last!.open();
    expect(StubSocket.last!.sent[0]).toMatchObject({ t: 'hello' });
    return client;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', StubSocket);
    page = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("takes the welcome as the clock's first sample: the room's time at once, not the page's", () => {
    const client = joined();
    expect(client.clock.synced).toBe(false);
    page = 1040;
    StubSocket.last!.say(welcome(5_000_000));
    expect(client.joined).toBe(true);
    expect(client.clock.synced).toBe(true);
    // The room's time at the welcome's middle of the trip, run on 20 ms to the page's now.
    expect(Math.abs(client.serverNow() - 5_000_020)).toBeLessThan(1);
  });

  it("gives the match's seconds from its start, and 0 with no match", () => {
    const playing = joined();
    page = 1040;
    StubSocket.last!.say(welcome(5_000_000, { startAt: 4_990_000, seed: 3, config: defaultConfig() }));
    expect(playing.match).not.toBeNull();
    expect(Math.abs(playing.matchSeconds() - 10.02)).toBeLessThan(0.002);
    const lobby = joined();
    page = 1040;
    StubSocket.last!.say(welcome(5_000_000));
    expect(lobby.match).toBeNull();
    expect(lobby.matchSeconds()).toBe(0);
  });
});
