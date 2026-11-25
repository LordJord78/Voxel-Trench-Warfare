/**
 * A room and its players in Node (the shared-battle plan's Task 8, "The Node clients"): the real
 * RoomCore behind fake sockets, every message JSON both ways as on the wire, each player's line its
 * own delay each way, and each player a page as Together and main.ts run one, without a screen.
 *
 * Time is the room's true clock (ms), run by `RoomNet.runTo`: the room ticks every TICK_MS while it
 * ticks; a message arrives its line's delay after it was sent, at the room in the whole millisecond it
 * is heard in (the relay's clock is Date.now()); and each player's frames come every
 * `frameS` from when it connected. A player reckons the room's time as the true time plus its
 * `offsetMs` (its clock's error, which a page's pings leave it), so its frames tick its battle a little
 * off the room's, as a real page's do.
 *
 * Each player (NodeClient) has, as the page has:
 * - a Session on its own world (`map`: tests/support/worlds.ts cloneMap), its craters cut by `runner`
 *   (in-process unless given: a slow worker is lateRunner);
 * - a RoomBattle (sim/room-battle.ts) once welcomed, as Together makes one: the welcome's catch-up's,
 *   then each match's, made with its first frame and given the scoops the last one held;
 * - at its deploy, main.ts's battle: a Director over the plan on the match's clock (app/battle-clock.ts
 *   BattleClock), by day (darkness 0), given each frame's strikes (RoomBattle.strikes), its fires' chars
 *   made through a CharQueue once no crater is pending about them; and, catching up, run along the log
 *   (catchUpRunner), as main.ts's catchUp hook runs it.
 *
 * Each frame, as Together.prepare, main.ts's frame and Together.after do:
 * - the room's messages that have arrived, in order: the welcome (its catch-up awaited, the room's
 *   time held meanwhile, as a page's frames wait on it), the start (the deploy), and the shells, scoops
 *   and shots queued for the frame;
 * - in a match, once caught up: `session.room` true and `session.seat` the player's, every frame;
 *   the queued shells and scoops to `hear` and `dug` at the player's room clock, in arrival order;
 *   `tick`; then the queued shots fired (`fireRemote`, from the shooter's eye: no soldier is drawn),
 *   no more a frame than the round pool has room for (Session.roundRoom), silent once more than
 *   SILENT_STEP_S old. `session.together` stays false: no body is drawn, so it would only let a
 *   player's own body stop another's pellets on its own world;
 * - the test's hands on the player (`act`: its intent, its aim);
 * - the session run by the frame, once the match has begun on the player's clock;
 * - the player's state sent twenty times a second while in play, with the shots it fired as their
 *   words (ShotEvent.wire); the battle's hurts (once begun) and the player's scoops told the room
 *   (RoomBattle.outgoing);
 * - the frame's strikes to the Director, run on to the match's second, and its chars made.
 *
 * The front is left off on every player: in a room its rounds chip nothing (sim/session.ts), so it
 * changes no world, and nothing here is drawn for it to hurt.
 *
 * A player may hide its tab for a while (`hidden`, Task 8b's hidden tab): from the first frame at or
 * past the window's start on its match clock it says it is away and runs no frame (a hidden tab runs no
 * requestAnimationFrame) until the window's end, while the room's messages queue on its line as a
 * page's socket queues them; then it says it is back, and its next frame takes them all, as a page's
 * first frame back does.
 */

import { BattleClock, catchUpRunner } from '../../src/app/battle-clock';
import { stateOf } from '../../src/app/together';
import { Director, type BattleEvents, type BattleInputs } from '../../src/battle/director';
import { fireTunables } from '../../src/battle/fires';
import type { Loadout } from '../../src/combat/arsenal';
import { loadTunables } from '../../src/core/tunables';
import { matchSeconds, SILENT_STEP_S } from '../../src/net/clock';
import { teamTracer } from '../../src/net/gear';
import { RoomCore, type Conn } from '../../src/net/room-core';
import { decodeDig, decodeShell, decodeShot, encodeState, parseRoom, PROTOCOL, SHOTS_MAX, type ClientMsg, type Dig, type MatchInfo, type RoomShell, type Seat, type ShotState, type Team } from '../../src/net/protocol';
import type { DetonationRunner } from '../../src/sim/destruction';
import { RoomBattle } from '../../src/sim/room-battle';
import { Session, type CombatEvents } from '../../src/sim/session';
import type { BrickMap } from '../../src/world/bricks';
import { CharQueue } from '../../src/world/char';
import type { WorldPlan } from '../../src/world/generation/plan';
import { facingYaw, pickSpawns } from '../../src/world/generation/spawn';

const tun = loadTunables();
const fireT = fireTunables(tun);

/** The room's tick (the relay's alarm). */
export const TICK_MS = 50;
/** States sent a second (together.ts SEND_HZ). */
const SEND_HZ = 20;
/** The build every player says it is: the room takes one build. */
const BUILD = 'node';

/** A player: its world, its clock's error and line, its frames, and what the test does with it. */
export interface PlayerSpec {
  name: string;
  /** Its own world (cloneMap of the one generated), and the plan it was generated from. */
  map: BrickMap;
  plan: WorldPlan;
  /** The session's seed and the battle's (main.ts SEED: the map's). */
  seed: number;
  /** How far its reckoning of the room's clock is off the room's (ms): it reckons the room's time as the true time plus this. */
  offsetMs: number;
  /** Its line's delay each way (ms). */
  lineMs: number;
  /** Its frames' length (s). */
  frameS: number;
  /** Where its craters are cut: in-process (in step with the ticks) unless given. */
  runner?: DetonationRunner;
  /** What it carries into the match (main.ts deploy equips it); the session's own default if none. */
  loadout?: Loadout;
  /** Where it stands at its deploy; its team's `index`-th start (main.ts startOf), facing out of its bay, if not given. */
  place?(player: NodeClient, team: Team, index: number): void;
  /** Each frame, before its session runs: the test's hands on it, at the match's second on its clock (null out of a match). */
  act?(player: NodeClient, matchS: number | null): void;
  /** Its tab hidden from the first of these match seconds (its clock) to the second: no frame runs between. */
  hidden?: [number, number];
}

/** A shot another player fired, as the room's frame relayed it: their seat, the shot, and the room's clock of the frame. */
interface Heard {
  seat: number;
  shot: ShotState;
  at: number;
}

type Edit = { t: 'shell'; shell: RoomShell } | { t: 'dig'; dig: Dig };

/** The room, its clock, and the lines to it. */
export class RoomNet {
  readonly room = new RoomCore('NODES');
  /** The room's true clock (ms). */
  now = 0;
  readonly players: NodeClient[] = [];
  /** The room ticks until then (ms; never again once stopped). */
  private ticksUntil = Number.POSITIVE_INFINITY;
  private nextTick = 0;
  /** Messages on their way to the room, by when they arrive, and the order they were sent in. */
  private toRoom: { at: number; seq: number; conn: Conn; text: string }[] = [];
  private seq = 0;

  /** A player connects now: the room opens its socket and hears its hello its line's delay later. */
  connect(spec: PlayerSpec): NodeClient {
    const player = new NodeClient(this, spec, this.now);
    this.players.push(player);
    this.toRoom.push({ at: this.arrival(spec.lineMs), seq: this.seq++, conn: player.conn, text: '' });
    player.say({ t: 'hello', v: PROTOCOL, build: BUILD, name: spec.name });
    return player;
  }

  /** The room ticks no more after `ms` (its true clock). */
  stopTicking(ms = this.now): void {
    this.ticksUntil = ms;
  }

  /** `text` from `player`'s page, sent now: the room hears it its line's delay later. */
  send(player: NodeClient, text: string): void {
    this.toRoom.push({ at: this.arrival(player.spec.lineMs), seq: this.seq++, conn: player.conn, text });
  }

  /**
   * When what is sent now down a line of `lineMs` reaches the room: the whole millisecond it is heard
   * in, as the relay's clock is Date.now(). (A fractional clock would stamp a scoop at a time no wire
   * scoop carries: protocol.ts decodeDig refuses it.)
   */
  private arrival(lineMs: number): number {
    return Math.ceil(this.now + lineMs);
  }

  /**
   * Everything up to the room's true time `ms`, in time order: what reaches the room, its ticks, and
   * every player's frames (a welcome's catch-up awaited within its frame, the clock held).
   */
  async runTo(ms: number): Promise<void> {
    for (;;) {
      const msg = this.toRoom.reduce<(typeof this.toRoom)[number] | null>((a, m) => (!a || m.at < a.at || (m.at === a.at && m.seq < a.seq) ? m : a), null);
      const tick = this.nextTick <= this.ticksUntil ? this.nextTick : Number.POSITIVE_INFINITY;
      const frame = this.players.reduce((a, p) => Math.min(a, p.nextFrameAt), Number.POSITIVE_INFINITY);
      const t = Math.min(msg?.at ?? Number.POSITIVE_INFINITY, tick, frame);
      if (t > ms || t === Number.POSITIVE_INFINITY) break;
      this.now = t;
      if (msg && msg.at === t) {
        this.toRoom.splice(this.toRoom.indexOf(msg), 1);
        // The socket opening is an empty message: the relay's accept.
        if (msg.text === '') this.room.open(msg.conn, t);
        else this.room.message(msg.conn, msg.text, t);
        continue;
      }
      if (tick === t) {
        this.room.tick(t);
        this.nextTick += TICK_MS;
        continue;
      }
      for (const p of this.players) if (p.nextFrameAt === t) await p.frame(t);
    }
    this.now = Math.max(this.now, ms);
  }

  /**
   * Frames on (the room still, or ticking if it ticks) until every player's world is settled: no crater
   * pending, no scoop held, no shell in the air and no char waiting; at most `maxMs` more. Whether it settled.
   */
  async settle(maxMs = 60_000): Promise<boolean> {
    const until = this.now + maxMs;
    while (this.now < until) {
      if (this.players.every((p) => p.settled)) return true;
      await this.runTo(this.now + 100);
    }
    return this.players.every((p) => p.settled);
  }
}

/** A player's page: its line, its session and battle, and what it has done (for the tests). */
export class NodeClient {
  readonly session: Session;
  /** The room's battle on this page: the welcome's catch-up's, then each match's (Together.battle). */
  battle: RoomBattle | null = null;
  /** main.ts's battle: made at the deploy, on the match's clock. */
  director: Director | null = null;
  readonly clock = new BattleClock(tun.i('room_battle.catch_up_chunks'));
  readonly chars = new CharQueue(fireT.charM, tun.f('world.voxel_size'));
  readonly conn: Conn;
  you = -1;
  seats: Seat[] = [];
  match: MatchInfo | null = null;
  phase: 'lobby' | 'playing' = 'lobby';
  /** Welcomed, and the welcome's log caught up. */
  welcomed = false;
  caughtUp = false;
  /** The scoops this player sent, the others' the room relayed to it, and those given to its battle's `dug`. */
  digsSent = 0;
  digsHeard = 0;
  digsGiven = 0;
  /** Shots it fired that went out in its states, and others' it fired from the room's frames: all of them, those flown silent, and those seen (a `remoteShots` event). */
  shotsSent = 0;
  shotsFired = 0;
  shotsSilent = 0;
  shotsSeen = 0;
  /** The stamps (the room's clock) of the others' scoops the room relayed to it, in the order they came. */
  digStamps: number[] = [];
  /** Its tab's hidden window as it went (the room's true clock, ms): when it hid and came back; null until it did. */
  hid: { from: number; to: number } | null = null;
  /** The catch-up of its welcome: how long it took (wall clock, ms), and how many of the log's entries it took in. */
  catchUp: { ms: number; entries: number } | null = null;
  /** The match second of the last strike given its battle (−∞ none yet), the strikes given it, and the chars its fires asked for. */
  lastStrikeS = Number.NEGATIVE_INFINITY;
  strikes = 0;
  charsAsked = 0;
  /** Frames run, and when the next is due (the room's true clock). */
  frames = 0;
  nextFrameAt: number;
  private startedAt: number;
  private inbox: { at: number; text: string }[] = [];
  private edits: Edit[] = [];
  private shots: Heard[] = [];
  private shotsOut: number[][] = [];
  private sentAt = Number.NEGATIVE_INFINITY;
  /** The scoops the last match's battle still held at its end, for the next match's (Together.carried). */
  private carried: Dig[] = [];

  constructor(
    private readonly net: RoomNet,
    readonly spec: PlayerSpec,
    now: number,
  ) {
    const start = pickSpawns(spec.map, spec.plan, 'front', 1)[0];
    this.session = Session.create({ map: spec.map, plan: spec.plan, spawn: start, ...(spec.runner ? { runner: spec.runner } : {}) }, tun, spec.seed, facingYaw(start.bay));
    this.startedAt = now;
    this.nextFrameAt = now;
    this.conn = {
      send: (text) => this.inbox.push({ at: net.now + spec.lineMs, text }),
      close: () => {},
    };
  }

  get map(): BrickMap {
    return this.session.map;
  }

  /** The room's clock as this player reckons it at the room's true time `t`. */
  serverAt(t: number): number {
    return t + this.spec.offsetMs;
  }

  /** In the room's match (starting, or on). */
  get inMatch(): boolean {
    return this.phase === 'playing' && this.match !== null;
  }

  /** The match's seconds on this player's clock at the room's true time `t`; null out of a match. */
  matchS(t: number): number | null {
    return this.inMatch ? matchSeconds(this.serverAt(t), this.match!.startAt) : null;
  }

  /** Nothing of the room's left to do on its world: no crater pending, no scoop held, no shell in the air, no char waiting. */
  get settled(): boolean {
    const b = this.battle;
    return this.session.destruction.pending === 0 && this.chars.pending === 0 && (!b || (b.held.length === 0 && b.waiting.length === 0));
  }

  /** A message to the room, over the line. */
  say(msg: ClientMsg): void {
    this.net.send(this, JSON.stringify(msg));
  }

  /** One frame at the room's true time `t`. */
  async frame(t: number): Promise<void> {
    if (this.hid && this.hid.to === t) this.say({ t: 'away', away: false });
    this.frames++;
    this.nextFrameAt = this.startedAt + this.frames * this.spec.frameS * 1000;
    const arrived = this.inbox.filter((m) => m.at <= t);
    this.inbox = this.inbox.filter((m) => m.at > t);
    for (const m of arrived) await this.receive(m.text, t);
    const s = this.session;
    const nowMs = this.serverAt(t);
    const inMatch = this.inMatch;
    // Together.prepare: the session set as the room is, every frame.
    s.room = inMatch;
    s.seat = inMatch ? this.you : -1;
    if (inMatch && this.caughtUp) {
      const battle = this.matchBattle(nowMs);
      for (const e of this.edits.splice(0)) {
        if (e.t === 'shell') battle.hear(e.shell, nowMs);
        else {
          this.digsGiven++;
          battle.dug(e.dig, nowMs);
        }
      }
      battle.tick(nowMs);
      let room = s.roundRoom();
      let n = 0;
      while (n < this.shots.length) {
        const rounds = s.shotRounds(this.shots[n].shot.mark);
        if (rounds > room) break;
        room -= rounds;
        n++;
      }
      for (const { seat, shot, at } of this.shots.splice(0, n)) {
        const team = this.seats.find((x) => x.id === seat)?.team;
        const silent = nowMs - at > 1000 * SILENT_STEP_S;
        s.fireRemote(2 + seat, shot.origin, shot.dir, shot.tracer, shot.origin, shot.mark, team ? teamTracer(team) : undefined, shot.tick, silent);
        this.shotsFired++;
        if (silent) this.shotsSilent++;
      }
    }
    const matchS = this.matchS(t);
    this.spec.act?.(this, matchS);
    const begun = matchS !== null && nowMs >= this.match!.startAt;
    // main.ts: the session runs once the match is on (the deploy screen too), never while catching up.
    if (this.caughtUp && begun) s.advance(this.spec.frameS);
    // Together.frame: the player's state, twenty times a second, in play.
    if (this.caughtUp && begun && t - this.sentAt >= 1000 / SEND_HZ) {
      this.sentAt = t;
      const sh = this.shotsOut.splice(0, SHOTS_MAX);
      this.shotsSent += sh.length;
      this.say({ t: 's', s: encodeState(stateOf(s)), ...(sh.length ? { sh } : {}) });
    }
    const events = s.drainEvents();
    this.shotsSeen += events.remoteShots.length;
    this.after(events, begun);
    this.light(events, matchS);
    // Hidden from here (its last frame before) until the window's end: no frame runs, and its messages queue.
    const hidden = this.spec.hidden;
    if (hidden && !this.hid && matchS !== null && matchS >= hidden[0]) {
      const to = Math.ceil(t + (hidden[1] - matchS) * 1000);
      this.hid = { from: t, to };
      this.say({ t: 'away', away: true });
      this.startedAt += to - this.nextFrameAt;
      this.nextFrameAt = to;
    }
  }

  /** Together.after: the player's shots kept to send, and the battle's hurts and its scoops told the room. */
  private after(events: CombatEvents, begun: boolean): void {
    if (!this.inMatch) return;
    for (const shot of events.shots) if (shot.wire && this.shotsOut.length < 2 * SHOTS_MAX) this.shotsOut.push(shot.wire);
    if (!this.battle) return;
    for (const m of this.battle.outgoing(events, this.caughtUp && begun && this.session.alive)) {
      if (m.t === 'hurt') this.say(m);
      else if (m.t === 'dig') {
        this.digsSent++;
        this.say(m);
      }
    }
  }

  /** main.ts's light(): the frame's strikes to the battle, run on to the match's second on the match's clock, its chars made. */
  private light(events: CombatEvents, matchS: number | null): void {
    const director = this.director;
    if (!director || matchS === null || !this.caughtUp) return;
    const strikes = this.battle?.strikes(events, this.match!.startAt) ?? [];
    for (const k of strikes) this.lastStrikeS = Math.max(this.lastStrikeS, k.atS ?? 0);
    this.strikes += strikes.length;
    const ran = this.clock.frame(director, matchS, () => this.inputs(), strikes, []);
    this.charsAsked += ran.chars.length;
    for (const c of ran.chars) this.chars.add(c.at);
    this.charsMake();
  }

  /** The battle's inputs at any second of the match: the room's tempo, by day (darkness 0), at the player's feet. */
  private inputs(): BattleInputs {
    return { intensity: this.match?.config.intensity ?? 'off', darkness: 0, player: this.session.player.position.toArray() };
  }

  /** The chars waiting made where no crater is pending about them, as in a match. */
  private charsMake(): void {
    this.chars.make(this.session.map, (box) => this.session.destruction.overlapsPending(box));
  }

  /** The match's battle (Together.matchBattle): made if there is none, given the scoops the last one held first. */
  private matchBattle(nowMs: number): RoomBattle {
    if (this.battle) return this.battle;
    const battle = (this.battle = new RoomBattle(this.session, fireT));
    for (const d of this.carried.splice(0)) battle.dug(d, nowMs);
    return battle;
  }

  /** A message from the room, as NetClient handles it and Together answers it. */
  private async receive(text: string, t: number): Promise<void> {
    const m = parseRoom(text);
    if (!m) return;
    switch (m.t) {
      case 'welcome': {
        this.welcomed = true;
        this.you = m.you;
        this.seats = m.seats;
        this.phase = m.phase;
        this.match = m.match;
        if (m.phase === 'playing' && m.match) this.deploy();
        await this.catchUpOn(m.log, t);
        return;
      }
      case 'roster':
        this.seats = m.seats;
        return;
      case 'start':
        this.phase = 'playing';
        this.match = m.match;
        this.shots = [];
        this.deploy();
        return;
      case 'end':
        this.ended();
        return;
      case 'f':
        for (const p of m.sh) {
          const shot = decodeShot(p.slice(1));
          if (shot && p[0] !== this.you) this.shots.push({ seat: p[0], shot, at: m.s });
        }
        return;
      case 'shell': {
        const shell = decodeShell(m.s);
        if (shell) this.edits.push({ t: 'shell', shell });
        return;
      }
      case 'dig': {
        const dig = decodeDig(m.d);
        if (!dig) return;
        this.digsHeard++;
        this.digStamps.push(dig.at);
        this.edits.push({ t: 'dig', dig });
        return;
      }
      default:
        return;
    }
  }

  /**
   * The match over (NetClient's endMatch, Together.ended): the shells and scoops told before the end
   * given its battle as the match is over (after every time), every shell still in the air landed at
   * once, quietly (RoomBattle.finish), and the scoops it still held carried to the next match's battle.
   */
  private ended(): void {
    this.phase = 'lobby';
    this.match = null;
    this.director = null;
    const battle = this.matchBattle(Number.POSITIVE_INFINITY);
    this.battle = null;
    for (const e of this.edits.splice(0)) {
      if (e.t === 'shell') battle.hear(e.shell, Number.POSITIVE_INFINITY);
      else {
        this.digsGiven++;
        battle.dug(e.dig, Number.POSITIVE_INFINITY);
      }
    }
    this.carried = battle.finish();
  }

  /** main.ts's deploy (Together.started): at the team's start, carrying the loadout; the match's battle from its start, on its clock. */
  private deploy(): void {
    const s = this.session;
    const team = this.seats.find((x) => x.id === this.you)?.team ?? 'red';
    const index = Math.max(0, this.seats.filter((x) => x.team === team).findIndex((x) => x.id === this.you));
    this.battle = null;
    s.team = team;
    if (this.spec.loadout) s.equip(this.spec.loadout);
    if (this.spec.place) this.spec.place(this, team, index);
    else {
      const starts = pickSpawns(s.map, this.spec.plan, team === 'red' ? 'front' : 'enemy_front', 4);
      const at = starts[index % starts.length];
      s.respawn(at.position, facingYaw(at.bay));
    }
    this.director = new Director(this.spec.plan, tun, this.spec.seed);
    this.clock.reset();
    s.frontFrom(team === 'red' ? 1 : 0);
    s.front.intensity = 'off';
    s.artillery.intensity = 'off';
  }

  /**
   * Together.welcomed and main.ts's catchUp hook: the welcome's log caught up on a battle made now, the
   * room's time held while it runs (`t`); in a match, the deploy's battle run along it (catchUpRunner),
   * its strikes given it first, its chars made at once; then the battle's clock given the second it reached.
   */
  private async catchUpOn(log: { shells: number[][]; digs: number[][] }, t: number): Promise<void> {
    this.caughtUp = false;
    const battle = (this.battle ??= new RoomBattle(this.session, fireT));
    const match = this.inMatch ? this.match : null;
    const director = this.director;
    const made = (events: BattleEvents) => {
      this.charsAsked += events.chars.length;
      for (const c of events.chars) this.chars.add(c.at);
      this.charsMake();
    };
    const along = match && director ? catchUpRunner(director, () => this.inputs(), made) : null;
    let entries = 0;
    const t0 = performance.now();
    await battle.catchUp(log, match?.startAt ?? null, () => this.serverAt(t), along, async () => {}, { progress: (_done, total) => (entries = total) });
    this.catchUp = { ms: performance.now() - t0, entries };
    if (along && this.director === director) this.clock.given = along.reached;
    this.caughtUp = true;
  }
}
