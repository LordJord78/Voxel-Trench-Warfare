/**
 * A room: up to eight players, their seats and teams, the owner's settings, and the match.
 *
 * It is the whole of the room's logic, behind a socket interface (`Conn`) and a clock it is given,
 * so the Durable Object (server/) is only its transport, and the tests drive it with fake sockets.
 *
 * Who joins:
 * - the first hello fixes the room's build, and a player of another build is refused, as their
 *   world and rules would not be the same;
 * - a ninth player is refused;
 * - a seat is the lowest free one, and a team the one with fewer players (red on a tie).
 *
 * The owner:
 * - is the earliest of those seated, and passes to the next when they leave;
 * - alone changes the settings, and starts and ends the match.
 *
 * In a match, `tick` (every 50 ms) sends every player one frame: each seated player's latest
 * state, the shots fired since the last, and the room's clock. A player not heard from for AWAY_MS
 * is away (so are those who say so): not drawn, and later not targeted. The match's rules
 * (match-rules.ts) take the shooters' claims of hits and the battle's hurts, and say who died, who
 * is back, and the score; the match won, the room goes back to its lobby OVER_MS later.
 */

import { MatchRules, type MatchEvent } from './match-rules';
import { cleanName, defaultConfig, MAX_PLAYERS, parseClient, PROTOCOL, type ClientMsg, type MatchInfo, type Phase, type RoomConfig, type RoomMsg, type Seat, type Team, type WireState } from './protocol';

export interface Conn {
  send(text: string): void;
  close(code: number, reason: string): void;
}

/** Milliseconds from the start being called to the match's first tick: the countdown. */
export const COUNTDOWN_MS = 3000;
/** A player unheard this long in a match is away. */
export const AWAY_MS = 3000;
/** A match won: the room goes back to its lobby this long after. */
export const OVER_MS = 8000;
/** A socket that has not said hello this long after opening is closed. */
const HELLO_MS = 10_000;
/** Messages a second a player may send, and how many may come at once. */
const RATE = 60;
const BURST = 120;

/** Each map's world seed: every player generates the same world from it. */
export const MAP_SEEDS: Record<string, number> = { ravine: 7, corridor: 11 };

interface Member {
  conn: Conn;
  seat: Seat | null;
  openedAt: number;
  joinedAt: number;
  heardAt: number;
  saysAway: boolean;
  state: WireState | null;
  /** Shots heard since the last frame. */
  shots: number[][];
  tokens: number;
  tokensAt: number;
}

export class RoomCore {
  readonly code: string;
  config: RoomConfig = defaultConfig();
  phase: Phase = 'lobby';
  match: MatchInfo | null = null;
  /** The match's rules while one is on. */
  rules: MatchRules | null = null;
  /** When a won match goes back to the lobby. */
  private overAt: number | null = null;
  private build: string | null = null;
  private readonly members = new Map<Conn, Member>();
  private ownerId = -1;
  /** The clock as last given. */
  private lastNow = 0;

  constructor(code: string) {
    this.code = code;
  }

  get owner(): number {
    return this.ownerId;
  }

  /** The seats taken, by id. */
  seats(): Seat[] {
    return [...this.members.values()].flatMap((m) => (m.seat ? [{ ...m.seat }] : [])).sort((a, b) => a.id - b.id);
  }

  /** No one connected at all. */
  get empty(): boolean {
    return this.members.size === 0;
  }

  open(conn: Conn, now: number): void {
    this.members.set(conn, { conn, seat: null, openedAt: now, joinedAt: now, heardAt: now, saysAway: false, state: null, shots: [], tokens: BURST, tokensAt: now });
  }

  close(conn: Conn): void {
    const m = this.members.get(conn);
    if (!m) return;
    this.members.delete(conn);
    if (!m.seat) return;
    this.rules?.leave(m.seat.id);
    if (this.seated().length === 0) {
      // The last one out: the room goes back to its lobby, its build free for the next to fix.
      this.phase = 'lobby';
      this.match = null;
      this.rules = null;
      this.overAt = null;
      this.build = null;
      this.ownerId = -1;
      return;
    }
    this.chooseOwner();
    this.broadcastRoster();
  }

  message(conn: Conn, raw: unknown, now: number): void {
    const m = this.members.get(conn);
    if (!m) return;
    this.lastNow = now;
    // A token bucket: a client gone wrong (or a hostile one) is cut off, not served.
    m.tokens = Math.min(BURST, m.tokens + ((now - m.tokensAt) / 1000) * RATE);
    m.tokensAt = now;
    if (m.tokens < 1) {
      if (m.tokens < -BURST) conn.close(1008, 'too many messages');
      m.tokens -= 1;
      return;
    }
    m.tokens -= 1;
    const msg = parseClient(raw);
    if (!msg) return;
    m.heardAt = now;
    if (!m.seat) {
      if (msg.t === 'hello') this.hello(m, msg, now);
      return;
    }
    this.handle(m, msg, now);
  }

  /** Every 50 ms or so: hellos overdue, players gone quiet, and in a match each player's frame. */
  tick(now: number): void {
    this.lastNow = now;
    for (const m of this.members.values()) {
      if (!m.seat && now - m.openedAt > HELLO_MS) m.conn.close(1008, 'no hello');
    }
    if (this.phase !== 'playing') return;
    if (this.overAt !== null && now >= this.overAt) {
      this.toLobby();
      return;
    }
    if (this.rules) this.apply(this.rules.tick(now));
    let changed = false;
    for (const m of this.seated()) {
      const away = m.saysAway || now - m.heardAt > AWAY_MS;
      if (away !== m.seat!.away) {
        m.seat!.away = away;
        changed = true;
      }
    }
    if (changed) this.broadcastRoster();
    const ps = this.seated().flatMap((m) => (m.state && !m.seat!.away ? [[m.seat!.id, ...m.state]] : []));
    const sh = this.seated().flatMap((m) => m.shots.map((s) => [m.seat!.id, ...s]));
    for (const m of this.seated()) m.shots.length = 0;
    if (ps.length > 0 || sh.length > 0) this.broadcast({ t: 'f', s: now, ps, sh });
  }

  private seated(): Member[] {
    return [...this.members.values()].filter((m) => m.seat !== null);
  }

  private hello(m: Member, msg: Extract<ClientMsg, { t: 'hello' }>, now: number): void {
    if (msg.v !== PROTOCOL || (this.build !== null && msg.build !== this.build)) return this.refuse(m, 'version');
    const taken = new Set(this.seated().map((s) => s.seat!.id));
    if (taken.size >= MAX_PLAYERS) return this.refuse(m, 'full');
    this.build ??= msg.build;
    let id = 0;
    while (taken.has(id)) id++;
    const count = (team: Team) => this.seated().filter((s) => s.seat!.team === team).length;
    const team: Team = count('blue') < count('red') ? 'blue' : 'red';
    m.seat = { id, name: cleanName(msg.name), team, ready: false, away: false };
    m.joinedAt = now;
    this.chooseOwner();
    this.send(m, { t: 'welcome', you: id, room: this.code, owner: this.ownerId, seats: this.seats(), config: { ...this.config }, phase: this.phase, match: this.match, now });
    this.broadcastRoster(m);
    // Late to a match: in it, and told the score.
    if (this.rules) {
      this.rules.join(id, team, Math.max(now, this.match!.startAt));
      this.send(m, this.scoreMsg());
    }
  }

  private refuse(m: Member, reason: 'version' | 'full'): void {
    this.send(m, { t: 'refused', reason });
    m.conn.close(1008, reason);
    this.members.delete(m.conn);
  }

  private handle(m: Member, msg: ClientMsg, now: number): void {
    const seat = m.seat!;
    const owner = seat.id === this.ownerId;
    switch (msg.t) {
      case 'ping':
        this.send(m, { t: 'pong', c: msg.c, s: now });
        return;
      case 's':
        if (this.phase === 'playing') {
          m.state = msg.s;
          // Shots past what a twentieth of a second of full auto fires are dropped.
          for (const s of msg.sh ?? []) if (m.shots.length < 6) m.shots.push(s);
        }
        if (m.seat!.away && !m.saysAway) {
          m.seat!.away = false;
          this.broadcastRoster();
        }
        return;
      case 'away':
        m.saysAway = msg.away;
        if (seat.away !== msg.away) {
          seat.away = msg.away;
          this.broadcastRoster();
        }
        return;
      case 'name':
        seat.name = msg.name;
        this.broadcastRoster();
        return;
      case 'hit':
        if (this.rules && this.match && now >= this.match.startAt) this.apply(this.rules.hit(seat.id, msg.v, msg.z, now));
        return;
      case 'hurt':
        if (this.rules && this.match && now >= this.match.startAt) this.apply(this.rules.hurt(seat.id, msg.a, msg.c, now));
        return;
      case 'team':
        // Sides are chosen in the lobby: a match's teams are its own.
        if (seat.team === msg.team || this.phase !== 'lobby') return;
        seat.team = msg.team;
        seat.ready = false;
        this.broadcastRoster();
        return;
      case 'ready':
        seat.ready = msg.ready;
        this.broadcastRoster();
        return;
      case 'config':
        if (!owner || this.phase !== 'lobby') return;
        this.config = { ...this.config, ...msg.config };
        this.broadcast({ t: 'config', config: { ...this.config } });
        return;
      case 'start':
        if (!owner || this.phase !== 'lobby') return;
        this.phase = 'playing';
        this.match = { startAt: now + COUNTDOWN_MS, seed: MAP_SEEDS[this.config.map] ?? MAP_SEEDS.ravine, config: { ...this.config } };
        this.rules = new MatchRules(this.config.killTarget, this.config.respawnS * 1000);
        this.overAt = null;
        for (const s of this.seated()) {
          s.state = null;
          s.shots.length = 0;
          s.heardAt = now;
          this.rules.join(s.seat!.id, s.seat!.team, this.match.startAt);
        }
        this.broadcast({ t: 'start', match: this.match });
        return;
      case 'end':
        if (!owner || this.phase !== 'playing') return;
        this.toLobby();
        return;
      case 'hello':
        return;
    }
  }

  /** The match over: everyone back in the lobby, unready. */
  private toLobby(): void {
    this.phase = 'lobby';
    this.match = null;
    this.rules = null;
    this.overAt = null;
    for (const s of this.seated()) {
      s.state = null;
      s.shots.length = 0;
      s.seat!.ready = false;
      s.seat!.away = false;
      s.saysAway = false;
    }
    this.broadcast({ t: 'end' });
    this.broadcastRoster();
  }

  /** What the rules said happened, told: a hurt to the hurt alone, the rest to everyone. */
  private apply(events: MatchEvent[]): void {
    for (const e of events) {
      switch (e.t) {
        case 'hurt': {
          const victim = this.seated().find((m) => m.seat!.id === e.victim);
          if (victim) this.send(victim, { t: 'hurt', hp: e.hp, from: e.from });
          break;
        }
        case 'death':
          this.broadcast({ t: 'death', v: e.victim, k: e.killer, z: e.zone, tk: e.teamkill, c: e.cause });
          break;
        case 'respawn':
          this.broadcast({ t: 'respawn', id: e.id, spawn: e.spawn });
          break;
        case 'score':
          this.broadcast(this.scoreMsg());
          break;
        case 'over':
          this.broadcast({ t: 'over', winner: e.winner, red: this.rules!.score.red, blue: this.rules!.score.blue });
          this.overAt = this.lastNow + OVER_MS;
          break;
      }
    }
  }

  private scoreMsg(): RoomMsg {
    const r = this.rules!;
    return { t: 'score', red: r.score.red, blue: r.score.blue, ps: [...r.fighters.values()].map((f) => [f.id, f.kills, f.deaths]) };
  }

  private chooseOwner(): void {
    const seated = this.seated();
    if (seated.some((m) => m.seat!.id === this.ownerId)) return;
    const first = seated.reduce<Member | null>((a, b) => (!a || b.joinedAt < a.joinedAt || (b.joinedAt === a.joinedAt && b.seat!.id < a.seat!.id) ? b : a), null);
    this.ownerId = first ? first.seat!.id : -1;
  }

  private send(m: Member, msg: RoomMsg): void {
    try {
      m.conn.send(JSON.stringify(msg));
    } catch {
      // A socket closing under us: its close will come.
    }
  }

  private broadcast(msg: RoomMsg, except?: Member): void {
    const text = JSON.stringify(msg);
    for (const m of this.seated()) {
      if (m === except) continue;
      try {
        m.conn.send(text);
      } catch {
        // As above.
      }
    }
  }

  private broadcastRoster(except?: Member): void {
    this.broadcast({ t: 'roster', owner: this.ownerId, seats: this.seats() }, except);
  }
}
