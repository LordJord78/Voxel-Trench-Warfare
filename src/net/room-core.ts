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
 * state and the room's clock. A player not heard from for AWAY_MS is away (so are those who say
 * so): not drawn, and later not targeted.
 */

import { cleanName, defaultConfig, MAX_PLAYERS, parseClient, PROTOCOL, type ClientMsg, type MatchInfo, type Phase, type RoomConfig, type RoomMsg, type Seat, type Team, type WireState } from './protocol';

export interface Conn {
  send(text: string): void;
  close(code: number, reason: string): void;
}

/** Milliseconds from the start being called to the match's first tick: the countdown. */
export const COUNTDOWN_MS = 3000;
/** A player unheard this long in a match is away. */
export const AWAY_MS = 3000;
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
  tokens: number;
  tokensAt: number;
}

export class RoomCore {
  readonly code: string;
  config: RoomConfig = defaultConfig();
  phase: Phase = 'lobby';
  match: MatchInfo | null = null;
  private build: string | null = null;
  private readonly members = new Map<Conn, Member>();
  private ownerId = -1;

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
    this.members.set(conn, { conn, seat: null, openedAt: now, joinedAt: now, heardAt: now, saysAway: false, state: null, tokens: BURST, tokensAt: now });
  }

  close(conn: Conn): void {
    const m = this.members.get(conn);
    if (!m) return;
    this.members.delete(conn);
    if (!m.seat) return;
    if (this.seated().length === 0) {
      // The last one out: the room goes back to its lobby, its build free for the next to fix.
      this.phase = 'lobby';
      this.match = null;
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
    for (const m of this.members.values()) {
      if (!m.seat && now - m.openedAt > HELLO_MS) m.conn.close(1008, 'no hello');
    }
    if (this.phase !== 'playing') return;
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
    if (ps.length > 0) this.broadcast({ t: 'f', s: now, ps });
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
        if (this.phase === 'playing') m.state = msg.s;
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
      case 'team':
        if (seat.team === msg.team) return;
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
        for (const s of this.seated()) {
          s.state = null;
          s.heardAt = now;
        }
        this.broadcast({ t: 'start', match: this.match });
        return;
      case 'end':
        if (!owner || this.phase !== 'playing') return;
        this.phase = 'lobby';
        this.match = null;
        for (const s of this.seated()) {
          s.state = null;
          s.seat!.ready = false;
          s.seat!.away = false;
          s.saysAway = false;
        }
        this.broadcast({ t: 'end' });
        this.broadcastRoster();
        return;
      case 'hello':
        return;
    }
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
