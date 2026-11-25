/**
 * One player's line to their room: the WebSocket, the room's clock (pings twice a second, five
 * quick ones on joining and on coming back to the tab), what the room last said of its seats,
 * settings and match, the other players' states, and the room's edits to the world (its shells,
 * and the others' scoops) in the order they came.
 *
 * It watches the room as the room watches it (the release audit's ROBUST-7): with the page shown, a
 * ping the room has not answered, nor said anything since, for `silentMs` ([net] room_silent_s) is
 * the line lost, as if it had closed. Hidden, it does not judge: a hidden tab's timers are throttled
 * (to one run a minute at their slowest), so its own pings go late and their answers with them; shown
 * again, it waits afresh. Whatever ends the line is said once (`lost`): the room's refusal, its word
 * that it is closing the line, the close, or the silence.
 *
 * Only made for a game with friends: solo play never loads this, and makes no request at all.
 */

import { matchSeconds, ServerClock } from '../net/clock';
import { decodeDig, decodeShell, decodeShot, defaultConfig, encodeState, isRoomCode, MAX_PLAYERS, parseRoom, PROTOCOL, ROOM_IDLE_MS, type Cause, type ClientMsg, type Closing, type Dig, type MatchInfo, type MatchLog, type Phase, type PlayerState, type Refusal, type RoomConfig, type RoomMsg, type RoomShell, type Seat, type ShotState, type Team, type Zone } from '../net/protocol';
import { RemotePlayers } from './net-players';

export interface NetEvents {
  /** Anything the lobby shows changed: the seats, the settings, the phase. */
  changed(): void;
  /** The match is on (or was already on when this player joined). */
  started(match: MatchInfo): void;
  /**
   * The room welcomed this player: called last in the welcome, after `changed` and, in a match,
   * `started`, with the welcome's log the client's (`log`), for the page to catch up on.
   */
  welcomed(): void;
  /** The owner ended it: back to the lobby. */
  ended(): void;
  /** The room would not have this player, or the line went: why, in a sentence. */
  lost(why: string): void;
  /** In the match: this player was hurt (their health now, and by whom, −1 the battle). */
  hurt(hp: number, from: number): void;
  /** Someone died: who, by whose hand (−1 the battle), where struck, whether a teammate's, by what. */
  death(victim: number, killer: number, zone: Zone | null, teamkill: boolean, cause: Cause): void;
  /** Someone is back in, at their team's `spawn`-th start. */
  respawn(id: number, spawn: number): void;
  /** The match is won. */
  over(winner: Team, red: number, blue: number): void;
}

/** A shot another player fired, as the room relayed it, and the room's clock (ms) of the frame it came in. */
export interface RemoteShot {
  seat: number;
  shot: ShotState;
  at: number;
}

/**
 * The most of the others' shots kept until the game takes them: a hidden tab runs no frame, and a page
 * catching up on the room's log fires none, so theirs wait (Together flies them once it can, silently
 * when old). Past it the oldest go.
 */
export const SHOT_QUEUE_MAX = 2048;

/** An edit of the room's to the world: a shell it told, or a scoop a player dug. */
export type RoomEdit = { t: 'shell'; shell: RoomShell } | { t: 'dig'; dig: Dig };

const PING_MS = 500;

/** What a page is told when the room turns it away: what happened, and what to do. */
export const REFUSED: Record<Refusal, string> = {
  full: `That game is full (${MAX_PLAYERS} players)`,
  version: 'That game is on another version: reload the page',
  'no-room': 'No game with that code',
  'bad-hello': 'The game could not join that room.',
};

/** What a page is told when its line to the room ends. */
export const LOST = {
  /** After the welcome: the line closed, or went silent. */
  line: 'The connection to the game was lost. Reload the page to rejoin.',
  /** Before it: the relay could not be reached, or did not answer. */
  unreachable: 'The game could not be reached: check your connection',
  /** The room closed for nobody playing in it (protocol.ts ROOM_IDLE_MS). */
  idle: `The game was closed after ${ROOM_IDLE_MS / 60_000} minutes with nobody playing`,
  /** The same page came back on another line (another tab with this one's storage): this line let go. */
  replaced: 'This game was opened again in another tab: it goes on there.',
} as const;

const CLOSED: Record<Closing, string> = { idle: LOST.idle, replaced: LOST.replaced };

/** What a line's close says, by its reason, if the room gave one a page is told of. */
function closedFor(reason: string): string | undefined {
  return (REFUSED as Record<string, string>)[reason] ?? (CLOSED as Record<string, string>)[reason];
}

/** Make a room at the relay: its code. */
export async function makeRoom(relay: string): Promise<string> {
  const r = await fetch(`${relay}/rooms`, { method: 'POST' });
  if (!r.ok) throw new Error(`the relay said ${r.status}`);
  const { room } = (await r.json()) as { room?: unknown };
  if (typeof room !== 'string' || !isRoomCode(room)) throw new Error('the relay gave no room');
  return room;
}

/** How a line is opened: the page's rejoin token for the room, said in its hello; and how long (ms) the room may say nothing, with the page shown, before the line is lost (none: never). */
export interface NetOptions {
  token?: string;
  silentMs?: number;
}

export class NetClient {
  readonly clock = new ServerClock();
  readonly players = new RemotePlayers();
  you = -1;
  owner = -1;
  seats: Seat[] = [];
  config: RoomConfig = defaultConfig();
  phase: Phase = 'lobby';
  match: MatchInfo | null = null;
  /** Whether the room has welcomed this player. */
  joined = false;
  /** The room's log of its world as the welcome gave it: every shell told and scoop dug before this player came (empty until then). */
  log: MatchLog = { shells: [], digs: [] };
  /** The match's score, and each player's kills and deaths, as the room last told them. */
  score = { red: 0, blue: 0 };
  tallies = new Map<number, { kills: number; deaths: number }>();
  /** Scoops this player sent (`dig` calls), and the others' the room relayed to it, this visit (for the tests). */
  digsSent = 0;
  digsHeard = 0;
  /** The battle's harms this player told the room (`hurt` calls), this visit (for the tests). */
  hurtsSent = 0;
  /** Others' shots heard and not yet taken by the game, oldest first, at most SHOT_QUEUE_MAX. */
  private shots: RemoteShot[] = [];
  /** The room's edits heard since the game last took them, in the order they came. */
  private edits: RoomEdit[] = [];
  private readonly ws: WebSocket;
  private pinger: ReturnType<typeof setInterval> | null = null;
  /** The line is over for this page (it closed it, or it was said lost): nothing more is said of it. */
  private closedByUs = false;
  /** The page's time the hello went: the welcome is its reply, so the clock's first sample. */
  private helloAt = 0;
  /** Whether the page is shown: hidden, the room's silence is not judged. */
  private shown = true;
  /** The page's time of the first ping since the room last said anything (from the line's making: the room has said nothing yet); null, none since. */
  private waitingSince: number | null;
  private readonly silentMs: number;

  constructor(
    relay: string,
    readonly room: string,
    private name: string,
    build: string,
    private readonly on: NetEvents,
    private readonly now: () => number = () => performance.now(),
    options: NetOptions = {},
  ) {
    this.silentMs = options.silentMs ?? Number.POSITIVE_INFINITY;
    this.waitingSince = this.now();
    this.ws = new WebSocket(`${relay.replace(/^http/, 'ws')}/room/${room}`);
    this.ws.addEventListener('open', () => {
      this.helloAt = this.now();
      this.send({ t: 'hello', v: PROTOCOL, build, name: this.name, ...(options.token === undefined ? {} : { token: options.token }) });
      this.burst();
    });
    // From the line's making: the silence is judged while it opens too (a relay that never answers).
    this.pinger = setInterval(() => this.ping(), PING_MS);
    this.ws.addEventListener('message', (e) => {
      this.waitingSince = null;
      this.receive(e.data);
    });
    this.ws.addEventListener('close', (e) => {
      if (this.pinger) clearInterval(this.pinger);
      if (this.closedByUs) return;
      this.gone(closedFor(e.reason));
    });
  }

  get isOwner(): boolean {
    return this.you >= 0 && this.you === this.owner;
  }

  get seat(): Seat | undefined {
    return this.seats.find((s) => s.id === this.you);
  }

  /** The room's clock now, in ms. */
  serverNow(): number {
    return this.clock.serverAt(this.now());
  }

  /** The match's seconds on the room's clock, from its start; 0 with no match. */
  matchSeconds(): number {
    return this.match ? matchSeconds(this.serverNow(), this.match.startAt) : 0;
  }

  setName(name: string): void {
    this.name = name;
    this.send({ t: 'name', name });
  }

  team(team: Team): void {
    this.send({ t: 'team', team });
  }

  ready(ready: boolean): void {
    this.send({ t: 'ready', ready });
  }

  configure(config: Partial<RoomConfig>): void {
    this.send({ t: 'config', config });
  }

  start(): void {
    this.send({ t: 'start' });
  }

  end(): void {
    this.send({ t: 'end' });
  }

  away(away: boolean): void {
    this.send({ t: 'away', away });
    this.shown = !away;
    if (!away) {
      // Shown again: the room's silence judged afresh, from the burst's pings.
      this.waitingSince = null;
      this.burst();
    }
  }

  /** This player's state, and the shots they fired since the last, as their words (protocol.ts encodeShot, or sent's: what they flew). */
  state(s: PlayerState, shots: readonly number[][]): void {
    this.send({ t: 's', s: encodeState(s), ...(shots.length ? { sh: [...shots] } : {}) });
  }

  /** This player's round struck seat `victim`'s `zone`. */
  hit(victim: number, zone: Zone, gun?: number): void {
    this.send({ t: 'hit', v: victim, z: zone, ...(gun === undefined ? {} : { w: gun }) });
  }

  /** The battle hurt this player by `amount`. */
  hurt(amount: number, cause: Cause): void {
    this.hurtsSent++;
    this.send({ t: 'hurt', a: amount, c: cause });
  }

  /** A scoop this player dug: the cells it cleared (combat/entrenching.ts packCell), for the room to stamp and relay. */
  dig(cells: readonly number[]): void {
    this.digsSent++;
    this.send({ t: 'dig', c: [...cells] });
  }

  /** Others' shots heard and not yet taken, oldest first, for as long as `fits` takes each (all of them, by default). */
  takeShots(fits: (shot: RemoteShot) => boolean = () => true): RemoteShot[] {
    let n = 0;
    while (n < this.shots.length && fits(this.shots[n])) n++;
    return this.shots.splice(0, n);
  }

  /** The room's edits heard since the last call, in the order they came. */
  takeEdits(): RoomEdit[] {
    const out = this.edits;
    this.edits = [];
    return out;
  }

  /** Let go of the line, saying why (`left`: the player left; `stopped`: the page stopped); nothing is said of it here. */
  close(reason = 'left'): void {
    this.closedByUs = true;
    if (this.pinger) clearInterval(this.pinger);
    this.ws.close(1000, reason);
  }

  /**
   * The line is over for this page (`why`; by default, lost): said once. A match the line went in is
   * over for this page first, as if the owner had ended it: the battle is the visitor's again
   * (together.ts ended), not the room's carried on alone.
   */
  private gone(why?: string): void {
    if (this.closedByUs) return;
    this.closedByUs = true;
    if (this.pinger) clearInterval(this.pinger);
    if (this.phase === 'playing') this.endMatch();
    this.on.lost(why ?? (this.joined ? LOST.line : LOST.unreachable));
  }

  /** The match over: back to the lobby. */
  private endMatch(): void {
    this.phase = 'lobby';
    this.match = null;
    this.players.clear();
    this.on.changed();
    this.on.ended();
  }

  private send(msg: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** A ping, unless the room has been silent too long with the page shown: then the line is let go, and lost. */
  private ping(): void {
    if (this.closedByUs) return;
    const now = this.now();
    if (this.shown && this.waitingSince !== null && now - this.waitingSince >= this.silentMs) {
      this.ws.close(4000, 'silent');
      this.gone();
      return;
    }
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.send({ t: 'ping', c: now });
    this.waitingSince ??= now;
  }

  /** Five pings a tenth of a second apart: the clock's offset, quickly, after joining or a hidden tab. */
  private burst(): void {
    for (let k = 0; k < 5; k++) setTimeout(() => this.ping(), k * 100);
  }

  private receive(data: unknown): void {
    const m = parseRoom(data);
    if (m) this.handle(m);
  }

  private handle(m: RoomMsg): void {
    switch (m.t) {
      case 'welcome':
        // The hello's reply: the room's time before anything is reckoned by it (a late joiner's match seconds).
        this.clock.sample(this.helloAt, m.now, this.now());
        this.joined = true;
        this.you = m.you;
        this.players.you = m.you;
        this.owner = m.owner;
        this.seats = m.seats;
        this.players.roster(m.seats);
        this.config = m.config;
        this.phase = m.phase;
        this.match = m.match;
        this.log = m.log;
        this.on.changed();
        if (m.phase === 'playing' && m.match) this.on.started(m.match);
        this.on.welcomed();
        return;
      case 'refused':
        this.gone(REFUSED[m.reason]);
        return;
      case 'closing':
        this.gone(CLOSED[m.reason]);
        return;
      case 'roster':
        this.owner = m.owner;
        this.seats = m.seats;
        this.players.roster(m.seats);
        this.on.changed();
        return;
      case 'config':
        this.config = m.config;
        this.on.changed();
        return;
      case 'start':
        this.phase = 'playing';
        this.match = m.match;
        this.score = { red: 0, blue: 0 };
        this.tallies.clear();
        this.shots = [];
        this.players.clear();
        this.on.changed();
        this.on.started(m.match);
        return;
      case 'end':
        this.endMatch();
        return;
      case 'pong':
        this.clock.sample(m.c, m.s, this.now());
        return;
      case 'f':
        this.players.frame(m.s, m.ps);
        for (const p of m.sh) {
          const shot = decodeShot(p.slice(1));
          if (shot && p[0] !== this.you) this.shots.push({ seat: p[0], shot, at: m.s });
        }
        if (this.shots.length > SHOT_QUEUE_MAX) this.shots.splice(0, this.shots.length - SHOT_QUEUE_MAX);
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
        this.edits.push({ t: 'dig', dig });
        return;
      }
      case 'hurt':
        this.on.hurt(m.hp, m.from);
        return;
      case 'death':
        this.on.death(m.v, m.k, m.z, m.tk, m.c);
        return;
      case 'respawn':
        this.on.respawn(m.id, m.spawn);
        return;
      case 'score':
        this.score = { red: m.red, blue: m.blue };
        this.tallies = new Map(m.ps.map(([id, kills, deaths]) => [id, { kills, deaths }]));
        this.on.changed();
        return;
      case 'over':
        this.score = { red: m.red, blue: m.blue };
        this.on.over(m.winner, m.red, m.blue);
        return;
    }
  }
}
