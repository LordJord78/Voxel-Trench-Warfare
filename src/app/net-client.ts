/**
 * One player's line to their room: the WebSocket, the room's clock (pings twice a second, five
 * quick ones on joining and on coming back to the tab), what the room last said of its seats,
 * settings and match, and the other players' states.
 *
 * Only made for a game with friends: solo play never loads this, and makes no request at all.
 */

import { ServerClock } from '../net/clock';
import { defaultConfig, encodeState, parseRoom, PROTOCOL, type ClientMsg, type MatchInfo, type Phase, type PlayerState, type Refusal, type RoomConfig, type RoomMsg, type Seat, type Team } from '../net/protocol';
import { RemotePlayers } from './net-players';

export interface NetEvents {
  /** Anything the lobby shows changed: the seats, the settings, the phase. */
  changed(): void;
  /** The match is on (or was already on when this player joined). */
  started(match: MatchInfo): void;
  /** The owner ended it: back to the lobby. */
  ended(): void;
  /** The room would not have this player, or the line went: why, in a sentence. */
  lost(why: string): void;
}

const PING_MS = 500;

const REFUSED: Record<Refusal, string> = {
  full: 'That game is full: eight players already.',
  version: "That game is running another version of TRENCHLINE. Reload the page (it may need a moment to update), and ask the host to reload too.",
  'no-room': 'There is no game with that code. Ask the host for a new link.',
  'bad-hello': 'The game could not join that room.',
};

/** Make a room at the relay: its code. */
export async function makeRoom(relay: string): Promise<string> {
  const r = await fetch(`${relay}/rooms`, { method: 'POST' });
  if (!r.ok) throw new Error(`the relay said ${r.status}`);
  const { room } = (await r.json()) as { room?: unknown };
  if (typeof room !== 'string' || !/^[A-Z]{5}$/.test(room)) throw new Error('the relay gave no room');
  return room;
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
  private readonly ws: WebSocket;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private closedByUs = false;

  constructor(
    relay: string,
    readonly room: string,
    private name: string,
    build: string,
    private readonly on: NetEvents,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.ws = new WebSocket(`${relay.replace(/^http/, 'ws')}/room/${room}`);
    this.ws.addEventListener('open', () => {
      this.send({ t: 'hello', v: PROTOCOL, build, name: this.name });
      this.burst();
      this.pinger = setInterval(() => this.ping(), PING_MS);
    });
    this.ws.addEventListener('message', (e) => this.receive(e.data));
    this.ws.addEventListener('close', (e) => {
      if (this.pinger) clearInterval(this.pinger);
      if (!this.closedByUs && e.reason !== 'version' && e.reason !== 'full' && e.reason !== 'no-room') this.on.lost(this.joined ? 'The connection to the game was lost. Reload the page to rejoin.' : 'The game could not be reached.');
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
    if (!away) this.burst();
  }

  state(s: PlayerState): void {
    this.send({ t: 's', s: encodeState(s) });
  }

  close(): void {
    this.closedByUs = true;
    if (this.pinger) clearInterval(this.pinger);
    this.ws.close(1000, 'left');
  }

  private send(msg: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private ping(): void {
    this.send({ t: 'ping', c: this.now() });
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
        this.joined = true;
        this.you = m.you;
        this.players.you = m.you;
        this.owner = m.owner;
        this.seats = m.seats;
        this.players.roster(m.seats);
        this.config = m.config;
        this.phase = m.phase;
        this.match = m.match;
        this.on.changed();
        if (m.phase === 'playing' && m.match) this.on.started(m.match);
        return;
      case 'refused':
        this.closedByUs = true;
        this.on.lost(REFUSED[m.reason]);
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
        this.players.clear();
        this.on.changed();
        this.on.started(m.match);
        return;
      case 'end':
        this.phase = 'lobby';
        this.match = null;
        this.players.clear();
        this.on.changed();
        this.on.ended();
        return;
      case 'pong':
        this.clock.sample(m.c, m.s, this.now());
        return;
      case 'f':
        this.players.frame(m.s, m.ps);
        return;
    }
  }
}
