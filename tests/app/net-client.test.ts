import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOST, NetClient, REFUSED, SHOT_QUEUE_MAX, type NetEvents, type RemoteShot } from '../../src/app/net-client';
import { defaultConfig, encodeShot, encodeState, MAX_PLAYERS, type PlayerState } from '../../src/net/protocol';

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
  /** How the client closed it, if it did. */
  closedWith: [number | undefined, string | undefined] | null = null;
  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closedWith = [code, reason];
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

const quiet: NetEvents = { changed() {}, started() {}, welcomed() {}, ended() {}, lost() {}, hurt() {}, death() {}, respawn() {}, over() {} };
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

  it('a lobby welcome calls changed then welcomed, never started; a playing welcome calls changed, started, welcomed, in that order', () => {
    // Welcomed last, with the welcome's log already the client's: the page catches up on it (together.ts).
    const heard: string[] = [];
    const on = (client: () => NetClient): NetEvents => ({
      ...quiet,
      changed: () => heard.push('changed'),
      started: () => heard.push('started'),
      welcomed: () => heard.push(`welcomed: ${client().log.shells.length} shells, ${client().log.digs.length} digs`),
    });
    const log = { shells: [[7, 5_001_500, 12_800, 15_000, 3_000, 42], [8, 4_999_000, 1_000, 2_000, 2_200, 43]], digs: [[1, 4_999_500, 412_345]] };
    const lobby: NetClient = joined(on(() => lobby));
    expect(lobby.log).toEqual({ shells: [], digs: [] });
    page = 1040;
    StubSocket.last!.say({ ...welcome(5_000_000), log });
    expect(heard).toEqual(['changed', 'welcomed: 2 shells, 1 digs']);
    expect(lobby.log).toEqual(log);
    heard.length = 0;
    const playing: NetClient = joined(on(() => playing));
    page = 1040;
    StubSocket.last!.say({ ...welcome(5_000_000, { startAt: 4_990_000, seed: 3, config: defaultConfig() }), log });
    expect(heard).toEqual(['changed', 'started', 'welcomed: 2 shells, 1 digs']);
    // A welcome with no log has an empty one.
    heard.length = 0;
    const bare: NetClient = joined(on(() => bare));
    StubSocket.last!.say(welcome(5_000_000));
    expect(heard).toEqual(['changed', 'welcomed: 0 shells, 0 digs']);
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

  it("puts the room's digs in the edits queue with its shells, and sends its own", () => {
    const client = joined();
    page = 1040;
    StubSocket.last!.say(welcome(5_000_000, { startAt: 4_990_000, seed: 3, config: defaultConfig() }));
    StubSocket.last!.say({ t: 'shell', s: [7, 5_001_500, 12_800, 15_000, 3_000, 42] });
    StubSocket.last!.say({ t: 'dig', d: [1, 5_000_100, 412_345, 412_346, 425_145] });
    // Malformed: no cells, a seat past the eighth, a cell that is no integer.
    StubSocket.last!.say({ t: 'dig', d: [1, 5_000_100] });
    StubSocket.last!.say({ t: 'dig', d: [9, 5_000_100, 12] });
    StubSocket.last!.say({ t: 'dig', d: [1, 5_000_100, 1.5] });
    StubSocket.last!.say({ t: 'shell', s: [8, 5_004_000, -1_250, 20_000, 2_200, 43] });
    StubSocket.last!.say({ t: 'dig', d: [2, 5_000_300, 99] });
    expect(client.takeEdits()).toEqual([
      { t: 'shell', shell: { id: 7, landAt: 5_001_500, at: [12.8, 15], radius: 3, seed: 42 } },
      { t: 'dig', dig: { seat: 1, at: 5_000_100, cells: [412_345, 412_346, 425_145] } },
      { t: 'shell', shell: { id: 8, landAt: 5_004_000, at: [-1.25, 20], radius: 2.2, seed: 43 } },
      { t: 'dig', dig: { seat: 2, at: 5_000_300, cells: [99] } },
    ]);
    expect(client.takeEdits()).toEqual([]);
    expect(client.digsHeard).toBe(2);
    // Its own: each scoop's cells, as given.
    expect(client.digsSent).toBe(0);
    client.dig([412_345, 412_346]);
    client.dig([7]);
    expect(StubSocket.last!.sent.slice(-2)).toEqual([{ t: 'dig', c: [412_345, 412_346] }, { t: 'dig', c: [7] }]);
    expect(client.digsSent).toBe(2);
    expect(client.digsHeard).toBe(2);
    // The battle's harm told the room, counted as the scoops are.
    expect(client.hurtsSent).toBe(0);
    client.hurt(40, 'shell');
    client.hurt(12.5, 'round');
    expect(StubSocket.last!.sent.slice(-2)).toEqual([{ t: 'hurt', a: 40, c: 'shell' }, { t: 'hurt', a: 12.5, c: 'round' }]);
    expect(client.hurtsSent).toBe(2);
  });

  it("keeps the others' shots until the game takes them, each with its frame's time: past SHOT_QUEUE_MAX the oldest go; taken in order while they fit", () => {
    // A tab hidden for a while runs no frame, and a page catching up on the log fires none: their shots wait.
    expect(SHOT_QUEUE_MAX).toBe(2048);
    const client = joined();
    page = 1040;
    StubSocket.last!.say(welcome(5_000_000, { startAt: 4_990_000, seed: 3, config: defaultConfig() }));
    const shot = (tick: number) => encodeShot({ tick, origin: [1, 2, 3], dir: [0, 0, 1], tracer: false });
    for (let k = 0; k < SHOT_QUEUE_MAX + 10; k++) StubSocket.last!.say({ t: 'f', s: 5_000_000 + k, ps: [], sh: [[1, ...shot(k)], ...(k === 5 ? [[0, ...shot(k)]] : [])] });
    // Up to a hundred: the oldest ten gone, the player's own never kept.
    let n = 0;
    const first = client.takeShots(() => n++ < 100);
    expect(first.map((s: RemoteShot) => [s.seat, s.shot.tick, s.at])).toEqual(Array.from({ length: 100 }, (_, k) => [1, k + 10, 5_000_010 + k]));
    const rest = client.takeShots();
    expect(rest).toHaveLength(SHOT_QUEUE_MAX - 100);
    expect(rest.at(-1)!.shot.tick).toBe(SHOT_QUEUE_MAX + 9);
    expect(client.takeShots()).toEqual([]);
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
    // Closed by the player, nothing is said; refused for being full, that, once, the room's close after its word saying nothing more.
    heard.length = 0;
    const leaving = joined({ ...quiet, ended: () => heard.push('ended'), lost: (why) => heard.push(why) });
    StubSocket.last!.say(welcome(5_000_000, { startAt: 4_990_000, seed: 3, config: defaultConfig() }));
    leaving.close();
    StubSocket.last!.drop('left');
    expect(heard).toEqual([]);
    heard.length = 0;
    joined({ ...quiet, ended: () => heard.push('ended'), lost: (why) => heard.push(why) });
    StubSocket.last!.say({ t: 'refused', reason: 'full' });
    StubSocket.last!.drop('full');
    expect(heard).toEqual([REFUSED.full]);
  });

  it('says its rejoin token in its hello, when it has one', () => {
    const token = '0123456789abcdef0123456789abcdef';
    new NetClient('http://relay.test', 'ABCDE', 'Jordan', 'build', quiet, () => page, { token });
    StubSocket.last!.open();
    expect(StubSocket.last!.sent[0]).toMatchObject({ t: 'hello', name: 'Jordan', token });
    joined();
    expect(StubSocket.last!.sent[0]).not.toHaveProperty('token');
  });

  it('says what happened before the welcome, and what to do: no game, a full one, another version, the relay unreachable', () => {
    expect(REFUSED['no-room']).toBe('No game with that code');
    expect(REFUSED.full).toBe(`That game is full (${MAX_PLAYERS} players)`);
    expect(REFUSED.full).toBe('That game is full (8 players)');
    expect(REFUSED.version).toBe('That game is on another version: reload the page');
    expect(LOST.unreachable).toBe('The game could not be reached: check your connection');
    for (const reason of ['no-room', 'full', 'version'] as const) {
      const heard: string[] = [];
      joined({ ...quiet, lost: (why) => heard.push(why) });
      StubSocket.last!.say({ t: 'refused', reason });
      StubSocket.last!.drop(reason);
      expect(heard, reason).toEqual([REFUSED[reason]]);
      // The room's close alone, its word lost: the same.
      heard.length = 0;
      joined({ ...quiet, lost: (why) => heard.push(why) });
      StubSocket.last!.drop(reason);
      expect(heard, reason).toEqual([REFUSED[reason]]);
    }
    const heard: string[] = [];
    joined({ ...quiet, lost: (why) => heard.push(why) });
    StubSocket.last!.drop();
    expect(heard).toEqual([LOST.unreachable]);
  });

  it('says the room closed for nobody playing in it as such, ending a match first; its close after the word says nothing more', () => {
    expect(LOST.idle).toBe('The game was closed after 20 minutes with nobody playing');
    const heard: string[] = [];
    const client: NetClient = joined({ ...quiet, ended: () => heard.push(`ended: ${client.phase}`), lost: (why) => heard.push(why) });
    StubSocket.last!.say(welcome(5_000_000, { startAt: 4_990_000, seed: 3, config: defaultConfig() }));
    StubSocket.last!.say({ t: 'closing', reason: 'idle' });
    StubSocket.last!.drop('idle');
    expect(heard).toEqual(['ended: lobby', LOST.idle]);
    // Its own page come back on another line: said, and this one let go.
    heard.length = 0;
    joined({ ...quiet, lost: (why) => heard.push(why) });
    StubSocket.last!.say(welcome(5_000_000));
    StubSocket.last!.drop('replaced');
    expect(heard).toEqual([LOST.replaced]);
  });

  describe('watching the room', () => {
    /** The page's clock and its timers on together, a tenth of a second at a time. */
    const run = (ms: number) => {
      for (let t = 0; t < ms; t += 100) {
        page += 100;
        vi.advanceTimersByTime(100);
      }
    };
    const watched = (heard: string[]) => {
      const client = new NetClient('http://relay.test', 'ABCDE', 'Jordan', 'build', { ...quiet, ended: () => heard.push('ended'), lost: (why) => heard.push(why) }, () => page, { silentMs: 10_000 });
      return client;
    };

    it('with the page shown, a ping unanswered for silentMs is the line lost: said, the socket let go, a match ended first', () => {
      const heard: string[] = [];
      page = 1000;
      const client = watched(heard);
      StubSocket.last!.open();
      page = 1040;
      StubSocket.last!.say(welcome(5_000_000, { startAt: 4_990_000, seed: 3, config: defaultConfig() }));
      // The room answers for a while.
      for (let k = 0; k < 20; k++) {
        run(500);
        StubSocket.last!.say({ t: 'pong', c: page, s: 5_000_000 + page });
      }
      expect(heard).toEqual([]);
      // Then nothing more comes: lost once a ping has gone unanswered for 10 s, not before.
      run(9_500);
      expect(heard).toEqual([]);
      run(1_000);
      expect(heard).toEqual(['ended', LOST.line]);
      expect(client.phase).toBe('lobby');
      expect(StubSocket.last!.closedWith?.[1]).toBe('silent');
      // Said once, whatever comes after.
      StubSocket.last!.drop('silent');
      run(20_000);
      expect(heard).toEqual(['ended', LOST.line]);
    });

    it('hidden, never; shown again, a fresh wait; and any word from the room answers it', () => {
      const heard: string[] = [];
      page = 1000;
      const client = watched(heard);
      StubSocket.last!.open();
      StubSocket.last!.say(welcome(5_000_000));
      // Hidden for five minutes: its pings throttled, unanswered, nothing said.
      client.away(true);
      run(300_000);
      expect(heard).toEqual([]);
      // Shown: the burst's pings, unanswered; 10 s from now, not from when it hid.
      client.away(false);
      run(9_000);
      expect(heard).toEqual([]);
      // Any word answers (a roster), and the wait starts again from the next ping.
      StubSocket.last!.say({ t: 'roster', owner: 0, seats });
      run(9_000);
      expect(heard).toEqual([]);
      run(2_000);
      expect(heard).toEqual([LOST.line]);
    });

    it('before the welcome, no word from the room in silentMs is the game not reached', () => {
      const heard: string[] = [];
      page = 1000;
      watched(heard);
      run(9_000);
      StubSocket.last!.open();
      run(500);
      expect(heard).toEqual([]);
      run(1_000);
      expect(heard).toEqual([LOST.unreachable]);
    });
  });
});
