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
 *
 * The room ticks only while a match is on (`ticking`: its countdown and its won seconds too). Out of
 * one it has only deadlines, and `wakeAt` says the next, for the relay to tick it then and no sooner
 * (server/src/pacer.ts). In every phase, a tick:
 * - closes a socket that has not said hello in HELLO_MS;
 * - lets go of a seat that has sent nothing, not even a ping, for SEAT_SILENT_MS (a line gone dead
 *   without a close: a laptop's lid, a Wi-Fi drop), its seat and the host role passing on;
 * - closes every socket, told it was idle, once nobody has played in the room for ROOM_IDLE_MS
 *   (protocol.ts: anything but a ping, a state unchanged but for its tick, or the battle's hurt).
 *
 * A seat that leaves is remembered for REJOIN_MS by its page's rejoin token (protocol.ts isToken,
 * kept by the tab per room code): a hello with it gets its place back, its seat if free, its team,
 * its kills and deaths if the match is the same, and the host role if it held it and nobody has been
 * made host by an action since (the role passes on at once, and comes back). So a reload mid-match,
 * or the map change that reloads every page, leaves everyone where they were. A hello with the token
 * of a line still seated (the same tab back before its old line's close came) takes that seat, and
 * the old line is let go. Without a token, or with one the room does not know, a newcomer.
 *
 * The battle (the shared-battle spec): the room runs the match's shelling (shelling.ts) over its
 * map's pinned field, telling everyone each shell SHELLING.leadS before it lands, and relays each
 * player's scoops to the others, stamped with its clock. It keeps both in its log, which every
 * welcome carries, so a player joining or reloading builds the same world. The log is the world's,
 * not the match's: a rematch on the same map starts on the cratered ground, so it lives until the
 * map changes or the last player leaves, and the shells are numbered on across matches. Past
 * LOG_CHARS_MAX its oldest scoops leave it, never a shell.
 *
 * A scoop is the world's for the same reason: from the start of the first match on it until the map
 * changes, a player's scoop is stamped, logged and relayed in any phase. One sent just before a match
 * ended reaches the room after it, and its digger has dug it: dropped, it would be in their world
 * alone, there for the rematch. Between matches each seat's are taken up to LOBBY_DIGS_MAX: every
 * page holds the lobby's scoops until the next match and digs them all in its first frames, so a
 * client gone wrong could otherwise stall them all. In every phase a seat's scoops are taken no faster
 * than DIG_RATE a second (DIG_BURST at once), a little over twice the shovel's fastest.
 */

import { MatchRules, type MatchEvent } from './match-rules';
import { cleanName, defaultConfig, encodeShell, MAX_PLAYERS, parseClient, PROTOCOL, ROOM_IDLE_MS, type ClientMsg, type Closing, type MatchInfo, type MatchLog, type Phase, type RoomConfig, type RoomMsg, type Seat, type Team, type WireDig, type WireShell, type WireState } from './protocol';
import { SHELL_FIELDS } from './shell-fields';
import { SHELLING, Shelling, shellingSeed } from './shelling';

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
export const HELLO_MS = 10_000;
/**
 * A seat that has sent nothing, not even a ping, for this long is let go, as if its line had closed.
 * A page pings twice a second; hidden, its timers are throttled, at their slowest (Chrome's intensive
 * throttling, from five minutes hidden) to one run a minute, so a hidden tab's pings may come a minute
 * apart: this is that and half as much again, and a hidden tab keeps its seat however long it hides.
 */
export const SEAT_SILENT_MS = 90_000;
/** A seat that left is remembered this long by its page's rejoin token (a reload of a world, a map change, a line dropped and rejoined). */
export const REJOIN_MS = 120_000;
/** The codes the room closes a line with, by why: the reason is the words' (protocol.ts Closing), or 'silent'. */
const CLOSE_CODE = { idle: 4000, replaced: 4001, silent: 4002 } as const;
/** Messages a second a player may send, and how many may come at once. */
const RATE = 60;
const BURST = 120;

/** Each map's world seed: every player generates the same world from it. */
export const MAP_SEEDS: Record<string, number> = { ravine: 7, corridor: 11 };
/** The log's most characters, counting each entry's JSON and a separator: a welcome stays under protocol.ts ROOM_TEXT_MAX. */
export const LOG_CHARS_MAX = 900_000;
/**
 * The most scoops the room takes from a seat between matches, the rest dropped (neither relayed nor
 * logged): only scoops in flight when the end reached their digger arrive between matches; a few
 * round trips of the fastest shovel ([entrenching] scoop_voxels: a scoop each 0.26 s). Counted by
 * seat until the next match starts or the room empties, so a client that reconnects (to its own
 * seat, the lowest free) does not start afresh.
 */
export const LOBBY_DIGS_MAX = 16;
/**
 * The scoops a second a seat may send, in any phase, and how many at once: the shovel's fastest is
 * about 3.9 a second. Past it a scoop is dropped (neither relayed nor logged) and the socket kept, so
 * one seat cannot push every honest scoop out of the log (LOG_CHARS_MAX) or make every page dig sixty
 * a second. The bucket is the seat's, as LOBBY_DIGS_MAX's count is: kept across a reconnect (to its
 * own seat), so dropping the line does not refill it, and forgotten when the room empties.
 */
export const DIG_RATE = 8;
export const DIG_BURST = 16;

/** The room's log of its world: the shells told and the scoops relayed, their characters, the next shell's id, and whether a match has begun on it (from then its scoops are taken). */
interface RoomLog extends MatchLog {
  chars: number;
  nextId: number;
  played: boolean;
}

function emptyLog(): RoomLog {
  return { shells: [], digs: [], chars: 0, nextId: 1, played: false };
}

interface Member {
  conn: Conn;
  seat: Seat | null;
  /** Its page's rejoin token, if its hello gave one. */
  token: string | null;
  openedAt: number;
  joinedAt: number;
  heardAt: number;
  saysAway: boolean;
  state: WireState | null;
  /** The last state it sent, in any phase: one the same but for its tick is not playing. */
  said: WireState | null;
  /** Shots heard since the last frame. */
  shots: number[][];
  tokens: number;
  tokensAt: number;
}

/** A seat that left, as its rejoin token gets it back: its id, team, the match it left (its start) and its tallies there, and when it left. */
interface Left {
  id: number;
  team: Team;
  startAt: number | null;
  kills: number;
  deaths: number;
  at: number;
}

export class RoomCore {
  readonly code: string;
  config: RoomConfig = defaultConfig();
  phase: Phase = 'lobby';
  match: MatchInfo | null = null;
  /** The match's rules while one is on. */
  rules: MatchRules | null = null;
  /** The match's shelling while one is on (none when off), and the match second it has been told through. */
  private shelling: Shelling | null = null;
  private toldS = 0;
  private log: RoomLog = emptyLog();
  /** Each seat's scoops taken since the last match ended (none counted in a match), by seat id. */
  private readonly lobbyDigs = new Map<number, number>();
  /** Each seat's scoops' bucket (DIG_RATE, DIG_BURST): its tokens, and when they were last filled; by seat id, full until it digs. */
  private readonly digBuckets = new Map<number, { tokens: number; at: number }>();
  /** When a won match goes back to the lobby. */
  private overAt: number | null = null;
  private build: string | null = null;
  private readonly members = new Map<Conn, Member>();
  private ownerId = -1;
  /** The clock as last given. */
  private lastNow = 0;
  /** When a seat last played (protocol.ts ROOM_IDLE_MS). */
  private actedAt = 0;
  /** The seats that left, by their pages' rejoin tokens, for REJOIN_MS; kept when the room empties (a map change reloads every page). */
  private readonly left = new Map<string, Left>();
  /**
   * The rejoin token the host role is kept for: the host's, until someone else is made host by an
   * action (a setting, a start or an end), or the host is gone for good (unseated and forgotten). A
   * hello with it is the host again.
   */
  private hostToken: string | null = null;

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

  /** The scoops seat `seat` has had taken since the last match ended (LOBBY_DIGS_MAX; for the tests). */
  lobbyDigsTaken(seat: number): number {
    return this.lobbyDigs.get(seat) ?? 0;
  }

  /** Whether the room has a match to tick every 50 ms: its countdown, its play, and its won seconds. */
  get ticking(): boolean {
    return this.phase === 'playing';
  }

  /**
   * The room's clock at which a tick next has something to do out of a match, or null with nobody
   * connected: a hello overdue, a seat silent too long, or the room idle. (In a match it ticks anyway.)
   */
  wakeAt(): number | null {
    let at = Number.POSITIVE_INFINITY;
    let seated = false;
    for (const m of this.members.values()) {
      if (m.seat) {
        seated = true;
        at = Math.min(at, m.heardAt + SEAT_SILENT_MS + 1);
      } else at = Math.min(at, m.openedAt + HELLO_MS + 1);
    }
    if (seated) at = Math.min(at, this.actedAt + ROOM_IDLE_MS);
    return at === Number.POSITIVE_INFINITY ? null : at;
  }

  open(conn: Conn, now: number): void {
    this.members.set(conn, { conn, seat: null, token: null, openedAt: now, joinedAt: now, heardAt: now, saysAway: false, state: null, said: null, shots: [], tokens: BURST, tokensAt: now });
  }

  /** `conn`'s line closed (at `now`, the clock as last given if not said): its seat leaves, remembered by its rejoin token. */
  close(conn: Conn, now = this.lastNow): void {
    const m = this.members.get(conn);
    if (!m) return;
    this.members.delete(conn);
    if (!m.seat) return;
    if (m.token) {
      const f = this.rules?.fighters.get(m.seat.id);
      this.left.set(m.token, { id: m.seat.id, team: m.seat.team, startAt: this.match?.startAt ?? null, kills: f?.kills ?? 0, deaths: f?.deaths ?? 0, at: now });
    }
    this.rules?.leave(m.seat.id);
    if (this.seated().length === 0) {
      // The last one out: the room goes back to its lobby, its build free for the next to fix. The
      // seats that left are remembered still, and the host's claim (a map change reloads every page).
      this.phase = 'lobby';
      this.match = null;
      this.rules = null;
      this.shelling = null;
      this.log = emptyLog();
      this.lobbyDigs.clear();
      this.digBuckets.clear();
      this.overAt = null;
      this.build = null;
      this.ownerId = -1;
      return;
    }
    this.chooseOwner();
    this.claimHost();
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
    if (this.plays(m, msg)) this.actedAt = now;
    this.handle(m, msg, now);
  }

  /**
   * In a match every 50 ms, and out of one at `wakeAt`: hellos overdue, seats silent too long, the
   * room idle; and in a match, players gone quiet and each player's frame.
   */
  tick(now: number): void {
    this.lastNow = now;
    this.forget(now);
    for (const m of [...this.members.values()]) {
      if (!m.seat) {
        if (now - m.openedAt > HELLO_MS) {
          this.members.delete(m.conn);
          m.conn.close(1008, 'no hello');
        }
      } else if (now - m.heardAt > SEAT_SILENT_MS) this.drop(m, 'silent', now);
    }
    const seated = this.seated();
    if (seated.length > 0 && now - this.actedAt >= ROOM_IDLE_MS) {
      for (const m of seated) this.drop(m, 'idle', now);
      return;
    }
    if (this.phase !== 'playing') return;
    if (this.overAt !== null && now >= this.overAt) {
      this.toLobby();
      return;
    }
    if (this.rules) this.apply(this.rules.tick(now));
    if (this.overAt === null) this.tellShells(now);
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
    const token = msg.token ?? null;
    this.forget(now);
    // The same page on a new line while its old one still holds its seat (a reload before the old
    // line's close came, or a line gone dead): the old line is let go, and its place is the new one's.
    const stale = token ? this.seated().find((s) => s.token === token) : undefined;
    if (stale) this.drop(stale, 'replaced', now);
    const taken = new Set(this.seated().map((s) => s.seat!.id));
    if (taken.size >= MAX_PLAYERS) return this.refuse(m, 'full');
    this.build ??= msg.build;
    // A seat that left, back: its own seat if still free, and its team; else a newcomer's.
    const back = token ? this.left.get(token) : undefined;
    if (token) this.left.delete(token);
    let id = 0;
    if (back && !taken.has(back.id)) id = back.id;
    else while (taken.has(id)) id++;
    const count = (team: Team) => this.seated().filter((s) => s.seat!.team === team).length;
    const team: Team = back?.team ?? (count('blue') < count('red') ? 'blue' : 'red');
    m.token = token;
    m.seat = { id, name: cleanName(msg.name), team, ready: false, away: false };
    m.joinedAt = now;
    this.actedAt = now;
    if (token !== null && token === this.hostToken) this.ownerId = id;
    else this.chooseOwner();
    this.claimHost();
    this.send(m, { t: 'welcome', you: id, room: this.code, owner: this.ownerId, seats: this.seats(), config: { ...this.config }, phase: this.phase, match: this.match, now, log: { shells: this.log.shells, digs: this.log.digs } });
    this.broadcastRoster(m);
    // Late to a match: in it, and told the score; back in the match it left, its kills and deaths its
    // own again, and everyone told.
    if (this.rules) {
      this.rules.join(id, team, Math.max(now, this.match!.startAt));
      const f = this.rules.fighters.get(id);
      if (back && f && back.startAt === this.match!.startAt) {
        f.kills = back.kills;
        f.deaths = back.deaths;
        this.broadcast(this.scoreMsg());
      } else this.send(m, this.scoreMsg());
    }
  }

  /**
   * Whether `msg` from seated `m` is someone playing (protocol.ts ROOM_IDLE_MS): anything but a ping,
   * a state the same as its last but for its tick and with no shot, or the battle's hurt (a forgotten
   * soldier is hurt with nobody at the keys).
   */
  private plays(m: Member, msg: ClientMsg): boolean {
    switch (msg.t) {
      case 'ping':
      case 'hurt':
        return false;
      case 's': {
        const was = m.said;
        m.said = msg.s;
        return (msg.sh?.length ?? 0) > 0 || !was || was.length !== msg.s.length || msg.s.some((v, i) => i > 0 && v !== was[i]);
      }
      default:
        return true;
    }
  }

  /** `m`'s line let go by the room: its seat leaves as on a close (remembered by its token), and the line is closed, told why when it can hear it. */
  private drop(m: Member, why: Closing | 'silent', now: number): void {
    if (why !== 'silent') this.send(m, { t: 'closing', reason: why });
    this.close(m.conn, now);
    try {
      m.conn.close(CLOSE_CODE[why], why);
    } catch {
      // Already closing.
    }
  }

  /** The seats that left more than REJOIN_MS ago forgotten; and the host's claim with them, if theirs, the role's holder's then. */
  private forget(now: number): void {
    for (const [token, l] of this.left) if (now - l.at > REJOIN_MS) this.left.delete(token);
    const claim = this.hostToken;
    if (claim !== null && !this.left.has(claim) && !this.seated().some((s) => s.token === claim)) this.hostToken = null;
    this.claimHost();
  }

  /** With nobody's claim on the host role standing, it is the holder's. */
  private claimHost(): void {
    if (this.hostToken !== null) return;
    this.hostToken = this.seated().find((s) => s.seat!.id === this.ownerId)?.token ?? null;
  }

  /** Whether seat `id`'s bucket has a scoop's token at `now`, filled at DIG_RATE to DIG_BURST since it was last drawn on: taken if so. */
  private digTaken(id: number, now: number): boolean {
    let b = this.digBuckets.get(id);
    if (!b) this.digBuckets.set(id, (b = { tokens: DIG_BURST, at: now }));
    b.tokens = Math.min(DIG_BURST, b.tokens + ((now - b.at) / 1000) * DIG_RATE);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
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
        if (this.rules && this.match && now >= this.match.startAt) this.apply(this.rules.hit(seat.id, msg.v, msg.z, now, msg.w));
        return;
      case 'hurt':
        if (this.rules && this.match && now >= this.match.startAt) this.apply(this.rules.hurt(seat.id, msg.a, msg.c, now));
        return;
      case 'dig':
        // No faster than a shovel, in any phase: past the seat's bucket (its own across a reconnect), dropped.
        if (!this.digTaken(seat.id, now)) return;
        // In any phase once a match has begun on this world (a scoop sent before the end comes after
        // it); never one of a world the room has left (the map changed since, and no match yet).
        // Between matches, no more than LOBBY_DIGS_MAX a seat.
        if (this.log.played) {
          if (this.phase !== 'playing') {
            const taken = this.lobbyDigs.get(seat.id) ?? 0;
            if (taken >= LOBBY_DIGS_MAX) return;
            this.lobbyDigs.set(seat.id, taken + 1);
          }
          const d: WireDig = [seat.id, now, ...msg.c];
          this.record(this.log.digs, d);
          this.broadcast({ t: 'dig', d }, m);
        }
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
        this.hostToken = m.token;
        // Another map is another world: its log starts afresh.
        if (msg.config.map !== undefined && msg.config.map !== this.config.map) this.log = emptyLog();
        this.config = { ...this.config, ...msg.config };
        this.broadcast({ t: 'config', config: { ...this.config } });
        return;
      case 'start':
        if (!owner || this.phase !== 'lobby') return;
        this.hostToken = m.token;
        this.phase = 'playing';
        this.match = { startAt: now + COUNTDOWN_MS, seed: MAP_SEEDS[this.config.map] ?? MAP_SEEDS.ravine, config: { ...this.config } };
        this.rules = new MatchRules(this.config.killTarget, this.config.respawnS * 1000);
        this.shelling =
          this.config.intensity === 'off'
            ? null
            : new Shelling(SHELL_FIELDS[this.config.map] ?? SHELL_FIELDS.ravine, shellingSeed(this.match.startAt, this.match.seed), this.config.intensity, this.log.nextId);
        this.toldS = 0;
        this.overAt = null;
        this.log.played = true;
        this.lobbyDigs.clear();
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
        this.hostToken = m.token;
        this.toLobby();
        return;
      case 'hello':
        return;
    }
  }

  /** Every shell landing within the lead of now not yet told: logged, and told to everyone. */
  private tellShells(now: number): void {
    if (!this.shelling || !this.match) return;
    const throughS = (now - this.match.startAt) / 1000 + SHELLING.leadS;
    if (throughS <= this.toldS) return;
    for (const shell of this.shelling.between(this.toldS, throughS)) {
      const s = encodeShell(shell, this.match.startAt);
      this.log.nextId = shell.id + 1;
      this.record(this.log.shells, s);
      this.broadcast({ t: 'shell', s });
    }
    this.toldS = throughS;
  }

  /** An entry into the log, and the oldest scoops out while it is over LOG_CHARS_MAX. */
  private record(into: WireShell[] | WireDig[], entry: number[]): void {
    into.push(entry);
    const log = this.log;
    log.chars += JSON.stringify(entry).length + 1;
    let drop = 0;
    while (log.chars > LOG_CHARS_MAX && drop < log.digs.length) log.chars -= JSON.stringify(log.digs[drop++]).length + 1;
    if (drop > 0) log.digs.splice(0, drop);
  }

  /** The match over: everyone back in the lobby, unready. */
  private toLobby(): void {
    this.phase = 'lobby';
    this.match = null;
    this.rules = null;
    this.shelling = null;
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
