/**
 * Playing with friends (the multiplayer spec's §2), as the game loop sees it: hosting or joining a
 * room, the lobby, the way into a match, this player's state sent twenty times a second, and the
 * others to draw.
 *
 * It is made with the page but does nothing until the player hosts or follows a link: solo play
 * never opens a socket or asks the relay anything.
 */

import { STATE, type MatchInfo, type PlayerState, type RoomConfig, type Team } from '../net/protocol';
import { Stance } from '../physics/character';
import type { Session } from '../sim/session';
import { Lobby } from '../ui/lobby';
import type { DebugRibbon } from './effects-frame';
import { makeRoom, NetClient } from './net-client';
import type { RemotePlayer } from './net-players';

/** States sent a second. */
const SEND_HZ = 20;
const NAME_KEY = 'trenchline.name';
/** A team's colour for the stand-in ribbons drawn until soldiers are (an emissive scale, as a tracer's). */
const RIBBON: Record<Team, [number, number, number]> = { red: [1.0, 0.16, 0.08], blue: [0.12, 0.36, 1.0] };

export interface TogetherHooks {
  /** The lobby is up: the loading screen goes. */
  showLobby(): void;
  /** The match is starting (or on, for a late joiner): the player is put at their team's start. */
  deploy(team: Team, index: number, match: MatchInfo): void;
  /** Go: into play, with the mouse. */
  play(): void;
  /** The match is over: out of play, back to the lobby. */
  ended(): void;
  /** A line at the top of the page. */
  note(text: string): void;
}

/** Where the relay is: `?relay=` on a development build (the tests'), the build's own, or the local one on localhost; null where there is none. */
export function relayUrl(search: URLSearchParams, hostname: string, dev: boolean, built: string | undefined): string | null {
  const local = hostname === 'localhost' || hostname === '127.0.0.1';
  const given = search.get('relay');
  if (given && (dev || local) && /^https?:\/\/[\w.-]+(:\d+)?$/.test(given)) return given;
  if (built) return built.replace(/\/+$/, '');
  return local ? 'http://127.0.0.1:8787' : null;
}

export class Together {
  net: NetClient | null = null;
  private readonly lobby: Lobby;
  private sentAt = Number.NEGATIVE_INFINITY;
  /** Whether this player has gone in (clicked Go) this match. */
  private inPlay = false;

  constructor(
    private readonly doc: Document,
    readonly relay: string | null,
    private readonly build: string,
    private readonly storage: Storage | null,
    private readonly hooks: TogetherHooks,
  ) {
    this.lobby = new Lobby(doc, {
      name: (name) => {
        this.save(name);
        this.net?.setName(name);
      },
      team: (team) => this.net?.team(team),
      ready: (ready) => this.net?.ready(ready),
      configure: (config: Partial<RoomConfig>) => this.net?.configure(config),
      start: () => this.net?.start(),
      leave: () => this.leave(),
      go: () => this.go(),
    });
    doc.addEventListener('visibilitychange', () => {
      if (this.net) this.net.away(doc.hidden);
    });
  }

  /** In a room's match (starting, or on). */
  get inMatch(): boolean {
    return this.net?.phase === 'playing' && this.net.match !== null;
  }

  /** The match has begun: its countdown is over. */
  get begun(): boolean {
    return this.inMatch && this.net!.serverNow() >= this.net!.match!.startAt;
  }

  get config(): RoomConfig | null {
    return this.net?.match?.config ?? null;
  }

  get team(): Team | null {
    return this.net?.seat?.team ?? null;
  }

  /** Make a room and join it. */
  async host(): Promise<void> {
    if (!this.relay) return;
    try {
      this.join(await makeRoom(this.relay));
    } catch (e) {
      this.hooks.note(`Could not make a game: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Join the room `code`: the lobby comes up, and the page's address becomes the room's link. */
  join(code: string): void {
    if (!this.relay || this.net) return;
    const room = code.trim().toUpperCase();
    if (!/^[A-Z]{5}$/.test(room)) {
      this.hooks.note('A game code is five letters.');
      return;
    }
    const url = new URL(location.href);
    url.searchParams.set('room', room);
    history.replaceState(null, '', url);
    this.net = new NetClient(this.relay, room, this.savedName(), this.build, {
      changed: () => this.show(),
      started: (match) => this.started(match),
      ended: () => this.ended(),
      lost: (why) => this.lost(why),
    });
    this.hooks.showLobby();
    this.lobby.status('Joining…');
  }

  /** Every frame: the countdown shown, and this player's state sent while in the match. */
  frame(session: Session, playing: boolean): void {
    const net = this.net;
    if (!net || !this.inMatch) return;
    const left = net.match!.startAt - net.serverNow();
    if (!this.inPlay) {
      const side = this.team === 'blue' ? 'Blue' : 'Red';
      this.lobby.deploy(left > 0 ? `You fight for ${side}. The match starts in ${Math.ceil(left / 1000)}…` : `The match is on. You fight for ${side}.`, left <= 0);
    }
    if (!playing || left > 0) return;
    const now = performance.now();
    if (now - this.sentAt < 1000 / SEND_HZ) return;
    this.sentAt = now;
    net.state(stateOf(session));
  }

  /** The others as they are drawn now. */
  others(): RemotePlayer[] {
    return this.net && this.inMatch ? this.net.players.at(this.net.serverNow()) : [];
  }

  /** The others as stand-in ribbons, from their feet to their heads. */
  ribbons(): DebugRibbon[] {
    return this.others().map(({ seat, state }) => {
      const [x, y, z] = state.position;
      return { tail: [x, y + 0.1, z], head: [x, y + Math.max(0.4, state.height), z], width: 0.5, colour: RIBBON[seat.team] };
    });
  }

  /** The HUD's line: the game, and how many a side. */
  roomline(): { room: string; red: number; blue: number } | null {
    const net = this.net;
    if (!net || !this.inMatch) return null;
    return { room: net.room, red: net.seats.filter((s) => s.team === 'red').length, blue: net.seats.filter((s) => s.team === 'blue').length };
  }

  get isOwner(): boolean {
    return this.net?.isOwner ?? false;
  }

  /** The owner's: end the match for everyone. */
  endMatch(): void {
    this.net?.end();
  }

  /** Out of the game: the page as it was, without the room. */
  leave(): void {
    this.net?.close();
    this.net = null;
    const url = new URL(location.href);
    url.searchParams.delete('room');
    location.href = url.toString();
  }

  private go(): void {
    if (!this.begun) return;
    this.inPlay = true;
    this.lobby.hide();
    this.hooks.play();
  }

  private started(match: MatchInfo): void {
    const net = this.net!;
    const team = net.seat?.team ?? 'red';
    const index = net.seats.filter((s) => s.team === team).findIndex((s) => s.id === net.you);
    this.inPlay = false;
    this.hooks.deploy(team, Math.max(0, index), match);
  }

  private ended(): void {
    this.inPlay = false;
    this.lobby.gather();
    this.hooks.ended();
    this.show();
  }

  private lost(why: string): void {
    this.lobby.gather();
    this.lobby.status(why);
    this.hooks.note(why);
  }

  private show(): void {
    const net = this.net;
    if (!net || !net.joined) return;
    if (this.inMatch && this.inPlay) return;
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('room', net.room);
    this.lobby.show({ room: net.room, invite: url.toString(), you: net.you, owner: net.owner, seats: net.seats, config: net.config });
  }

  private savedName(): string {
    try {
      return this.storage?.getItem(NAME_KEY) ?? '';
    } catch {
      return '';
    }
  }

  private save(name: string): void {
    try {
      this.storage?.setItem(NAME_KEY, name);
    } catch {
      // Not kept: asked again next time.
    }
  }
}

/** The player's body as the others need it. */
export function stateOf(session: Session): PlayerState {
  const p = session.player;
  let flags = 0;
  if (p.onGround) flags |= STATE.ON_GROUND;
  if (session.intent.fire && p.stance !== Stance.PERISCOPE) flags |= STATE.FIRING;
  if (session.weapon.reloading) flags |= STATE.RELOADING;
  if (session.digging) flags |= STATE.DIGGING;
  if (p.climbTo !== null) flags |= STATE.CLIMBING;
  if (p.onFiringStep) flags |= STATE.ON_STEP;
  return { tick: session.ticks, position: p.position.toArray(), velocity: p.velocity.toArray(), yaw: p.yaw, pitch: p.pitch, stance: p.stance, height: p.height, flags };
}
