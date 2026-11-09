import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HitFeedback, hitFeedbackTunables, type FeedbackMarker } from '../../src/app/hit-feedback';
import type { RemotePlayer } from '../../src/app/net-players';
import { Gaits, Together, type Figure, type TogetherHooks } from '../../src/app/together';
import { fireTunables } from '../../src/battle/fires';
import type { V3 } from '../../src/combat/soldier-rig';
import { loadTunables } from '../../src/core/tunables';
import type { Team, Zone } from '../../src/net/protocol';
import { RoomBattle } from '../../src/sim/room-battle';
import { idleIntent, LOCAL_BODY, Session, type CombatEvents } from '../../src/sim/session';
import { HitMarker, markerTunables, type MarkerKind, type PopText } from '../../src/ui/hit-marker';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';

// Playing with friends and the hit feedback (app/together.ts, app/hit-feedback.ts): the others in a
// room and a test's puppets drawn flinching and falling as their hits say; a death the room tells of
// between frames felt on the frame's clock, however far the page's own clock is from it; and this
// player's own death felt, when the round that killed them never was.

/** The room's line, stood in for: what Together reads of it, and the room's words, to say by hand. */
const { lines, FakeNet } = vi.hoisted(() => {
  const lines: InstanceType<typeof FakeNet>[] = [];
  class FakeNet {
    you = 0;
    owner = 0;
    seats: { id: number; name: string; team: 'red' | 'blue'; ready: boolean; away: boolean }[] = [];
    phase = 'playing';
    match: unknown = { startAt: 0, seed: 1, config: { map: 'ravine', killTarget: 30, timeOfDay: 19.5, lapse: 0, intensity: 'off', respawnS: 5 } };
    joined = true;
    score = { red: 0, blue: 0 };
    tallies = new Map<number, { kills: number; deaths: number }>();
    /** The others as the room's states have them now. */
    others: unknown[] = [];
    readonly players = { at: () => this.others };
    /** The room's clock, never sampled: no shell is heard or landed. */
    readonly clock = { synced: false };
    constructor(
      readonly relay: string,
      readonly room: string,
      readonly name: string,
      readonly build: string,
      readonly on: {
        death(victim: number, killer: number, zone: string | null, teamkill: boolean, cause: string): void;
      },
    ) {
      lines.push(this);
    }
    get seat() {
      return this.seats.find((s) => s.id === this.you);
    }
    get isOwner() {
      return this.you === this.owner;
    }
    serverNow() {
      return 1e9;
    }
    takeShots() {
      return [];
    }
    takeEdits() {
      return [];
    }
    hit() {}
    state() {}
    setName() {}
    team() {}
    ready() {}
    configure() {}
    start() {}
    end() {}
    away() {}
    close() {}
  }
  return { lines, FakeNet };
});

vi.mock('../../src/app/net-client', () => ({ NetClient: FakeNet, makeRoom: async () => 'ABCDE' }));

const tun = loadTunables();
const t = hitFeedbackTunables(tun);
/** The frame's clock, ms: a frozen page's steps, or a page whose clock a long pause moved on, far from performance.now(). */
const FRAME = 5_000_000;

type Call = ['show', MarkerKind, number] | ['pop', PopText, { name: string; team: Team } | null, number] | ['flash', number, number] | ['clear'];

/** A HitMarker that records what it is asked. */
class FakeMarker implements FeedbackMarker {
  readonly calls: Call[] = [];
  show(kind: MarkerKind, now: number): boolean {
    this.calls.push(['show', kind, now]);
    return true;
  }
  pop(text: PopText, name: { name: string; team: Team } | null, now: number): void {
    this.calls.push(['pop', text, name, now]);
  }
  flash(strength: number, now: number): void {
    this.calls.push(['flash', strength, now]);
  }
  clear(): void {
    this.calls.push(['clear']);
  }
}

/** Anything the page is asked for: an element that takes every call and every write, with nothing in it. */
function anything(): unknown {
  const p: unknown = new Proxy(function () {}, {
    get: (_, k) => (k === Symbol.iterator ? function* () {} : k === Symbol.toPrimitive ? () => 0 : k === 'then' ? undefined : p),
    set: () => true,
    apply: () => p,
  });
  return p;
}

/** The page's hooks, its room battle on `session`; no welcome comes, so nothing is caught up. */
const hooks = (session: Session): TogetherHooks => ({ map: 'ravine', switchMap() {}, showLobby() {}, deploy() {}, play() {}, ended() {}, note() {}, killed() {}, respawn() {}, battle: () => new RoomBattle(session, fireTunables(tun)), catchUp: async () => {}, failed() {} });

/** 25.6 × 6.4 × 51.2 m of sod 0.4 m deep, the player at (12.8, 0.4, 5) facing +z, settled. */
function field(): Session {
  const map = new BrickMap({ x: 256, y: 64, z: 512 });
  map.fillBox(0, 0, 0, 256, 4, 512, P.SOD);
  const s = Session.create({ map, plan: null, spawn: { position: [12.8, 0.4, 5] } }, tun, 7, 0);
  s.intent = idleIntent();
  for (let k = 0; k < 20; k++) s.tick();
  s.drainEvents();
  return s;
}

/** Together with `hits` on `session`, joined to a room whose match is on: this player seat 0 (Red), Ann seat 1 (Blue). */
function joined(hits: HitFeedback, session: Session): { together: Together; net: InstanceType<typeof FakeNet> } {
  const together = new Together(anything() as Document, 'http://127.0.0.1:8787', 'test', null, hooks(session), hits);
  together.join('ABCDE');
  const net = lines.at(-1)!;
  net.seats = [
    { id: 0, name: 'You', team: 'red', ready: true, away: false },
    { id: 1, name: 'Ann', team: 'blue', ready: true, away: false },
  ];
  return { together, net };
}

/** Nothing happened. */
const none = (): CombatEvents => ({ shots: [], frontShots: [], impacts: [], cracks: [], cuts: [], craters: [], incoming: [], blasts: [], scoops: [], splashes: [], remoteShots: [], hits: [], handling: [], harms: [] });

/** A test's puppet, standing 20 m out. */
const puppetOf = (): Figure => ({ seat: 100, team: 'blue', position: [12.8, 0.4, 25], velocity: [0, 0, 0], yaw: 180, pitch: 0, height: 1.8, deadFor: null });

/** A round of `owner`'s into body `body`'s torso along +z, on tick 1. */
const round = (owner: number, body: number, zone: Zone = 'torso'): CombatEvents['hits'][number] => ({ owner, body, zone, position: [12.8, 1.3, 25], dir: [0, 0, 1] as V3, distance: 20, tick: 1 });

beforeEach(() => {
  vi.stubGlobal('location', { href: 'http://localhost:5320/' });
  vi.stubGlobal('history', { replaceState() {} });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('playing with friends, and the hit feedback', () => {
  it('prepare poses the others and the puppets flinching as their hits say, as drawn and as struck; once settled, as they stand', () => {
    const s = field();
    const fb = new HitFeedback(t, new FakeMarker());
    const { together, net } = joined(fb, s);
    const state = (z: number) => ({ tick: 0, position: [12.8, 0.4, z] as [number, number, number], velocity: [0, 0, 0] as [number, number, number], yaw: 180, pitch: 0, stance: 0, height: 1.8, flags: 0, gear: 0 });
    const ann: RemotePlayer = { seat: net.seats[1], state: state(25) };
    net.others = [ann];
    const puppet: Figure = { seat: 100, team: 'red', position: [14.8, 0.4, 25], velocity: [0, 0, 0], yaw: 180, pitch: 0, height: 1.8, deadFor: null };
    const still: Figure = { ...puppet, seat: 101, position: [10.8, 0.4, 25] };
    // Ann as Together draws her: her seat, team and state, alive.
    const annFigure: Figure = { seat: 1, team: 'blue', ...state(25), deadFor: null };
    // Seat 2's round (owner 4) into Ann, the player's into the first puppet; none into the second.
    fb.frame(s, { ...none(), hits: [round(4, 1), round(0, 100, 'head')] }, FRAME);
    const at = FRAME + 50;
    const draws = together.prepare(s, 0, [puppet, still], at);
    expect(draws.map((d) => d.seat)).toEqual([1, 100, 101]);
    const posed = (f: Figure) => new Gaits().pose([f], 0)[0].frames;
    for (const [i, f] of [annFigure, puppet].entries()) {
      const o = fb.figureOverlay(f.seat, at);
      expect(o.flinch?.age).toBeCloseTo(0.05, 9);
      expect(draws[i].frames).toEqual(posed({ ...f, flinch: o.flinch }));
      expect(draws[i].frames).not.toEqual(posed(f));
    }
    expect(draws[2].frames).toEqual(posed(still));
    // Rounds strike them as they are drawn.
    expect(s.together).toBe(true);
    expect(s.bodies.map((b) => [b.id, b.frames])).toEqual(draws.map((d) => [d.seat, d.frames]));
    // Settled, they stand as they did.
    const later = together.prepare(s, 0, [puppet, still], FRAME + 1000 * t.flinchSpan * t.flinchS);
    expect(later.map((d) => d.frames)).toEqual([posed(annFigure), posed(puppet), posed(still)]);
  });

  it("a death the room tells of between frames is felt on the frame's clock: the kill marker of a frozen page shows its 0.6 s of frame time, however far performance.now() is", () => {
    const s = field();
    const marker = new HitMarker({ querySelector: () => null } as unknown as Document, markerTunables(tun));
    const fb = new HitFeedback(t, marker);
    const { together, net } = joined(fb, s);
    // The page's own clock stands far behind the frames' (a long pause simulated, a frozen page stepped).
    vi.spyOn(performance, 'now').mockReturnValue(5);
    together.prepare(s, 1 / 60, [], FRAME);
    // This player's round killed Ann, the room says.
    net.on.death(1, 0, 'torso', false, 'round');
    fb.frame(s, none(), FRAME + 16);
    marker.tick(FRAME + 16);
    expect(marker.state()).toEqual({ marker: 'kill', pop: 'KILL Ann' });
    marker.tick(FRAME + 600);
    expect(marker.state().marker).toBe('kill');
    marker.tick(FRAME + 720);
    expect(marker.state().marker).toBeNull();
    expect(fb.state().markers.kill).toBe(1);
  });

  it("this player's own death, its round never felt here (a one-shot kill): the red flash at full strength and the hurt voice from the room's word, on the frame's clock", () => {
    const s = field();
    const marker = new FakeMarker();
    const fb = new HitFeedback(t, marker);
    const { together, net } = joined(fb, s);
    vi.spyOn(performance, 'now').mockReturnValue(5);
    together.prepare(s, 1 / 60, [], FRAME);
    // Ann's round killed this player, by the room's word, before it reached them here.
    net.on.death(0, 1, 'head', false, 'round');
    expect(marker.calls).toEqual([['flash', 1, FRAME]]);
    expect(fb.frame(s, none(), FRAME + 16)).toEqual([{ kind: 'hurt', at: null, gain: 0.7 }]);
    expect(together.deadFor(5)).toBe(0);
  });

  it("prepare says the session is in a room's match (session.room), the one signal the hit feedback reads: the front's round into the player felt in the match, not out of it", () => {
    const s = field();
    s.together = true;
    const marker = new FakeMarker();
    const fb = new HitFeedback(t, marker);
    const { together, net } = joined(fb, s);
    together.prepare(s, 1 / 60, [], FRAME);
    expect(s.room).toBe(true);
    expect(fb.frame(s, { ...none(), hits: [round(1, LOCAL_BODY)] }, FRAME + 16)).toEqual([{ kind: 'hurt', at: null, gain: 0.7 }]);
    expect(marker.calls).toEqual([['flash', 0.55, FRAME + 16]]);
    // The match over, the room still joined: the next frame's prepare takes the room's harm away.
    net.phase = 'lobby';
    together.prepare(s, 1 / 60, [puppetOf()], FRAME + 32);
    expect([s.room, s.together]).toEqual([false, true]);
    expect(fb.frame(s, { ...none(), hits: [round(1, LOCAL_BODY)] }, FRAME + 48)).toEqual([]);
    expect(marker.calls).toHaveLength(1);
  });
});
