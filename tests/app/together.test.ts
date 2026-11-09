import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Gaits, howKilled, mapAction, relayUrl, shotTracer, Together, type Figure, type TogetherHooks } from '../../src/app/together';
import { fireTunables } from '../../src/battle/fires';
import { holdOf } from '../../src/combat/arsenal';
import { packCell } from '../../src/combat/entrenching';
import { pose, type PoseInput, type V3 } from '../../src/combat/soldier-rig';
import { loadTunables } from '../../src/core/tunables';
import { decodeGear, TRACER_KIND } from '../../src/net/gear';
import { defaultConfig, type Dig, type RoomShell, type Seat } from '../../src/net/protocol';
import { RoomBattle } from '../../src/sim/room-battle';
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
  it("a figure's own tape goes to its soldier; without one, the soldier wears its team's", () => {
    const figure = (seat: number, tape?: number): Figure => ({
      seat, team: 'blue', position: [12.8, 0.4, 30], velocity: [0, 0, 0], yaw: 180, pitch: 0, height: 1.8, deadFor: null,
      ...(tape === undefined ? {} : { tape }),
    });
    const [dummy, soldier] = new Gaits().pose([figure(200, P.TAPE_RANGE), figure(3)], 1 / 60);
    expect(dummy.tape).toBe(P.TAPE_RANGE);
    expect(dummy.team).toBe('blue');
    expect(soldier).not.toHaveProperty('tape');
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
  addEventListener(): void {}
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

/** The room's side of the line: the test opens it and says what the room says. */
class StubSocket {
  static readonly OPEN = 1;
  static last: StubSocket | null = null;
  readyState = 0;
  private readonly listeners = new Map<string, ((e: unknown) => void)[]>();
  constructor(readonly url: string) {
    StubSocket.last = this;
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(): void {}
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
    let caught: Promise<void> = Promise.resolve();
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
      catchUp: (room, log, match, now) => (caught = room.catchUp(log, match?.startAt ?? null, now, null, yieldNow)),
      failed() {},
    };
    const together = new Together(doc as unknown as Document, 'http://relay.test', 'build', null, hooks);
    together.join('ABCDE');
    page = 1_000;
    StubSocket.last!.open();
    StubSocket.last!.say({ t: 'welcome', you: 0, room: 'ABCDE', owner: 0, seats, config: defaultConfig(), phase: 'playing', match: MATCH, now: 9_000, log: { shells: [S1, S2, S3].map(wire), digs: [] } });
    expect(together.caughtUp).toBe(false);
    await caught;
    await Promise.resolve();
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
    expect(status).toEqual(['Catching up on the battle…']);
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

  /** A page in the match from the room's 9 000, its log empty, its catch-up the hook's `catchUp`; Sam (seat 1) fights for Blue. */
  async function welcomed(catchUp: TogetherHooks['catchUp'], failed: (e: unknown) => void = () => {}) {
    const b = roomClient(trenchArena(), PLAYER);
    const doc = new FakePage();
    const hooks: TogetherHooks = {
      map: defaultConfig().map,
      switchMap() {},
      showLobby() {},
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
    for (let k = 0; k < 10; k++) await Promise.resolve();
    return { b, doc, together };
  }

  it("a catch-up whose hook fails outside the room's log stops the page with its error, rather than leaving it catching up", async () => {
    const boom = new Error('the regions could not be copied');
    const failed: unknown[] = [];
    const { doc, together } = await welcomed(async () => {
      throw boom;
    }, (e) => failed.push(e));
    expect(failed).toEqual([boom]);
    // Not caught up, so the page plays nothing on a world that is not the room's; and it does not say it is catching up.
    expect(together.caughtUp).toBe(false);
    expect(doc.getElementById('lobby-status').textContent).not.toBe('Catching up on the battle…');
    expect(doc.getElementById('lobby-status').textContent).toContain(boom.message);
    // The room says more (a roster, a frame of the deploy screen): the page still says why it stopped.
    StubSocket.last!.say({ t: 'roster', owner: 0, seats });
    together.frame(roomClient(trenchArena(), PLAYER).session, false);
    expect(doc.getElementById('lobby-status').textContent).toContain(boom.message);
    expect(doc.getElementById('deploy-line').textContent).not.toBe('Catching up on the battle…');
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
