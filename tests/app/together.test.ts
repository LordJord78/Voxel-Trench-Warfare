import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOST } from '../../src/app/net-client';
import { Gaits, howKilled, mapAction, rejoinToken, relayUrl, shotTracer, stateOf, Together, type Figure, type TogetherHooks } from '../../src/app/together';
import { fireTunables } from '../../src/battle/fires';
import { holdOf } from '../../src/combat/arsenal';
import { packCell } from '../../src/combat/entrenching';
import { pose, type PoseInput, type V3 } from '../../src/combat/soldier-rig';
import { loadTunables } from '../../src/core/tunables';
import { decodeGear, TRACER_KIND } from '../../src/net/gear';
import { defaultConfig, encodeShot, encodeState, isToken, type Dig, type RoomShell, type Seat } from '../../src/net/protocol';
import { RoomBattle } from '../../src/sim/room-battle';
import { idleIntent } from '../../src/sim/session';
import { fallenLine, MatchHud } from '../../src/ui/match-hud';
import { P } from '../../src/world/materials';
import { roomClient, sameWorld, trenchArena } from '../support/worlds';

describe('where the relay is', () => {
  const q = (s: string) => new URLSearchParams(s);
  it("is the build's own, the local one on localhost, or none", () => {
    expect(relayUrl(q(''), 'lordjord78.github.io', false, 'https://relay.example.dev/')).toBe('https://relay.example.dev');
    expect(relayUrl(q(''), 'localhost', true, undefined)).toBe('http://127.0.0.1:8787');
    expect(relayUrl(q(''), 'lordjord78.github.io', false, undefined)).toBeNull();
  });
  it('takes ?relay= only on a development build or localhost, and only a bare origin', () => {
    expect(relayUrl(q('relay=http://127.0.0.1:9000'), 'localhost', false, 'https://r.dev')).toBe('http://127.0.0.1:9000');
    expect(relayUrl(q('relay=https://evil.example'), 'lordjord78.github.io', false, 'https://r.dev')).toBe('https://r.dev');
    expect(relayUrl(q('relay=javascript:alert(1)'), 'localhost', true, undefined)).toBe('http://127.0.0.1:8787');
  });
});

describe('which map a room is played on', () => {
  it('stays on its map, claims a room it just made for it, or goes to the room’s', () => {
    expect(mapAction('corridor', 'corridor', false, false)).toBe('stay');
    expect(mapAction('corridor', 'ravine', true, true)).toBe('claim');
    // A friend, or the owner of a room someone else set: to the room's map.
    expect(mapAction('ravine', 'corridor', false, false)).toBe('switch');
    expect(mapAction('ravine', 'corridor', false, true)).toBe('switch');
    expect(mapAction('ravine', 'corridor', true, false)).toBe('switch');
    // A map this build does not know is not gone to.
    expect(mapAction('ravine', 'atlantis', false, false)).toBe('stay');
  });
});

describe('figures posed as soldiers', () => {
  it("a figure's own tape and vest go to its soldier; without them, the soldier wears its team's tape and the uniform's khaki", () => {
    const figure = (seat: number, tape?: number, vest?: number): Figure => ({
      seat, team: 'blue', position: [12.8, 0.4, 30], velocity: [0, 0, 0], yaw: 180, pitch: 0, height: 1.8, deadFor: null,
      ...(tape === undefined ? {} : { tape }),
      ...(vest === undefined ? {} : { vest }),
    });
    const [dummy, soldier] = new Gaits().pose([figure(200, P.TAPE_RANGE, P.TAPE_RANGE), figure(3)], 1 / 60);
    expect([dummy.tape, dummy.vest]).toEqual([P.TAPE_RANGE, P.TAPE_RANGE]);
    expect(dummy.team).toBe('blue');
    expect(soldier).not.toHaveProperty('tape');
    expect(soldier).not.toHaveProperty('vest');
  });

  it("a figure's flinch and fall go into its pose, which is drawn and struck; the caller sets them each frame", () => {
    const still: Figure = { seat: 3, team: 'blue', position: [12.8, 0.4, 30], velocity: [0, 0, 0], yaw: 180, pitch: 0, height: 1.8, deadFor: null };
    // Standing still, the stride stays at its start: the pose is the rig's from the figure alone.
    const posed = (f: Figure, over: Partial<PoseInput> = {}) => pose({ position: f.position, yaw: f.yaw, pitch: f.pitch, height: f.height, speed: 0, bob: 0, deadFor: f.deadFor, hold: holdOf(decodeGear(0)), ...over });
    const flinch = { dir: [0, 0, 1] as V3, age: 0.05, head: true };
    const gaits = new Gaits();
    const [struck] = gaits.pose([{ ...still, flinch }], 1 / 60);
    expect(struck.frames).toEqual(posed(still, { flinch }));
    expect(struck.frames).not.toEqual(posed(still));
    // The next frame without one, it stands as it did: Gaits keeps none of it.
    expect(gaits.pose([still], 1 / 60)[0].frames).toEqual(posed(still));
    // Killed: it falls toward its fallYaw, in its fallS.
    const killed: Figure = { ...still, deadFor: 0.3, fallYaw: 90, fallS: 0.3 };
    const [fallen] = gaits.pose([killed], 1 / 60);
    expect(fallen.frames).toEqual(posed(killed, { fallYaw: 90, fallS: 0.3 }));
    expect(fallen.frames).not.toEqual(posed(killed));
  });
});

describe("the colour another player's shot is drawn in", () => {
  const seat = (id: number, team: 'red' | 'blue', away = false): Seat => ({ id, name: `p${id}`, team, ready: true, away });
  const drawn = (id: number, team: 'red' | 'blue') => ({ seat: id, team });

  it("is their seat's team's, from their soldier as drawn or, with none drawn, from the room's seats", () => {
    const seats = [seat(0, 'red'), seat(1, 'blue'), seat(2, 'red', true)];
    expect(shotTracer(1, [drawn(1, 'blue')], seats)).toBe(TRACER_KIND.blue);
    // Away (the room still relays their shots), not yet in the states, or with nothing buffered: no
    // soldier drawn, and their seat says their team.
    expect(shotTracer(1, [], seats)).toBe(TRACER_KIND.blue);
    expect(shotTracer(2, [drawn(1, 'blue')], seats)).toBe(TRACER_KIND.red);
    // Seated nowhere the room has said: none given, and the shot's own word says.
    expect(shotTracer(5, [drawn(1, 'blue')], seats)).toBeUndefined();
  });
});

describe('the kill feed', () => {
  it("names the battle's kills in the feed: shelled, shot from the line, burned", () => {
    expect(howKilled(-1, null, false, 'shell')).toBe('shelled');
    expect(howKilled(-1, null, false, 'round')).toBe('shot from the line');
    expect(howKilled(-1, null, false, 'fire')).toBe('burned');
    expect(howKilled(2, 'head', false, 'round')).toBe('headshot');
    expect(howKilled(2, 'torso', true, 'round')).toBe('team-killed');
    expect(howKilled(2, 'limb', false, 'round')).toBe('shot');
  });
});

// A page that joins mid-match catches up on the room's log while the room plays on (together.ts
// welcomed): the match may end, and the next start, before the catch-up is done. Together is made
// here as the page makes it, on a stand-in for the page (FakePage) and the room's line (StubSocket),
// its clock the test's; the session and its battle are a room client's (tests/support/worlds.ts).

/** An element as the lobby and the match's HUD use it: what is set on it kept; children, none. */
class FakeElement {
  hidden = false;
  textContent = '';
  value = '';
  className = '';
  disabled = false;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  private readonly classes = new Set<string>();
  readonly classList = {
    add: (c: string) => void this.classes.add(c),
    remove: (c: string) => void this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
    toggle: (c: string, on: boolean) => void (on ? this.classes.add(c) : this.classes.delete(c)),
  };
  readonly elements = Object.assign([] as FakeElement[], { namedItem: () => null });
  private readonly listeners = new Map<string, (() => void)[]>();
  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  /** As a player's click: its listeners called. */
  click(): void {
    this.fire('click');
  }
  /** An event of `type` on it: its listeners called (a field's change). */
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  querySelector(): FakeElement {
    return new FakeElement();
  }
  querySelectorAll(): FakeElement[] {
    return [];
  }
  replaceChildren(): void {}
  append(): void {}
  select(): void {}
  focus(): void {}
}

/** The page as Together's lobby and HUD use it: its elements by id, each made as first asked for. */
class FakePage {
  activeElement: FakeElement | null = null;
  hidden = false;
  private readonly byId = new Map<string, FakeElement>();
  getElementById(id: string): FakeElement {
    let e = this.byId.get(id);
    if (!e) this.byId.set(id, (e = new FakeElement()));
    return e;
  }
  createElement(): FakeElement {
    return new FakeElement();
  }
  createTextNode(): FakeElement {
    return new FakeElement();
  }
  addEventListener(): void {}
}

/** The room's side of the line: the test opens it, says what the room says, and reads what the page sent. */
class StubSocket {
  static readonly OPEN = 1;
  static last: StubSocket | null = null;
  readyState = 0;
  readonly sent: { t: string; [k: string]: unknown }[] = [];
  private readonly listeners = new Map<string, ((e: unknown) => void)[]>();
  constructor(readonly url: string) {
    StubSocket.last = this;
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(text: string): void {
    this.sent.push(JSON.parse(text) as { t: string });
  }
  /** How the page closed it, if it did. */
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
  /** The line goes, not by the page's doing. */
  drop(reason = ''): void {
    this.readyState = 3;
    for (const fn of this.listeners.get('close') ?? []) fn({ reason });
  }
  /** What the page has sent of kind `t` since the last time asked, and forgotten. */
  took(t: string): { t: string; [k: string]: unknown }[] {
    const out = this.sent.filter((m) => m.t === t);
    this.sent.splice(0, this.sent.length, ...this.sent.filter((m) => m.t !== t));
    return out;
  }
}

describe("a page catching up on the room's log while the room plays on", () => {
  const tun = loadTunables();
  const fireT = fireTunables(tun);
  const PLAYER: [number, number, number] = [12.8, 6.4, 3.0];
  const shell = (id: number, landAt: number, x: number, z: number, seed: number): RoomShell => ({ id, landAt, at: [x, z], radius: 2.0, seed });
  const wire = (s: RoomShell) => [s.id, s.landAt, Math.round(s.at[0] * 1000), Math.round(s.at[1] * 1000), Math.round(s.radius * 1000), s.seed];
  const seats = [{ id: 0, name: 'Jordan', team: 'red', ready: true, away: false }];
  const MATCH = { startAt: 1_000, seed: 3, config: defaultConfig() };
  // Four shells on the parapet, every crater over the others: in any other order, another world.
  // S1 and S2 land before the welcome at 9 000; S3, told at 8 000, is in the air at it; S4 is told
  // at 9 100, after it. The room ends the match at 10 000, before S4 lands: every page there lands
  // it quietly then (RoomBattle.finish).
  const S1 = shell(1, 3_000, 11.0, 15.0, 861);
  const S2 = shell(2, 5_000, 12.5, 15.2, 862);
  const S3 = shell(3, 9_500, 11.8, 15.4, 863);
  const S4 = shell(4, 10_600, 12.0, 14.8, 864);

  /**
   * The world of a page that was there all along, the match over at 10 000 and every crater in: its
   * fourth shell `last` (S4 unless said), and `dig`, if any, relayed to it 40 ms after its stamp.
   */
  function stayed(last: RoomShell = S4, dig?: Dig) {
    const a = roomClient(trenchArena(), PLAYER);
    for (const [s, told] of [[S1, 1_500], [S2, 3_500], [S3, 8_000], [last, 9_100]] as const) {
      a.step(told);
      a.battle.hear(s, told);
    }
    if (dig) {
      a.step(dig.at + 40);
      a.battle.dug(dig, dig.at + 40);
    }
    a.step(10_000);
    a.battle.finish();
    a.step(14_000);
    expect(a.battle.landed).toEqual([S1, S2, S3, last]);
    expect(a.battle.held).toEqual([]);
    expect(a.session.destruction.pending).toBe(0);
    return a;
  }

  let page = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', StubSocket);
    vi.stubGlobal('location', { href: 'http://localhost:5320/?room=ABCDE' });
    vi.stubGlobal('history', { replaceState() {} });
    vi.spyOn(performance, 'now').mockImplementation(() => page);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /**
   * A page joining the match: its Together, on a session not yet set to the room, welcomed at the
   * room's 9 000 (its page clock 1 000) with S1, S2 and S3 in the log. Its catch-up runs as main.ts's
   * does (no battle around the page here), and between its settles the page's frames run; at the
   * first, the room's `say` comes. Each battle the page makes is kept, in order.
   */
  async function joining(say: (room: StubSocket) => void) {
    const b = roomClient(trenchArena(), PLAYER);
    b.session.room = false;
    const doc = new FakePage();
    const made: RoomBattle[] = [];
    let yields = 0;
    const status: string[] = [];
    const frame = () => {
      together.prepare(b.session, 1 / 60);
      together.frame(b.session, false);
    };
    const yieldNow = async () => {
      yields++;
      page += 16;
      expect(together.caughtUp).toBe(false);
      if (yields === 1) {
        say(StubSocket.last!);
        status.push(doc.getElementById('lobby-status').textContent);
      }
      frame();
    };
    const hooks: TogetherHooks = {
      map: defaultConfig().map,
      switchMap() {},
      showLobby() {},
      startScreen() {},
      deploy() {},
      play() {},
      ended() {},
      note() {},
      killed() {},
      respawn() {},
      battle: () => {
        made.push(new RoomBattle(b.session, fireT));
        return made[made.length - 1];
      },
      catchUp: (room, log, match, now, progress) => room.catchUp(log, match?.startAt ?? null, now, null, yieldNow, { progress }),
      failed() {},
    };
    const together = new Together(doc as unknown as Document, 'http://relay.test', 'build', null, hooks);
    together.join('ABCDE');
    page = 1_000;
    StubSocket.last!.open();
    StubSocket.last!.say({ t: 'welcome', you: 0, room: 'ABCDE', owner: 0, seats, config: defaultConfig(), phase: 'playing', match: MATCH, now: 9_000, log: { shells: [S1, S2, S3].map(wire), digs: [] } });
    expect(together.caughtUp).toBe(false);
    // The catch-up's end, and what the page's welcome does after it.
    await together.catchingUp;
    // The room spoke inside S1's settle, and the catch-up went on after it: S2's settle yields too.
    expect(yields).toBeGreaterThan(1);
    return { b, together, made, status, frame };
  }

  /** `b`'s craters cut until none is pending, as its frames would once it plays. */
  function settled(b: ReturnType<typeof roomClient>): void {
    for (let k = 0; k < 2_000 && b.session.destruction.pending > 0; k++) b.session.advance(1 / 60);
    expect(b.session.destruction.pending).toBe(0);
  }

  it("a match that ends during the catch-up ends with the room's world: the log's rest first, then the shells in the air, quietly", async () => {
    const a = stayed();
    // At the catch-up's first yield, inside S1's settle: S4 is told, and the room ends the match.
    const { b, together, made, status } = await joining((room) => {
      room.say({ t: 'shell', s: wire(S4) });
      room.say({ t: 'end' });
    });
    // S1 and S2 are due (S3 is still in the air), and the first yield is inside S1's settle.
    expect(status).toEqual(['Catching up on the battle… 0 of 2']);
    expect(together.caughtUp).toBe(true);
    // One battle, the one caught up: it lands the log's rest in order, then the match over lands
    // S3 (in the air at the welcome) and S4 (told after it), as on the page that was there.
    expect(made).toHaveLength(1);
    expect(together.battle).toBeNull();
    expect([made[0].landed, made[0].waiting, made[0].held]).toEqual([[S1, S2, S3, S4], [], []]);
    // Quietly, and with no whistle: the match is over, so every time has passed.
    const e = b.session.drainEvents();
    expect([e.incoming, e.blasts, e.harms]).toEqual([[], [], []]);
    settled(b);
    expect(b.session.destruction.lastId).toBe(4);
    expect(sameWorld(a.session.map, b.session.map)).toBe(true);
  }, 30_000);

  it("the next match started during the catch-up is the next battle's: its shells are not the last match's to land", async () => {
    // As above, then the owner starts the next match at 10 500 and its first shell is told: the
    // page's battle for it is made once the catch-up is done, as the room's edits since the start.
    const S5 = shell(5, 12_100, 6.0, 15.0, 865);
    const { b, together, made, frame } = await joining((room) => {
      room.say({ t: 'shell', s: wire(S4) });
      room.say({ t: 'end' });
      room.say({ t: 'start', match: { ...MATCH, startAt: 10_500 } });
      room.say({ t: 'shell', s: wire(S5) });
    });
    expect(made).toHaveLength(1);
    expect(together.battle).toBeNull();
    expect([made[0].landed, made[0].waiting]).toEqual([[S1, S2, S3, S4], []]);
    expect(b.session.drainEvents().incoming).toEqual([]);
    frame();
    expect(made).toHaveLength(2);
    expect(together.battle).toBe(made[1]);
    expect([made[1].landed, made[1].waiting]).toEqual([[], [S5]]);
    // S5 whistles for its time, as any shell heard live does.
    expect(b.session.drainEvents().incoming).toHaveLength(1);
  }, 30_000);

  it("a scoop the room relays before the end, stamped after two shells in the air, lands them on the room's ground, though the page's frames have set it off the room", async () => {
    // S4 lands at 9 800 this time, before the end, and S3's crater is under its centre. Another
    // player scoops four voxels in a row along the parapet's crest 11 m along it, stamped 9 900 (a row
    // along x: the arena's cells are packed by its own dims, and the wire checks a scoop's span by the
    // world's): on the page that was there S3 and S4 land live, each centred on the ground as it is
    // when its crater goes out. Here the end waits for the catch-up, by when the lobby's frames have
    // set the session off the room; the scoop, given at the end, lands S3 and S4 together, before
    // S3's crater is cut.
    const S4e = shell(4, 9_800, 12.0, 14.8, 864);
    const dims = trenchArena().dims;
    const D: Dig = { seat: 1, at: 9_900, cells: [[230, 75, 150], [231, 75, 150], [232, 75, 150], [233, 75, 150]].map(([x, y, z]) => packCell(dims, x, y, z)) };
    const a = stayed(S4e, D);
    const { b, together, made } = await joining((room) => {
      room.say({ t: 'shell', s: wire(S4e) });
      room.say({ t: 'dig', d: [D.seat, D.at, ...D.cells] });
      room.say({ t: 'end' });
    });
    expect(together.caughtUp).toBe(true);
    expect(made).toHaveLength(1);
    expect([made[0].landed, made[0].waiting, made[0].held]).toEqual([[S1, S2, S3, S4e], [], []]);
    expect(b.session.drainEvents().blasts).toEqual([]);
    settled(b);
    expect(b.session.destruction.lastId).toBe(4);
    // The scoop went in, here as there.
    expect(b.session.map.get(230, 75, 150)).toBe(P.AIR);
    expect(sameWorld(a.session.map, b.session.map)).toBe(true);
  }, 30_000);

  /**
   * A page in the match from the room's 9 000, its log empty, its catch-up the hook's `catchUp`; Sam
   * (seat 1) fights for Blue. Returned once the catch-up is done, and the page's welcome after it,
   * unless `wait` is false.
   */
  async function welcomed(catchUp: TogetherHooks['catchUp'], failed: (e: unknown) => void = () => {}, wait = true) {
    const b = roomClient(trenchArena(), PLAYER);
    const doc = new FakePage();
    const hooks: TogetherHooks = {
      map: defaultConfig().map,
      switchMap() {},
      showLobby() {},
      startScreen() {},
      deploy() {},
      play() {},
      ended() {},
      note() {},
      killed() {},
      respawn() {},
      battle: () => new RoomBattle(b.session, fireT),
      catchUp,
      failed,
    };
    const together = new Together(doc as unknown as Document, 'http://relay.test', 'build', null, hooks);
    together.join('ABCDE');
    page = 1_000;
    StubSocket.last!.open();
    const both = [...seats, { id: 1, name: 'Sam', team: 'blue', ready: true, away: false }];
    StubSocket.last!.say({ t: 'welcome', you: 0, room: 'ABCDE', owner: 0, seats: both, config: defaultConfig(), phase: 'playing', match: MATCH, now: 9_000, log: { shells: [], digs: [] } });
    // The catch-up's end, and what the page's welcome does after it.
    if (wait) await together.catchingUp;
    return { b, doc, together };
  }

  it("says how far its catch-up has come, in the lobby's status and on the way in, and offers neither Ready nor Start until it is done", async () => {
    let report!: (done: number, total: number) => void;
    let finish!: () => void;
    const { b, doc, together } = await welcomed(
      (_room, _log, _match, _now, progress) => {
        report = progress;
        return new Promise<void>((resolve) => (finish = resolve));
      },
      () => {},
      false,
    );
    const shown = () => {
      together.frame(b.session, false);
      const el = (id: string) => doc.getElementById(id);
      return [el('lobby-status').textContent, el('deploy-line').textContent, el('ready').disabled, el('start').disabled];
    };
    expect(together.caughtUp).toBe(false);
    expect(shown()).toEqual(['Catching up on the battle…', 'Catching up on the battle…', true, true]);
    report(0, 400);
    expect(shown()).toEqual(['Catching up on the battle… 0 of 400', 'Catching up on the battle… 0 of 400', true, true]);
    report(120, 400);
    expect(shown()).toEqual(['Catching up on the battle… 120 of 400', 'Catching up on the battle… 120 of 400', true, true]);
    // The room says more meanwhile (a roster): the page still says how far it has come.
    StubSocket.last!.say({ t: 'roster', owner: 0, seats });
    expect(shown()).toEqual(['Catching up on the battle… 120 of 400', 'Catching up on the battle… 120 of 400', true, true]);
    finish();
    await together.catchingUp;
    expect(together.caughtUp).toBe(true);
    // On the way in (the lobby's status is the gathering's, hidden while the match is on): Go, Ready and Start.
    const [, line, ready, start] = shown();
    expect(line).toBe('The match is on. You fight for Red.');
    expect(doc.getElementById('go').hidden).toBe(false);
    expect([ready, start]).toEqual([false, false]);
  });

  it("a match's end keeps its battle as it left it, its shell in the air landed, and counts the scoops it carries to the next match's battle until that takes them", async () => {
    // The match on at the room's 9 000; told before the end: a shell landing at 9 500 on the heap's
    // crest, and Sam's scoop of its spoil stamped 9 600, inside its crater's region. The end lands the
    // shell quietly, its crater not yet cut (the lobby runs no frame), so the scoop is held behind it.
    const { b, together } = await welcomed(async () => {});
    const battle = together.battle!;
    expect(together.lastBattle).toBeNull();
    expect(together.carriedScoops).toBe(0);
    const S = shell(5, 9_500, 11.8, 15.4, 865);
    const D: Dig = { seat: 1, at: 9_600, cells: [packCell(b.session.map.dims, 118, 70, 154), packCell(b.session.map.dims, 119, 70, 154)] };
    StubSocket.last!.say({ t: 'shell', s: wire(S) });
    StubSocket.last!.say({ t: 'dig', d: [D.seat, D.at, ...D.cells] });
    StubSocket.last!.say({ t: 'end' });
    expect(together.battle).toBeNull();
    expect(together.lastBattle).toBe(battle);
    expect(battle.landed).toEqual([S]);
    expect(together.carriedScoops).toBe(1);
    // The next match: its battle, made with its first frame, takes them.
    StubSocket.last!.say({ t: 'start', match: { ...MATCH, startAt: 12_000 } });
    together.prepare(b.session, 1 / 60);
    expect(together.battle).not.toBeNull();
    expect(together.battle!.held).toEqual([D]);
    expect(together.carriedScoops).toBe(0);
    expect(together.lastBattle).toBe(battle);
  }, 30_000);

  // The only test of the `failed` hook (TogetherHooks.failed, main.ts's stop): no e2e reaches it, and
  // the game has no dev fault hook to make a catch-up fail on purpose (the shared-battle plan's Task 8b,
  // item 11: none is to be added).
  it("a catch-up whose hook fails outside the room's log stops the page with its error, rather than leaving it catching up", async () => {
    const boom = new Error('the regions could not be copied');
    const failed: unknown[] = [];
    const { b, doc, together } = await welcomed(async () => {
      throw boom;
    }, (e) => failed.push(e));
    expect(failed).toEqual([boom]);
    // Not caught up, so the page plays nothing on a world that is not the room's; and it does not say it is catching up.
    expect(together.caughtUp).toBe(false);
    expect(doc.getElementById('lobby-status').textContent).not.toBe('Catching up on the battle…');
    expect(doc.getElementById('lobby-status').textContent).toContain(boom.message);
    // The room says more (a roster, a frame of the deploy screen): the page still says why it stopped.
    StubSocket.last!.say({ t: 'roster', owner: 0, seats });
    together.frame(b.session, false);
    expect(doc.getElementById('lobby-status').textContent).toContain(boom.message);
    expect(doc.getElementById('deploy-line').textContent).not.toBe('Catching up on the battle…');
  });

  it("flies others' shots only once caught up: a backlog all of it, in order, no more a frame than the round pool has room for, and silent once more than SILENT_STEP_S old", async () => {
    let finish!: () => void;
    const { b, together } = await welcomed(() => new Promise<void>((resolve) => (finish = resolve)), () => {}, false);
    const fired = vi.spyOn(b.session, 'fireRemote');
    // Sam fires 300 rounds, from 0.6 m over the clay straight down into it, stamped from the room's
    // 9 000 (the welcome's time) on; 2 s later the page is still catching up, and fires none.
    for (let k = 0; k < 300; k++) {
      const shot = encodeShot({ tick: k, origin: [10 + (k % 100) * 0.05, 7.0, 20 + Math.floor(k / 100)], dir: [0, -1, 0], tracer: true });
      StubSocket.last!.say({ t: 'f', s: 9_000 + k, ps: [], sh: [[1, ...shot]] });
    }
    page = 3_000;
    together.prepare(b.session, 1 / 60);
    expect(fired).not.toHaveBeenCalled();
    finish();
    await together.catchingUp;
    expect(together.caughtUp).toBe(true);
    // Caught up: the backlog flies, as many a frame as the pool has room for, the rest the next frames.
    const share = b.session.roundRoom();
    const perFrame: number[] = [];
    for (let f = 0; f < 10 && fired.mock.calls.length < 300; f++) {
      const before = fired.mock.calls.length;
      together.prepare(b.session, 1 / 60);
      perFrame.push(fired.mock.calls.length - before);
      b.session.advance(1 / 60);
    }
    expect(perFrame[0]).toBe(share);
    expect(perFrame.reduce((a, n) => a + n, 0)).toBe(300);
    expect(b.session.rounds.dropped).toBe(0);
    expect(fired.mock.calls.map((c) => c[7])).toEqual(Array.from({ length: 300 }, (_, k) => k));
    // Each more than SILENT_STEP_S old: silent, so nothing said of any.
    expect(fired.mock.calls.every((c) => c[8] === true)).toBe(true);
    expect(b.session.drainEvents().remoteShots).toEqual([]);
    // One fresh: aloud.
    StubSocket.last!.say({ t: 'f', s: together.net!.serverNow(), ps: [], sh: [[1, ...encodeShot({ tick: 300, origin: [12, 7, 22], dir: [0, -1, 0], tracer: true })]] });
    together.prepare(b.session, 1 / 60);
    expect(fired.mock.calls.at(-1)![8]).toBe(false);
    expect(b.session.drainEvents().remoteShots).toHaveLength(1);
  });

  it("leaves the player's own trigger room after a backlog: the drain fills the round pool to three quarters at most, and an M870's nine pellets all fly on the next tick", async () => {
    let finish!: () => void;
    const { b, together } = await welcomed(() => new Promise<void>((resolve) => (finish = resolve)), () => {}, false);
    // The player's M870 up, settled a second.
    b.session.equip({ primary: 'm870', secondary: 'm17', fits: {} });
    b.session.intent = idleIntent();
    for (let k = 0; k < 60; k++) b.session.tick();
    b.session.drainEvents();
    // Sam's backlog, more rounds than the pool holds, flies once the page is caught up.
    const capacity = tun.i('ballistics.pool_capacity');
    for (let k = 0; k < capacity + 44; k++) {
      const shot = encodeShot({ tick: k, origin: [10 + (k % 100) * 0.05, 7.0, 20 + Math.floor(k / 100)], dir: [0, -1, 0], tracer: true });
      StubSocket.last!.say({ t: 'f', s: 9_000 + k, ps: [], sh: [[1, ...shot]] });
    }
    page = 3_000;
    finish();
    await together.catchingUp;
    const remote = vi.spyOn(b.session, 'fireRemote');
    together.prepare(b.session, 1 / 60);
    expect(remote).toHaveBeenCalledTimes(Math.floor(0.75 * capacity));
    // The next tick, the player pulls the trigger: every pellet of it flies, none dropped.
    const fire = vi.spyOn(b.session.rounds, 'fire');
    b.session.intent = { ...idleIntent(), fire: true };
    b.session.tick();
    expect(b.session.drainEvents().shots).toHaveLength(1);
    const own = fire.mock.calls.flatMap((c, i) => (c[3] === 0 ? [fire.mock.results[i].value as number] : []));
    expect(own).toHaveLength(tun.i('weapon.m870.pellets'));
    expect(own.every((slot) => slot >= 0)).toBe(true);
    expect(b.session.rounds.dropped).toBe(0);
  });

  it("a line lost while the page catches up keeps saying why as the catch-up says how far it has come", async () => {
    let report!: (done: number, total: number) => void;
    let finish!: () => void;
    const { doc, together } = await welcomed(
      (_room, _log, _match, _now, progress) => {
        report = progress;
        return new Promise<void>((resolve) => (finish = resolve));
      },
      () => {},
      false,
    );
    const status = () => doc.getElementById('lobby-status').textContent;
    report(0, 400);
    expect(status()).toBe('Catching up on the battle… 0 of 400');
    StubSocket.last!.drop();
    const LOST = 'The connection to the game was lost. Reload the page to rejoin.';
    expect(status()).toBe(LOST);
    // The catch-up goes on (the page is still its own world), and says how far: not over the reason.
    report(120, 400);
    expect(status()).toBe(LOST);
    report(400, 400);
    expect(status()).toBe(LOST);
    finish();
    await together.catchingUp;
    expect(status()).toBe(LOST);
  });

  it("a line lost while the page catches up still says why once it is done, not that the host will start", async () => {
    let finish!: () => void;
    const { doc, together } = await welcomed(() => new Promise<void>((resolve) => (finish = resolve)), () => {}, false);
    StubSocket.last!.drop();
    const LOST = 'The connection to the game was lost. Reload the page to rejoin.';
    expect(doc.getElementById('lobby-status').textContent).toBe(LOST);
    finish();
    await together.catchingUp;
    expect(together.caughtUp).toBe(true);
    expect(doc.getElementById('lobby-status').textContent).toBe(LOST);
    // And whatever the room is said to do after: nothing comes on a closed line, but the page shows it again.
    StubSocket.last!.say({ t: 'roster', owner: 0, seats });
    expect(doc.getElementById('lobby-status').textContent).toBe(LOST);
  });

  it('sends nothing of the player from the deploy screen; once they have gone in, their state, their hurts once the match has begun and their scoops, and nothing once fallen', async () => {
    const { b, doc, together } = await welcomed(async () => {});
    const room = StubSocket.last!;
    const frames = () => {
      for (let k = 0; k < 3; k++) {
        page += 100;
        together.frame(b.session, true);
      }
    };
    /** A frame's events: the battle's harm to the player, and a scoop of theirs. */
    const harmed = () => ({ ...b.session.drainEvents(), harms: [{ tick: 1, amount: 30, cause: 'shell' as const }], scoops: [{ tick: 1, voxels: 1, at: [1, 2, 3] as [number, number, number], cells: [5] }] });
    const told = () => {
      together.after(b.session, harmed(), [], page);
      return [room.took('hurt').length, room.took('dig').length];
    };
    expect(together.begun).toBe(true);
    // On the deploy screen, the match on: no state, no hurt, no scoop.
    frames();
    expect(room.took('s')).toEqual([]);
    expect(told()).toEqual([0, 0]);
    // Go: in.
    doc.getElementById('go').click();
    frames();
    expect(room.took('s').length).toBeGreaterThan(0);
    expect(told()).toEqual([1, 1]);
    // A clock sample that pulls the room's time back under the match's start: a scoop is still the
    // world's, and told; a hurt waits for the match.
    const serverNow = vi.spyOn(together.net!, 'serverNow').mockReturnValue(MATCH.startAt - 200);
    expect(together.begun).toBe(false);
    expect(told()).toEqual([0, 1]);
    serverNow.mockRestore();
    // Killed: nothing.
    room.say({ t: 'death', v: 0, k: -1, z: null, tk: false, c: 'shell' });
    expect(told()).toEqual([0, 0]);
  });

  it("ceases the front's fire once the match is won: a hurt on the victory screen would do nothing", async () => {
    const { b, together } = await welcomed(async () => {});
    b.session.front.intensity = 'heavy';
    together.prepare(b.session, 1 / 60);
    StubSocket.last!.say({ t: 'over', winner: 'red', red: 30, blue: 12 });
    expect(b.session.front.intensity).toBe('off');
  });

  it("a kill whose killer is seated nowhere the room has said reads as a plain kill, not the line's", async () => {
    const { b, together } = await welcomed(async () => {});
    expect(together.caughtUp).toBe(true);
    const fallen = vi.spyOn(MatchHud.prototype, 'fallen');
    const line = (k: number, c: 'round' | 'shell') => {
      StubSocket.last!.say({ t: 'death', v: 0, k, z: 'torso', tk: false, c });
      together.after(b.session, b.session.drainEvents(), [], page);
      const [by, , cause] = fallen.mock.calls.at(-1)!;
      return fallenLine(by, cause ?? 'shell');
    };
    // Seat 5 has left (or was never told): killed, by no one the page can name.
    expect(line(5, 'round')).toBe('Killed');
    expect(line(1, 'round')).toBe('Killed by Sam');
    expect(line(-1, 'round')).toBe('Shot from the line');
    expect(line(-1, 'shell')).toBe('Killed by the shelling');
  });
});

// Joining a game, as a friend does it (the release audit's UX-1, ROBUST-6, UX-6, ROBUST-2/3/5/8): the
// start screen stays up, saying so, until the room's welcome; a join that fails before it goes back to
// the start screen saying why; the page keeps a rejoin token per room in its tab, and lets go of its
// line when it stops; and the way in after a win says who won.
describe('joining a game from the start screen', () => {
  const PLAYER: [number, number, number] = [12.8, 6.4, 3.0];
  const MATCH = { startAt: 1_000, seed: 3, config: defaultConfig() };
  const fireT = fireTunables(loadTunables());

  /** A tab's sessionStorage: what is set, kept. */
  class FakeStorage {
    private readonly items = new Map<string, string>();
    get length(): number {
      return this.items.size;
    }
    getItem(k: string): string | null {
      return this.items.get(k) ?? null;
    }
    setItem(k: string, v: string): void {
      this.items.set(k, v);
    }
    removeItem(k: string): void {
      this.items.delete(k);
    }
    clear(): void {
      this.items.clear();
    }
    key(i: number): string | null {
      return [...this.items.keys()][i] ?? null;
    }
  }

  let address: { href: string };
  beforeEach(() => {
    vi.stubGlobal('WebSocket', StubSocket);
    address = { href: 'http://localhost:5320/?map=ravine' };
    vi.stubGlobal('location', address);
    vi.stubGlobal('history', { replaceState: (_s: unknown, _t: string, url: URL | string) => void (address.href = String(url)) });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** A page with the start screen up (what it says kept), its tab's storage `tab` and its own (localStorage) `local`. */
  function aPage(tab: FakeStorage | null = null, local: Pick<Storage, 'getItem' | 'setItem'> | null = null) {
    const doc = new FakePage();
    const said: [string, boolean][] = [];
    const notes: string[] = [];
    const count = { lobby: 0, play: 0 };
    let b: ReturnType<typeof roomClient> | null = null;
    const hooks: TogetherHooks = {
      map: defaultConfig().map,
      switchMap() {},
      showLobby: () => void count.lobby++,
      startScreen: (text, busy) => void said.push([text, busy]),
      deploy() {},
      play: () => void count.play++,
      ended() {},
      note: (text) => void notes.push(text),
      killed() {},
      respawn() {},
      battle: () => new RoomBattle((b ??= roomClient(trenchArena(), PLAYER)).session, fireT),
      catchUp: async () => {},
      failed() {},
    };
    const together = new Together(doc as unknown as Document, 'http://relay.test', 'build', local as Storage | null, hooks, null, { tab: tab as unknown as Storage | null, silentS: 10 });
    return { doc, said, notes, count, together, session: () => (b ??= roomClient(trenchArena(), PLAYER)).session };
  }

  it('waits on the start screen, saying so; turned away, says why there, the address forgetting the room, and another join can go', () => {
    const { said, count, together } = aPage();
    together.join('abcde');
    expect(said).toEqual([['Joining game ABCDE\u2026', true]]);
    expect(address.href).toContain('room=ABCDE');
    StubSocket.last!.open();
    StubSocket.last!.say({ t: 'refused', reason: 'no-room' });
    StubSocket.last!.drop('no-room');
    expect(said.at(-1)).toEqual(['No game with that code', false]);
    expect(said).toHaveLength(2);
    expect(together.net).toBeNull();
    expect(address.href).not.toContain('room=');
    expect(count.lobby).toBe(0);
    // The relay never answers: said so, the same way.
    together.join('KXQRT');
    expect(StubSocket.last!.url).toBe('ws://relay.test/room/KXQRT');
    StubSocket.last!.drop();
    expect(said.at(-1)).toEqual([LOST.unreachable, false]);
    expect(together.net).toBeNull();
    // A full game, and one on another version.
    for (const [reason, text] of [['full', 'That game is full (8 players)'], ['version', 'That game is on another version: reload the page']]) {
      together.join('KXQRT');
      StubSocket.last!.open();
      StubSocket.last!.say({ t: 'refused', reason });
      expect(said.at(-1)).toEqual([text, false]);
    }
  });

  it("checks a typed code against the relay's letters before connecting", () => {
    const { said, together } = aPage();
    const before = StubSocket.last;
    together.join('HOUSE');
    expect(said).toEqual([['Codes never use I or O: check the code', false]]);
    together.join('ab');
    expect(said.at(-1)).toEqual(['A game code is five letters.', false]);
    expect(StubSocket.last).toBe(before);
    expect(together.net).toBeNull();
  });

  it('brings the lobby up with the welcome, and not before', async () => {
    const { count, together } = aPage();
    together.join('ABCDE');
    StubSocket.last!.open();
    expect(count.lobby).toBe(0);
    StubSocket.last!.say({ t: 'welcome', you: 0, room: 'ABCDE', owner: 0, seats: [{ id: 0, name: 'Jordan', team: 'red', ready: false, away: false }], config: defaultConfig(), phase: 'lobby', match: null, now: 9_000, log: { shells: [], digs: [] } });
    await together.catchingUp;
    expect(count.lobby).toBeGreaterThan(0);
  });

  it("keeps a rejoin token for each room in the tab, random, and says it in its hello: the same tab's reload the same, another room's or another tab's its own", () => {
    const hello = (tab: FakeStorage | null, code: string) => {
      aPage(tab).together.join(code);
      StubSocket.last!.open();
      return StubSocket.last!.sent.find((m) => m.t === 'hello')!.token as string;
    };
    const tab = new FakeStorage();
    const first = hello(tab, 'ABCDE');
    expect(isToken(first)).toBe(true);
    expect(tab.getItem('trenchline.rejoin.ABCDE')).toBe(first);
    expect(hello(tab, 'ABCDE')).toBe(first);
    expect(hello(tab, 'KXQRT')).not.toBe(first);
    expect(hello(new FakeStorage(), 'ABCDE')).not.toBe(first);
    // No storage (refused it, or none): a token still, the page's own.
    const a = rejoinToken(null, 'ABCDE');
    expect(isToken(a)).toBe(true);
    expect(rejoinToken(null, 'ABCDE')).not.toBe(a);
    // One the tab kept that is not a page's is made afresh.
    const odd = new FakeStorage();
    odd.setItem('trenchline.rejoin.ABCDE', 'x');
    expect(isToken(rejoinToken(odd as unknown as Storage, 'ABCDE'))).toBe(true);
  });

  it("remembers the name the player types (the G6 playtest's P4), and says it in the next hello; storage refused, nothing kept and nothing broken", () => {
    const helloName = (local: Pick<Storage, 'getItem' | 'setItem'> | null) => {
      const page = aPage(null, local);
      page.together.join('ABCDE');
      StubSocket.last!.open();
      return { page, name: StubSocket.last!.sent.find((m) => m.t === 'hello')!.name };
    };
    const local = new FakeStorage();
    // Nothing typed yet: the page says no name, and the room calls them Soldier (net/protocol.ts cleanName).
    const first = helloName(local);
    expect(first.name).toBe('');
    StubSocket.last!.say({ t: 'welcome', you: 0, room: 'ABCDE', owner: 0, seats: [{ id: 0, name: 'Soldier', team: 'red', ready: false, away: false }], config: defaultConfig(), phase: 'lobby', match: null, now: 9_000, log: { shells: [], digs: [] } });
    // The player types their name in the lobby: the room told, and the name kept.
    const field = first.page.doc.getElementById('name');
    field.value = 'Jordan';
    field.fire('change');
    expect(StubSocket.last!.took('name')).toEqual([{ t: 'name', name: 'Jordan' }]);
    expect(local.getItem('trenchline.name')).toBe('Jordan');
    // The next visit (another game, another day) says it from the first word.
    expect(helloName(local).name).toBe('Jordan');
    // Storage that refuses: no name kept or read, and the page plays on.
    const refusing = {
      getItem(): string | null {
        throw new Error('denied');
      },
      setItem(): void {
        throw new Error('denied');
      },
    };
    const shut = helloName(refusing);
    expect(shut.name).toBe('');
    const shutField = shut.page.doc.getElementById('name');
    shutField.value = 'Sam';
    expect(() => shutField.fire('change')).not.toThrow();
    expect(StubSocket.last!.took('name')).toEqual([{ t: 'name', name: 'Sam' }]);
  });

  /** Welcomed into the match from the room's 9 000, caught up. */
  async function inMatch(tab: FakeStorage | null = null) {
    const p = aPage(tab);
    p.together.join('ABCDE');
    StubSocket.last!.open();
    const seats = [
      { id: 0, name: 'Jordan', team: 'red', ready: true, away: false },
      { id: 1, name: 'Sam', team: 'blue', ready: true, away: false },
    ];
    StubSocket.last!.say({ t: 'welcome', you: 0, room: 'ABCDE', owner: 0, seats, config: defaultConfig(), phase: 'playing', match: MATCH, now: 9_000, log: { shells: [], digs: [] } });
    await p.together.catchingUp;
    expect(p.together.caughtUp).toBe(true);
    return p;
  }

  it('lets go of its line when the page stops, saying nothing: the others see the player leave', async () => {
    const { said, notes, together } = await inMatch();
    const before = said.length;
    together.letGo();
    expect(StubSocket.last!.closedWith).toEqual([1000, 'stopped']);
    StubSocket.last!.drop('stopped');
    expect([said.length, notes]).toEqual([before, []]);
  });

  it('says on the way in, in the seconds after a win, who won and that the next match starts in the lobby, with no Go', async () => {
    const { doc, count, together, session } = await inMatch();
    together.frame(session(), false);
    expect(doc.getElementById('deploy-line').textContent).toBe('The match is on. You fight for Red.');
    expect(doc.getElementById('go').hidden).toBe(false);
    StubSocket.last!.say({ t: 'over', winner: 'blue', red: 14, blue: 20 });
    together.frame(session(), false);
    expect(doc.getElementById('deploy-line').textContent).toBe('Blue won 20\u201314. The next match starts in the lobby.');
    expect(doc.getElementById('go').hidden).toBe(true);
    doc.getElementById('go').click();
    expect(count.play).toBe(0);
  });

  it('says who won on the way in, with no Go, joining or back in the seconds after a win (the room tells it after its welcome)', async () => {
    const { doc, count, together, session } = aPage();
    together.join('ABCDE');
    StubSocket.last!.open();
    const seats = [
      { id: 0, name: 'Jordan', team: 'red', ready: false, away: false },
      { id: 1, name: 'Sam', team: 'blue', ready: false, away: false },
    ];
    StubSocket.last!.say({ t: 'welcome', you: 1, room: 'ABCDE', owner: 0, seats, config: defaultConfig(), phase: 'playing', match: MATCH, now: 9_000, log: { shells: [], digs: [] } });
    StubSocket.last!.say({ t: 'score', red: 20, blue: 14, ps: [[0, 9, 2], [1, 3, 5]] });
    StubSocket.last!.say({ t: 'over', winner: 'red', red: 20, blue: 14 });
    await together.catchingUp;
    together.frame(session(), false);
    expect(doc.getElementById('deploy-line').textContent).toBe('Red won 20–14. The next match starts in the lobby.');
    expect(doc.getElementById('go').hidden).toBe(true);
    doc.getElementById('go').click();
    expect(count.play).toBe(0);
  });

  it('says the room closed for nobody playing in it, with only the way back to the start screen left', async () => {
    const { doc, notes, together } = await inMatch();
    StubSocket.last!.say({ t: 'closing', reason: 'idle' });
    StubSocket.last!.drop('idle');
    expect(together.inMatch).toBe(false);
    expect(doc.getElementById('lobby-status').textContent).toBe('The game was closed after 20 minutes with nobody playing');
    expect(notes).toEqual([LOST.idle]);
    expect(doc.getElementById('leave').textContent).toBe('Back to the start');
    expect([doc.getElementById('ready').disabled, doc.getElementById('start').disabled]).toEqual([true, true]);
    // Whatever is shown again after, the same.
    StubSocket.last!.say({ t: 'roster', owner: 0, seats: [] });
    expect(doc.getElementById('lobby-status').textContent).toBe(LOST.idle);
    expect(doc.getElementById('ready').disabled).toBe(true);
  });

  it('sends a still soldier\u2019s state unchanged but for its tick, which the room does not count as playing (a forgotten tab mid-match idles)', () => {
    const b = roomClient(trenchArena(), PLAYER);
    for (let k = 0; k < 120; k++) b.session.advance(1 / 60);
    const first = encodeState(stateOf(b.session));
    for (let k = 0; k < 600; k++) {
      b.session.advance(1 / 60);
      const now = encodeState(stateOf(b.session));
      expect(now.slice(1), `frame ${k}`).toEqual(first.slice(1));
      if (k === 599) expect(now[0]).toBeGreaterThan(first[0]);
    }
  });
});
