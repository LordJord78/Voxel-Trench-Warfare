/**
 * Playing with friends (the multiplayer spec's §2 and §4), as the game loop sees it: hosting or
 * joining a room, the lobby, the way into a match; this player's state and shots sent twenty times
 * a second; the others posed, drawn and given to the session for rounds to strike, their shots
 * fired; this player's hits claimed (they decide what their rounds struck, as they saw it); the
 * room's shells landed on its clock and the others' scoops dug in order with them
 * (sim/room-battle.ts), and the battle's harm to this player and their own scoops told the room; and
 * the match over the view: health, deaths and the way back in, the feed, the board, who won.
 *
 * It is made with the page but does nothing until the player hosts or follows a link: solo play
 * never opens a socket or asks the relay anything.
 */

import { holdOf, muzzleOf } from '../combat/arsenal';
import { hitParts, pose, toWorld, type Flinch } from '../combat/soldier-rig';
import { decodeGear, encodeGear, teamTracer } from '../net/gear';
import { encodeShot, MAX_PLAYERS, SHOTS_MAX, STATE, type Cause, type Dig, type MatchInfo, type PlayerState, type RoomConfig, type Team, type Zone } from '../net/protocol';
import { Stance } from '../physics/character';
import type { SoldierDraw } from '../render/soldiers';
import type { RoomBattle } from '../sim/room-battle';
import type { CombatEvents, Session } from '../sim/session';
import { Lobby } from '../ui/lobby';
import { MatchHud, type BoardRow } from '../ui/match-hud';
import { MAP_NAMES, isMapId, type MapId } from '../world/generation/params';
import type { FigureOverlay, HitFeedback } from './hit-feedback';
import { makeRoom, NetClient } from './net-client';
import type { RemotePlayer } from './net-players';

/** States sent a second. */
const SEND_HZ = 20;
const NAME_KEY = 'trenchline.name';
/** Strides a second at a walk (camera.head_bob_hz), and the walking speed they are at (stance.standing.speed). */
const STRIDE_HZ = 1.9;
const WALK_MS = 4.1;
/** A teammate aimed at within this many metres is named under the crosshair. */
const NAME_REACH_M = 30;
/** Teammates are marked over their heads within this many metres. */
const TAG_REACH_M = 150;
/** The shovel's stroke as others are drawn digging, seconds a turn ([hands] dig_stroke_s). */
const STROKE_S = 0.85;
/** Health comes back, as the room's rules have it (net/match-rules.ts), shown as it does. */
const REGEN_DELAY_MS = 6000;
const REGEN_PER_S = 10;
const RAD = Math.PI / 180;

/** Someone to draw as a soldier: where, how they stand and look, their team and seat. */
export interface Figure {
  seat: number;
  team: Team;
  position: [number, number, number];
  velocity: [number, number, number];
  yaw: number;
  pitch: number;
  height: number;
  /** Seconds since killed, or null alive. */
  deadFor: number | null;
  /** What they show (net/gear.ts encodeGear), and their state's flags (net/protocol.ts STATE); none, the bare AK at rest. */
  gear?: number;
  flags?: number;
  /** Their tape's palette id, whatever their team's (the range's dummies wear TAPE_RANGE); none, their team's. */
  tape?: number;
  /** The round that last struck them, which leans them (soldier-rig.ts); none, unflinching. */
  flinch?: Flinch;
  /** Killed: the bearing they fall toward (degrees, world), and in how long (s); none, back from their feet in [hits] fall_s. */
  fallYaw?: number;
  fallS?: number;
}

/** A teammate to mark: over their head (metres), their name and team. */
export interface Tag {
  at: [number, number, number];
  name: string;
  team: Team;
}

/**
 * Figures posed as soldiers for the renderer, each one's stride kept going from frame to frame by
 * how fast they move (the room does not send it). A figure's flinch and fall are its caller's,
 * set on it each frame: they are posed as given, and nothing of them is kept here.
 */
export class Gaits {
  private readonly phase = new Map<number, number>();
  /** Each digger's shovel stroke, in turns. */
  private readonly strokes = new Map<number, number>();

  pose(figures: readonly Figure[], dt: number): SoldierDraw[] {
    const seen = new Set<number>();
    const out = figures.map((f) => {
      seen.add(f.seat);
      const speed = Math.hypot(f.velocity[0], f.velocity[2]);
      const phase = ((this.phase.get(f.seat) ?? 0) + dt * STRIDE_HZ * 2 * Math.PI * (speed / WALK_MS)) % (2 * Math.PI);
      this.phase.set(f.seat, phase);
      const gear = decodeGear(f.gear ?? 0);
      // With the shovel out and digging, its stroke goes round; otherwise it rests.
      let stroke: number | undefined;
      if (gear.gun === null && ((f.flags ?? 0) & STATE.DIGGING) !== 0) {
        stroke = ((this.strokes.get(f.seat) ?? 0) + dt / STROKE_S) % 1;
        this.strokes.set(f.seat, stroke);
      } else this.strokes.delete(f.seat);
      return {
        frames: pose({ position: f.position, yaw: f.yaw, pitch: f.pitch, height: f.height, speed, bob: phase, deadFor: f.deadFor, hold: holdOf(gear, stroke), flinch: f.flinch, fallYaw: f.fallYaw, fallS: f.fallS }),
        team: f.team,
        seat: f.seat,
        feet: f.position,
        gear: f.gear ?? 0,
        ...(f.tape === undefined ? {} : { tape: f.tape }),
      };
    });
    for (const seat of [...this.phase.keys()]) if (!seen.has(seat)) this.phase.delete(seat);
    return out;
  }
}

/**
 * The colour another player's shot is drawn in (net/gear.ts TRACER_KIND), whatever their shot's word
 * says (the shots spec §1): their seat's team's, from their soldier as drawn, or with none drawn (not
 * yet in the room's states, away while the room still relays their shots, nothing buffered) from the
 * room's seats; seated nowhere the room has said, none, and the word says.
 */
export function shotTracer(seat: number, draws: readonly { seat: number; team: Team }[], seats: readonly { id: number; team: Team }[]): number | undefined {
  const team = draws.find((d) => d.seat === seat)?.team ?? seats.find((s) => s.id === seat)?.team;
  return team ? teamTracer(team) : undefined;
}

/**
 * What a page playing the map `loaded` does about a room set to `room`: nothing; claim the room
 * for its own map (a room it has just made, which nobody has set yet); or go to the room's map,
 * which means generating that world (a reload).
 */
export function mapAction(loaded: string, room: string, madeHere: boolean, owner: boolean): 'stay' | 'claim' | 'switch' {
  if (room === loaded) return 'stay';
  if (madeHere && owner) return 'claim';
  return isMapId(room) ? 'switch' : 'stay';
}

export interface TogetherHooks {
  /** The map this page has generated. */
  readonly map: string;
  /** Go to the room's map: the page generates that world and rejoins `room`. */
  switchMap(map: string, room: string): void;
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
  /** This player was killed: they do nothing until they are back in. */
  killed(): void;
  /** This player is back in, at their team's `spawn`-th start. */
  respawn(team: Team, spawn: number): void;
  /** A new room battle on this page's session. */
  battle(): RoomBattle;
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
  private readonly hud: MatchHud;
  private readonly gaits = new Gaits();
  /** This player's health as shown (the room's word, with its regeneration followed). */
  private hp = 100;
  private hurtAt = Number.NEGATIVE_INFINITY;
  private shownAt = 0;
  /** Others killed and not yet back: when (performance.now()). */
  private readonly deaths = new Map<number, number>();
  /** This player killed: by whom (null, the battle) and when. */
  private fallen: { by: { name: string; team: Team } | null; at: number } | null = null;
  private winner: { winner: Team; red: number; blue: number } | null = null;
  /** This player's shots not yet sent, as their words: in a room, the words each flew as (Session sent). */
  private shotsOut: number[][] = [];
  /** Where this player stood and looked at the last frame, for where harm came from. */
  private self: { position: readonly number[]; yaw: number } | null = null;
  /** Tab held: the board shown. */
  boardOpen = false;
  /** Hits this player has claimed, this visit (for the tests). */
  claimed = 0;
  /** This page made the room it is joining: it sets the room's map to its own. */
  private made = false;
  /** Leaving for the room's map. */
  private leaving = false;
  /** The session the frames run, as the last frame gave it: a death between frames bleeds in it. */
  private session: Session | null = null;
  /** The match's shells on this page: made with its first frame, dropped as it starts and once it is over. */
  battle: RoomBattle | null = null;
  /**
   * The others' scoops the last match's battle still held when it ended (RoomBattle.finish), behind
   * craters not yet in: the next match's battle is given them before its first tick. The world, and
   * so they, are the page's until it is reloaded for another map or left.
   */
  private carried: Dig[] = [];

  /**
   * `hits`, the hit feedback (hit-feedback.ts): the others' flinches and falls come from it, and a
   * death in the room goes to it.
   */
  constructor(
    private readonly doc: Document,
    readonly relay: string | null,
    private readonly build: string,
    private readonly storage: Storage | null,
    private readonly hooks: TogetherHooks,
    private readonly hits: HitFeedback | null = null,
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
    this.hud = new MatchHud(doc);
  }

  /** Seconds this player has been dead, or null alive (or not in a match). */
  deadFor(now: number): number | null {
    return this.fallen ? (now - this.fallen.at) / 1000 : null;
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

  /** Make a room and join it, set to this page's map. */
  async host(): Promise<void> {
    if (!this.relay) return;
    try {
      const code = await makeRoom(this.relay);
      this.made = true;
      this.join(code);
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
      changed: () => {
        if (!this.followMap()) this.show();
      },
      started: (match) => this.started(match),
      ended: () => this.ended(),
      lost: (why) => this.lost(why),
      hurt: (hp, from) => this.hurt(hp, from),
      death: (victim, killer, zone, teamkill, cause) => this.death(victim, killer, zone, teamkill, cause),
      respawn: (id, spawn) => this.respawned(id, spawn),
      over: (winner, red, blue) => {
        this.winner = { winner, red, blue };
      },
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
    // Sent only once they have gone in: on the deploy screen the world runs on, but nobody draws or shoots them.
    if (!playing || !this.inPlay || left > 0) return;
    const now = performance.now();
    if (now - this.sentAt < 1000 / SEND_HZ) return;
    this.sentAt = now;
    net.state(stateOf(session), this.shotsOut.splice(0, SHOTS_MAX));
  }

  /**
   * Before the frame's ticks, at `now` (ms, the hit feedback's clock): the others (and any `extra` a
   * test stands in the world) posed, each flinching and falling as its hits say; the living among
   * them given to the session for rounds to strike; their shots fired, each from its shooter's eye,
   * its tracer and flash at their soldier's muzzle, the tracer in their seat's team's colour
   * (shotTracer). In a match, the room's shells heard and landed on its clock, once the clock has its
   * first sample. What to draw.
   */
  prepare(session: Session, dt: number, extra: readonly Figure[] = [], now = performance.now()): SoldierDraw[] {
    this.session = session;
    const hits = this.hits;
    const figures = [...this.figures(), ...extra].map((f) => (hits ? overlaid(f, hits.figureOverlay(f.seat, now)) : f));
    const draws = this.gaits.pose(figures, dt);
    session.together = this.inMatch || extra.length > 0;
    session.room = this.inMatch;
    // Its shots' pellets are seeded by its seat, as the others seed them from its rounds' owner.
    session.seat = this.inMatch ? this.net!.you : -1;
    session.bodies = draws.filter((_, i) => figures[i].deadFor === null).map((d) => ({ id: d.seat, frames: d.frames, feet: d.feet }));
    if (this.net && this.inMatch) {
      const battle = this.matchBattle();
      if (this.net.clock.synced) {
        const nowMs = this.net.serverNow();
        this.feed(battle, nowMs);
        battle.tick(nowMs);
      }
      for (const { seat, shot } of this.net.takeShots()) {
        const d = draws.find((x) => x.seat === seat);
        // From the muzzle of the gun they are drawn with.
        const g = decodeGear(d?.gear ?? 0);
        const muzzle = d && g.gun !== null ? toWorld(d.frames.rifle, muzzleOf(g.gun, g.fit)) : shot.origin;
        session.fireRemote(2 + seat, shot.origin, shot.dir, shot.tracer, muzzle, shot.mark, shotTracer(seat, draws, this.net.seats), shot.tick);
      }
    }
    return draws;
  }

  /**
   * After the frame's ticks: this player's shots kept to send, their hits claimed (the hit feedback
   * marks them), the battle's harm to them and their scoops told the room while they are in and
   * alive, and the match shown.
   */
  after(session: Session, events: CombatEvents, draws: readonly SoldierDraw[], now: number): void {
    const net = this.net;
    if (!net || !this.inMatch) return;
    for (const s of events.shots) if (this.shotsOut.length < 2 * SHOTS_MAX) this.shotsOut.push(s.wire ?? encodeShot({ tick: s.tick, origin: s.origin, dir: s.dir, tracer: s.tracer, ...(s.mark === undefined ? {} : { mark: s.mark }) }));
    for (const h of events.hits) {
      if (h.owner !== 0 || h.body < 0 || h.body >= MAX_PLAYERS) continue;
      net.hit(h.body, h.zone, h.gun);
      this.claimed++;
    }
    if (this.battle) {
      for (const m of this.battle.outgoing(events, this.inPlay && this.begun && !this.fallen && session.alive)) {
        if (m.t === 'hurt') net.hurt(m.a, m.c);
        else if (m.t === 'dig') net.dig(m.c);
      }
    }
    const p = session.player;
    this.self = { position: p.position.toArray(), yaw: p.yaw };
    // Health, coming back as the room's does.
    const dt = Math.min(1, Math.max(0, (now - this.shownAt) / 1000));
    this.shownAt = now;
    if (!this.fallen && this.hp < 100 && now - this.hurtAt >= REGEN_DELAY_MS) this.hp = Math.min(100, this.hp + REGEN_PER_S * dt);
    this.hud.health(this.fallen ? 0 : this.hp);
    const respawnMs = (net.match?.config.respawnS ?? 5) * 1000;
    this.hud.fallen(this.fallen?.by, this.fallen ? (this.fallen.at + respawnMs - now) / 1000 : null);
    this.hud.won(this.winner?.winner ?? null, this.winner?.red, this.winner?.blue);
    this.hud.board(this.boardOpen, this.rows(), net.score, net.match?.config.killTarget ?? 0);
    this.hud.aimed(this.fallen ? null : this.teammateAimed(session, draws));
    this.hud.tick(now);
  }

  /** Teammates to mark over their heads (alive, within TAG_REACH_M of `eye`), so a friend is not shot for a foe. */
  tags(draws: readonly SoldierDraw[], eye: readonly number[]): Tag[] {
    const net = this.net;
    const team = this.team;
    if (!net || !this.inMatch || !team) return [];
    const out: Tag[] = [];
    for (const d of draws) {
      if (d.team !== team || d.seat === net.you || this.deaths.has(d.seat)) continue;
      const head = d.frames.head.t;
      if (Math.hypot(head[0] - eye[0], head[1] - eye[1], head[2] - eye[2]) > TAG_REACH_M) continue;
      const seat = net.seats.find((s) => s.id === d.seat);
      if (seat) out.push({ at: [head[0], head[1] + 0.55, head[2]], name: seat.name, team });
    }
    return out;
  }

  /** The teammate the player's view rests on, within NAME_REACH_M: their name and team. */
  private teammateAimed(session: Session, draws: readonly SoldierDraw[]): { name: string; team: Team } | null {
    const net = this.net!;
    const team = this.team;
    const p = session.player;
    const eye = [p.position.x, p.position.y + session.controller.eyeHeight(p), p.position.z];
    const dir = [Math.sin(p.yaw * RAD) * Math.cos(p.pitch * RAD), Math.sin(p.pitch * RAD), Math.cos(p.yaw * RAD) * Math.cos(p.pitch * RAD)];
    let best: { t: number; seat: number } | null = null;
    for (const d of draws) {
      if (d.team !== team || d.seat === net.you || this.deaths.has(d.seat)) continue;
      const h = hitParts(d.frames, eye, dir, NAME_REACH_M);
      if (h && (!best || h.t < best.t)) best = { t: h.t, seat: d.seat };
    }
    const seat = best ? net.seats.find((s) => s.id === best!.seat) : undefined;
    return seat ? { name: seat.name, team: seat.team } : null;
  }

  private rows(): BoardRow[] {
    const net = this.net!;
    return net.seats.map((s) => ({ name: s.name, team: s.team, kills: net.tallies.get(s.id)?.kills ?? 0, deaths: net.tallies.get(s.id)?.deaths ?? 0, you: s.id === net.you }));
  }

  private hurt(hp: number, from: number): void {
    const now = performance.now();
    this.hp = hp;
    this.hurtAt = now;
    // Where it came from, clockwise from where the player looks.
    const them = from >= 0 ? this.figures().find((f) => f.seat === from) : undefined;
    let bearing: number | null = null;
    if (them && this.self) {
      const toward = Math.atan2(them.position[0] - this.self.position[0], them.position[2] - this.self.position[2]) / RAD;
      bearing = ((((toward - this.self.yaw) % 360) + 540) % 360) - 180;
    }
    this.hud.harm(bearing, now);
  }

  private death(victim: number, killer: number, zone: Zone | null, teamkill: boolean, cause: Cause): void {
    const net = this.net!;
    const now = performance.now();
    const who = (id: number) => {
      const s = net.seats.find((x) => x.id === id);
      return s ? { name: s.name, team: s.team } : null;
    };
    const v = who(victim);
    const k = killer >= 0 ? who(killer) : null;
    const how = teamkill ? 'team-killed' : killer < 0 ? (cause === 'shell' ? 'shelled' : cause === 'fire' ? 'burned' : 'shot from the line') : zone === 'head' ? 'headshot' : 'shot';
    if (v) this.hud.killed({ killer: k, victim: v, how }, now);
    if (victim === net.you) {
      this.fallen = { by: k, at: now };
      this.hp = 0;
      this.hooks.killed();
    } else {
      this.deaths.set(victim, now);
      // Another's death (hit-feedback.ts): this player's kill marked, popped and heard; the body's fall
      // and, a round's, its critical burst where it was last struck. Not this player's own, whose view
      // is in the head: its blood would be thrown into the eye.
      if (this.session) this.hits?.kill(victim, killer === net.you, v, now, this.session, cause === 'round' ? zone : null);
    }
  }

  private respawned(id: number, spawn: number): void {
    const net = this.net!;
    if (id !== net.you) {
      this.deaths.delete(id);
      return;
    }
    this.fallen = null;
    this.hp = 100;
    this.hurtAt = Number.NEGATIVE_INFINITY;
    this.hooks.respawn(this.team ?? 'red', spawn);
  }

  /** The others as they are drawn now. */
  others(): RemotePlayer[] {
    return this.net && this.inMatch ? this.net.players.at(this.net.serverNow()) : [];
  }

  /** The others, to be drawn as soldiers: the dead falling, and lying where they fell. */
  figures(): Figure[] {
    const now = performance.now();
    return this.others().map(({ seat, state }) => {
      const died = this.deaths.get(seat.id);
      return { seat: seat.id, team: seat.team, position: state.position, velocity: state.velocity, yaw: state.yaw, pitch: state.pitch, height: state.height, deadFor: died === undefined ? null : (now - died) / 1000, gear: state.gear ?? 0, flags: state.flags };
    });
  }

  /** The HUD's line: each team's score, the game, and the kills that win it. */
  roomline(): { room: string; red: number; blue: number } | null {
    const net = this.net;
    if (!net || !this.inMatch) return null;
    return { room: `${net.room} \u00b7 first to ${net.match?.config.killTarget ?? 0}`, red: net.score.red, blue: net.score.blue };
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
    this.deaths.clear();
    this.fallen = null;
    this.winner = null;
    this.hp = 100;
    this.hurtAt = Number.NEGATIVE_INFINITY;
    this.shotsOut = [];
    this.battle = null;
    this.hud.clear();
    this.hits?.clear();
    this.hooks.deploy(team, Math.max(0, index), match);
  }

  private ended(): void {
    // Every shell told, heard or still queued, lands now, quietly: the world is the same on every page
    // for the next match. The match's shells and scoops told just before the end are still in the
    // queue; given as the match is over, the shells whistle for no time left, and those a scoop's
    // stamp lands are overdue, so quiet. The scoops still held wait for the next match's battle.
    if (this.net) {
      const battle = this.matchBattle();
      this.feed(battle, Number.POSITIVE_INFINITY);
      this.carried = battle.finish();
    }
    this.battle = null;
    this.inPlay = false;
    this.deaths.clear();
    this.fallen = null;
    this.winner = null;
    this.hud.clear();
    this.hits?.clear();
    this.lobby.gather();
    this.hooks.ended();
    this.show();
  }

  /** The match's battle; made if there is none, and given the scoops the last one held before anything else. */
  private matchBattle(): RoomBattle {
    if (this.battle) return this.battle;
    const battle = (this.battle = this.hooks.battle());
    const nowMs = this.net!.serverNow();
    for (const d of this.carried.splice(0)) battle.dug(d, nowMs);
    return battle;
  }

  /** The room's edits heard since the last frame, to `battle` in the order they came, at `nowMs` on the room's clock (after every time: the match over). */
  private feed(battle: RoomBattle, nowMs: number): void {
    for (const e of this.net!.takeEdits()) {
      if (e.t === 'shell') battle.hear(e.shell, nowMs);
      else battle.dug(e.dig, nowMs);
    }
  }

  private lost(why: string): void {
    this.lobby.gather();
    this.lobby.status(why);
    this.hooks.note(why);
  }

  /**
   * The room's map against this page's: a room this page just made is set to its map; any other
   * room's map, if not this page's, is gone to. True if the page is leaving for it.
   */
  private followMap(): boolean {
    const net = this.net;
    if (!net || !net.joined || this.leaving) return this.leaving;
    const action = mapAction(this.hooks.map, net.config.map, this.made, net.you === net.owner);
    this.made = false;
    if (action === 'claim') net.configure({ map: this.hooks.map });
    if (action !== 'switch') return false;
    this.leaving = true;
    this.lobby.status(`Going to ${MAP_NAMES[net.config.map as MapId]}: the world is being dug…`);
    this.hooks.switchMap(net.config.map, net.room);
    return true;
  }

  private show(): void {
    const net = this.net;
    if (!net || !net.joined) return;
    if (this.inMatch && this.inPlay) return;
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('room', net.room);
    url.searchParams.set('map', net.config.map);
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

/** `f` as its hits leave it (hit-feedback.ts's figureOverlay): its flinch and fall set, or none; `f` itself when it has neither, to set or to clear. */
function overlaid(f: Figure, o: FigureOverlay): Figure {
  if (o.flinch === undefined && o.fallYaw === undefined && o.fallS === undefined && f.flinch === undefined && f.fallYaw === undefined && f.fallS === undefined) return f;
  return { ...f, flinch: o.flinch, fallYaw: o.fallYaw, fallS: o.fallS };
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
  return { tick: session.ticks, position: p.position.toArray(), velocity: p.velocity.toArray(), yaw: p.yaw, pitch: p.pitch, stance: p.stance, height: p.height, flags, gear: encodeGear(session.gear()) };
}
