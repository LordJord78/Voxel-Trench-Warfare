import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetClient, type NetEvents } from '../../src/app/net-client';
import { defaultConfig, encodeState, type PlayerState } from '../../src/net/protocol';

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
  /** The line goes, not by the client's doing. */
  drop(reason = ''): void {
    this.readyState = 3;
    for (const fn of this.listeners.get('close') ?? []) fn({ reason });
  }
}

const quiet: NetEvents = { changed() {}, started() {}, ended() {}, lost() {}, hurt() {}, death() {}, respawn() {}, over() {} };
const seats = [{ id: 0, name: 'Jordan', team: 'red', ready: false, away: false }];
const welcome = (now: number, match: Record<string, unknown> | null = null) => ({ t: 'welcome', you: 0, room: 'ABCDE', owner: 0, seats, config: defaultConfig(), phase: match ? 'playing' : 'lobby', match, now });

describe("a player's line to the room", () => {
  let page = 0;
  /** A client on the page's clock, its socket opened at page time 1000: the hello goes. */
  const joined = (on: NetEvents = quiet) => {
    const client = new NetClient('http://relay.test', 'ABCDE', 'Jordan', 'build', on, () => page);
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
    // What the match's start hears already reckons by the room's clock: the welcome is sampled before anything else.
    let atStart: number | null = null;
    const playing: NetClient = joined({ ...quiet, started: () => (atStart = playing.matchSeconds()) });
    page = 1040;
    StubSocket.last!.say(welcome(5_000_000, { startAt: 4_990_000, seed: 3, config: defaultConfig() }));
    expect(playing.match).not.toBeNull();
    expect(atStart).not.toBeNull();
    expect(Math.abs(atStart! - 10.02)).toBeLessThan(0.002);
    expect(Math.abs(playing.matchSeconds() - 10.02)).toBeLessThan(0.002);
    const lobby = joined();
    page = 1040;
    StubSocket.last!.say(welcome(5_000_000));
    expect(lobby.match).toBeNull();
    expect(lobby.matchSeconds()).toBe(0);
  });

  it("puts the room's shells on its edits, in the order they came, a malformed one dropped; taken once", () => {
    const client = joined();
    page = 1040;
    StubSocket.last!.say(welcome(5_000_000, { startAt: 4_990_000, seed: 3, config: defaultConfig() }));
    expect(client.takeEdits()).toEqual([]);
    StubSocket.last!.say({ t: 'shell', s: [7, 5_001_500, 12_800, 15_000, 3_000, 42] });
    StubSocket.last!.say({ t: 'shell', s: [7, 5_001_500, 12_800] });
    StubSocket.last!.say({ t: 'shell', s: [8, 5_004_000, -1_250, 20_000, 2_200, 43] });
    expect(client.takeEdits()).toEqual([
      { t: 'shell', shell: { id: 7, landAt: 5_001_500, at: [12.8, 15], radius: 3, seed: 42 } },
      { t: 'shell', shell: { id: 8, landAt: 5_004_000, at: [-1.25, 20], radius: 2.2, seed: 43 } },
    ]);
    expect(client.takeEdits()).toEqual([]);
  });

  it('sends its shots as their words, as given', () => {
    const client = joined();
    page = 1040;
    StubSocket.last!.say(welcome(5_000_000));
    const state: PlayerState = { tick: 50, position: [1, 2, 3], velocity: [0, 0, 0], yaw: 10, pitch: -2, stance: 0, height: 1.8, flags: 1 };
    const words = [[49, 1000, 2000, 3000, 0, 0, 10000, 3], [50, 1001, 2000, 3000, 0, 6000, 8000, 1]];
    client.state(state, words);
    client.state(state, []);
    expect(StubSocket.last!.sent.slice(-2)).toEqual([{ t: 's', s: encodeState(state), sh: words }, { t: 's', s: encodeState(state) }]);
  });

  it("a line lost mid-match ends the match for this page before it says why; in the lobby it only says why", () => {
    const LOST = 'The connection to the game was lost. Reload the page to rejoin.';
    const heard: string[] = [];
    const on: NetEvents = { ...quiet, ended: () => heard.push(`ended: ${client.phase}, ${client.match === null ? 'no match' : 'a match'}`), lost: (why) => heard.push(why) };
    const client: NetClient = joined(on);
    page = 1040;
    StubSocket.last!.say(welcome(5_000_000, { startAt: 4_990_000, seed: 3, config: defaultConfig() }));
    expect(client.phase).toBe('playing');
    StubSocket.last!.drop();
    // As if the owner had ended it (the page's battle is the visitor's again: together.ts ended), then the line's note.
    expect(heard).toEqual(['ended: lobby, no match', LOST]);
    expect([client.phase, client.match]).toEqual(['lobby', null]);
    // In the lobby, no match to end.
    heard.length = 0;
    const lobby = joined({ ...quiet, ended: () => heard.push('ended'), lost: (why) => heard.push(why) });
    StubSocket.last!.say(welcome(5_000_000));
    StubSocket.last!.drop();
    expect(heard).toEqual([LOST]);
    expect(lobby.phase).toBe('lobby');
    // Closed by the player, or refused for being full, nothing is said.
    heard.length = 0;
    const leaving = joined({ ...quiet, ended: () => heard.push('ended'), lost: (why) => heard.push(why) });
    StubSocket.last!.say(welcome(5_000_000, { startAt: 4_990_000, seed: 3, config: defaultConfig() }));
    leaving.close();
    StubSocket.last!.drop('left');
    joined({ ...quiet, ended: () => heard.push('ended'), lost: (why) => heard.push(why) });
    StubSocket.last!.drop('full');
    expect(heard).toEqual([]);
  });
});
