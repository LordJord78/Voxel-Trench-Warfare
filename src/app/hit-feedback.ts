/**
 * Hit feedback (the shots spec's §4): what a frame's hits, the room's kills and the range's plates
 * show and sound, so that landing a shot is felt.
 *
 * - **The player's hits** (owner 0, into any body): the marker, and on a headshot the HEADSHOT pop;
 *   at the ear the thwack, or a headshot's crack and gush. A tick's hits are one marker and one voice
 *   of a kind, however many of a shotgun's pellets struck. Not those into a body the range has
 *   dropped (frame's `dropped`): a shotgun's pellets after the one that killed a dummy strike it dead,
 *   in that tick or a later one of the frame, before its next frame takes it from the targets.
 * - **Every hit on a body seen** (the player's, and others' into others): the body flinches along the
 *   round, kept by its id until it has settled (figureOverlay), and its last hit is kept for a kill.
 *   Another's is heard where it struck: its thwack within [hits] hit_heard_m, a headshot's gush within
 *   gush_heard_m at gush_others_gain (the shooter's own gush_gain is for the ear, and a kill nearby in a
 *   match is not to overpower); its crack and its kill are the shooter's own.
 * - **Rounds into the player** (LOCAL_BODY): others' (owner 2 on), and the front's (owner 1) in a room
 *   only (the session's `room`, which Together.prepare sets each frame: M6 brings the front's harm into
 *   rooms; in solo play it harms no one, though puppets make the session test the player's body);
 *   never their own, which a body's test leaves out. The red flash at the damage's share of 100, the
 *   aim jolted away from the round, and the hurt voice, once a tick; the damage as the room reckons
 *   it (the zone's by the gun's scale, net/gear.ts), a tick's added up. In a room the front's round
 *   (owner 1) is the harm the page sends for it: the zone's by `frontDamageScale` (combat/harm.ts
 *   frontHarm). Not on the deploy screen (frame's `felt` false): the match's world runs there, and
 *   its shells land, but the player is not in it.
 * - **The room's word of a hit** (harmed: another player's round, Together.hurt): the page strikes a
 *   relayed round on the player's body as it is now, but the shooter aimed at them as drawn 125 ms
 *   and more ago, so a moving player's page mostly never strikes it; the room's word does. The red
 *   flash at its share and the hurt voice (with the next frame's), no jolt (it comes 100–250 ms late:
 *   a late jolt would read as the input lagging). Felt once, whichever came first: a word within
 *   kill_window_s of a round or a blast felt here is that one's; a round struck here within
 *   kill_window_s of a word flashes and jolts, but its voice was the word's. A frame's words (a
 *   shotgun's pellets, told one by one) are one flash, at their sum's share, and one voice.
 * - **A blast's harm on the player** (a room's shell, `events.harms` of cause 'shell'): a frame's added
 *   up, the same red flash at its share of 100 and the hurt voice, once; no jolt, the blast's own
 *   shake and suppression stand for it. In a frame a round into the player was felt as well, one
 *   flash and one hurt voice: the blasts' share joins the flash of the last tick a round was felt in,
 *   at the larger of the two. A round's harm adds nothing: its body hit flashes already.
 * - **The player killed** (the room's death, died): the round that killed them may never be felt
 *   here (the room's word can come before the shot, and a dead body strikes nothing). Unless the red
 *   flash of a round, a blast or a word felt still shows at half or more (its strength, faded over
 *   hurt_flash_s), the red flash at full strength; no jolt, the player being dead. So the death reads:
 *   a round felt ~300 ms before it left a flash at a tenth as they died, and a limb's round 100 ms
 *   before a quarter's flash at 0.18. With it the hurt voice, once half of hurt_flash_s has passed
 *   since the last flash started: a round felt just before has had its own.
 * - **A kill** (the room's death in a match, the range's own at once): when it was the player's, the
 *   kill marker, the pop (KILL, or HEADSHOT for a headshot's), and the kill's thud and chime at the
 *   ear (not a teamkill's: Together passes it as no kill of the player's). The body falls along the
 *   last round seen to strike it within kill_window_s, in head_fall_s from a headshot; and bursts
 *   critical there (failing such a hit, at its chest as last drawn), unless a headshot killed it, or
 *   that last round's tick struck the head: either bled and spattered as it struck, and a hit bursts
 *   critical once. The room's word comes a round trip after the hit, so the burst is carried on as
 *   the body's chest has moved since (a runner's would hang behind it); the spatter goes from where
 *   the round passed.
 * - **A plate** (the range's): the hit marker, and its ring where it stands; once a frame a plate, so
 *   a shotgun's pellets on one ring it once (their dings, alike and at once, would add up in phase).
 *
 * The voices of a kill, a plate and the player's death go out with the next frame's (frame). Times
 * are the frame's clock, ms (main's `now`, the one Together.prepare is given), the room's words too.
 */

import type { FeedbackKind, FeedbackVoice } from '../audio/plan';
import type { RangeEvent } from '../combat/range';
import { CHEST, toWorld, type Flinch, type V3 } from '../combat/soldier-rig';
import { viewBasis } from '../combat/viewmodel';
import { hash32 } from '../core/hash';
import type { Tunables } from '../core/tunables';
import { gunDamage } from '../net/gear';
import { DAMAGE } from '../net/match-rules';
import type { Team, Zone } from '../net/protocol';
import type { SoldierDraw } from '../render/soldiers';
import { LOCAL_BODY, type CombatEvents, type Session } from '../sim/session';
import type { MarkerKind, PopText } from '../ui/hit-marker';

/** What hit feedback shows (ui/hit-marker.ts's HitMarker): the marker (whether it showed: not while a greater one shows), the words under it, the red flash. */
export interface FeedbackMarker {
  show(kind: MarkerKind, now: number): boolean;
  pop(text: PopText, name: { name: string; team: Team } | null, now: number): void;
  flash(strength: number, now: number): void;
  clear(): void;
}

/** [hits] as the feedback reads it: the kill's window (s), each voice's gain (the shooter's, at the ear) and another's gush's, how near another's hit and gush are heard (m), the flash's least and its fade (s), the jolt's terms (°), the fall's times and the flinch's (s), and how many flinch_s a flinch is given for. */
export interface HitFeedbackTunables {
  killWindowS: number;
  gains: Record<FeedbackKind, number>;
  gushOthersGain: number;
  hitHeardM: number;
  gushHeardM: number;
  flashMin: number;
  flashS: number;
  jolt: [number, number];
  fallS: number;
  headFallS: number;
  flinchS: number;
  flinchSpan: number;
}

export function hitFeedbackTunables(tun: Tunables): HitFeedbackTunables {
  const f = (k: string) => tun.f(`hits.${k}`);
  return {
    killWindowS: f('kill_window_s'),
    gains: { hit: f('hit_gain'), head: f('head_gain'), gush: f('gush_gain'), kill: f('kill_gain'), ding: f('ding_gain'), hurt: f('hurt_gain') },
    gushOthersGain: f('gush_others_gain'),
    hitHeardM: f('hit_heard_m'),
    gushHeardM: f('gush_heard_m'),
    flashMin: f('hurt_flash_min'),
    flashS: f('hurt_flash_s'),
    jolt: tun.pair('hits.hurt_jolt_deg'),
    fallS: f('fall_s'),
    headFallS: f('head_fall_s'),
    flinchS: f('flinch_s'),
    flinchSpan: f('flinch_send_span'),
  };
}

/** What a figure (together.ts's Figure) takes from its hits: its flinch, and killed, its fall. */
export interface FigureOverlay {
  flinch?: Flinch;
  fallYaw?: number;
  fallS?: number;
}

/**
 * A body the range has dropped in the frame (app/range.ts's killed): its id, and the round that
 * killed it, by its tick and its place among the frame's hits (CombatEvents.hits). The player's
 * rounds into it after that one strike the dead.
 */
export interface Dropped {
  id: number;
  tick: number;
  index: number;
}

/** A body's last hit: where its round went in, which way, where on it, when (ms; its tick), whether its tick struck the head, and its chest as drawn then (null: not drawn). */
interface Struck {
  position: V3;
  dir: V3;
  zone: Zone;
  at: number;
  tick: number;
  head: boolean;
  chest: V3 | null;
}

const NONE: FigureOverlay = Object.freeze({});
const DEG = 180 / Math.PI;

const copy = (v: readonly number[]): V3 => [v[0], v[1], v[2]];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export class HitFeedback {
  /** Each body's last hit, by its id. */
  private readonly bodies = new Map<number, Struck>();
  /** Each body killed: the way and time it falls, by its id. */
  private readonly falls = new Map<number, { fallYaw?: number; fallS: number }>();
  /** Each body's chest as last drawn, by its id. */
  private readonly chests = new Map<number, V3>();
  /** Voices of kills, plates and the player's death, for the next frame. */
  private queued: FeedbackVoice[] = [];
  /** What has been made, for the hooks: voices and markers by kind, and flashes. */
  private readonly tally: Partial<Record<FeedbackKind, number>> = {};
  private readonly markers: Record<MarkerKind, number> = { hit: 0, head: 0, kill: 0 };
  private flashes = 0;
  /** When the red flash last started (a round, a blast or the room's word of a hit felt, or of the player's death), ms; and how strong it was then (as the marker shows it: the larger of what it was asked and what still showed). */
  private hurtAt = Number.NEGATIVE_INFINITY;
  private flashStrength = 0;
  /** When a round or a blast into the player was last felt here (hurt, shelled), ms: a word of the room's within kill_window_s is that hit's. */
  private feltAt = Number.NEGATIVE_INFINITY;
  /** When the room's word of a hit was last felt (harmed), ms, and the damage of the frame's words so far: a round struck here within kill_window_s is that hit's, and a frame's words are one. */
  private wordAt = Number.NEGATIVE_INFINITY;
  private wordDamage = 0;
  /** The plates rung since the last frame, by index: one ding a plate a frame. */
  private readonly rung = new Set<number>();

  constructor(
    readonly t: HitFeedbackTunables,
    private readonly marker: FeedbackMarker,
    /** [room_battle] front_damage_scale (combat/harm.ts harmTunables): the front's round in a room, as its harm. */
    private readonly frontDamageScale = 1,
  ) {}

  /**
   * After the frame's ticks, at `now` (ms): what its hits show and sound (the drawn bodies, `others`,
   * say where each one's chest is, for a kill; `dropped`, the bodies the range has dropped in the
   * frame, whose later hits are none): the voices to play, any a kill or a plate made since the last
   * frame first. `dropped` is the range's, never kept. `felt` false (main's deploy screen, the match's
   * world running without the player in it): nothing into the player is felt, no round's and no blast's.
   */
  frame(session: Session, events: CombatEvents, now: number, others: readonly SoldierDraw[] = [], dropped: readonly Dropped[] = [], felt = true): FeedbackVoice[] {
    this.chests.clear();
    for (const d of others) this.chests.set(d.seat, toWorld(d.frames.torso, CHEST));
    this.rung.clear();
    const out = this.queued;
    this.queued = [];
    const t = this.t;
    const eye = eyeOf(session);
    const room = session.room;
    const into = (h: CombatEvents['hits'][number]) => felt && intoPlayer(h, room);
    // The frame's blasts on the player (a room's shells), added up: felt once, with the last tick's
    // rounds into the player if any were felt, as one flash and one voice.
    let blast = 0;
    if (felt) for (const h of events.harms) if (h.cause === 'shell') blast += h.amount;
    let lastHurt: number | null = null;
    if (blast > 0) for (const h of events.hits) if (into(h)) lastHurt = h.tick;
    // A tick's at a time: the player's hits on bodies and in the head, others' heard, rounds into the player.
    let tick: number | null = null;
    let body = false;
    let head = false;
    const heard = new Set<string>();
    let hurt: { damage: number; dir: V3 } | null = null;
    const done = () => {
      if (body || head) {
        this.mark(head ? 'head' : 'hit', now);
        if (head) this.marker.pop('HEADSHOT', null, now);
        if (body) out.push(this.voice('hit', null));
        if (head) out.push(this.voice('head', null), this.voice('gush', null));
      }
      if (hurt) this.hurt(session, hurt.damage, hurt.dir, now, out, tick === lastHurt ? blast : 0);
      body = head = false;
      heard.clear();
      hurt = null;
    };
    const hits = events.hits;
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (h.tick !== tick) {
        done();
        tick = h.tick;
      }
      if (h.body >= 0) {
        if (h.owner !== 0 && h.owner < 2) continue;
        // A round of the player's into a body the range has dropped, after the one that killed it.
        if (h.owner === 0 && dropped.some((d) => d.id === h.body && (h.tick > d.tick || (h.tick === d.tick && i > d.index)))) continue;
        this.struck(h, now);
        if (h.owner === 0) {
          if (h.zone === 'head') head = true;
          else body = true;
          continue;
        }
        // Another's round into another body, heard where it struck, near enough: a voice a kind a body a tick.
        const d = Math.hypot(h.position[0] - eye[0], h.position[1] - eye[1], h.position[2] - eye[2]);
        const hear = (kind: FeedbackKind, within: number) => {
          if (d > within || heard.has(`${h.body} ${kind}`)) return;
          heard.add(`${h.body} ${kind}`);
          out.push(this.voice(kind, copy(h.position), kind === 'gush' ? t.gushOthersGain : undefined));
        };
        hear('hit', t.hitHeardM);
        if (h.zone === 'head') hear('gush', t.gushHeardM);
      } else if (into(h)) {
        hurt ??= { damage: 0, dir: copy(h.dir) };
        // In a room the front's round (owner 1) is felt as the harm the page sends for it: its zone's
        // damage × front_damage_scale (sim/session.ts, combat/harm.ts frontHarm).
        const front = session.room && h.owner === 1 ? this.frontDamageScale : 1;
        hurt.damage += gunDamage(DAMAGE[h.zone], h.gun) * front;
      }
    }
    done();
    // The blasts' harm on the player (in a room) with no round felt: as a hit of as much is, but for the jolt.
    if (blast > 0 && lastHurt === null) this.shelled(blast, now, out);
    this.forget(now);
    return out;
  }

  /**
   * Body `victimId` killed (the room's death, the range's kill) at `now` (ms), by the player's round
   * if `killerIsYou`, `victim` their name and team (none on the range), `zone` the zone the range or
   * the room reports for the kill (null: no round killed them, a shell or a fire). The range's is its
   * pull's (app/range.ts's fold): HEAD if any of a shotgun's pellets that struck it alive went into
   * the head, whichever one killed; the room's, the round that killed by its reckoning.
   */
  kill(victimId: number, killerIsYou: boolean, victim: { name: string; team: Team } | null, now: number, session: Session, zone: Zone | null): void {
    const t = this.t;
    const last = this.bodies.get(victimId);
    const recent = zone !== null && last && now - last.at <= t.killWindowS * 1000 ? last : null;
    // Down along the round that killed them, a headshot's quicker; with none seen, back from the feet.
    this.falls.set(victimId, { ...(recent ? { fallYaw: Math.atan2(recent.dir[0], recent.dir[2]) * DEG } : {}), fallS: zone === 'head' ? t.headFallS : t.fallS });
    if (killerIsYou) {
      this.mark('kill', now);
      this.marker.pop(zone === 'head' ? 'HEADSHOT' : 'KILL', victim, now);
      this.queued.push(this.voice('kill', null));
    }
    // The round that kills is critical: its burst where it went in. A headshot's was its own, as it
    // struck; and so was a headshot in the last round's tick (an AK held on the chest climbing into
    // the head after the rounds that killed, a pellet in the head with them): no second.
    if (zone === null || zone === 'head' || recent?.head) return;
    const chest = this.chests.get(victimId);
    const at = recent?.position ?? chest;
    if (!at) return;
    const dir = recent?.dir ?? away(eyeOf(session), at);
    // Where the round went in, carried on as the chest has moved since (the room's word comes a round
    // trip after the hit: a runner's burst would hang behind them); the spatter from where it passed.
    const moved = recent?.chest && chest ? [chest[0] - recent.chest[0], chest[1] - recent.chest[1], chest[2] - recent.chest[2]] : null;
    session.bleed(moved ? [at[0] + moved[0], at[1] + moved[1], at[2] + moved[2]] : at, dir, true);
    session.spatterAt(at, dir, hash32(victimId, Math.round(now)));
  }

  /**
   * The player killed, by the room's word at `now` (ms): unless the red flash of a round, a blast or a
   * word felt still shows at half or more (its strength, fading out over hurt_flash_s), the red flash
   * at full strength, as a one-shot kill's round may never reach them here, and a round felt before it
   * may have left its flash all but gone; with the hurt voice (with the next frame's) once half of
   * hurt_flash_s has passed since the last flash started, so a round just felt, voiced, is not voiced
   * again at once. No jolt: they are dead.
   */
  died(now: number): void {
    if (this.shownFlash(now) >= 0.5) return;
    const voiced = now - this.hurtAt >= this.t.flashS * 500;
    this.flash(1, now);
    if (voiced) this.queued.push(this.voice('hurt', null));
  }

  /**
   * The room's word, at `now` (ms, the frame's clock), that another player's round took `damage` of the
   * player's health (Together.hurt): felt as such a round is, the red flash at its share and the hurt
   * voice (with the next frame's), unless a round or a blast felt here within kill_window_s was that
   * hit; no jolt, the word coming late. Another word in the same frame (a shotgun's pellets, told one
   * by one) is the same hit's: the flash at their sum's share, no more voice.
   */
  harmed(damage: number, now: number): void {
    const t = this.t;
    if (now - this.feltAt <= t.killWindowS * 1000) return;
    const again = this.wordAt === now;
    this.wordDamage = again ? this.wordDamage + damage : damage;
    this.wordAt = now;
    const strength = Math.max(t.flashMin, Math.min(1, this.wordDamage / 100));
    if (again) {
      this.flashStrength = Math.max(strength, this.shownFlash(now));
      this.hurtAt = now;
      this.marker.flash(strength, now);
      return;
    }
    this.flash(strength, now);
    this.queued.push(this.voice('hurt', null));
  }

  /** A round of the player's rang one of the range's plates, standing at `at` (metres), at `now` (ms): the hit marker, and its ring there; once a frame a plate (a shotgun's pellets on it, one ring). */
  plate(event: Extract<RangeEvent, { kind: 'plate' }>, at: readonly number[], now: number): void {
    if (this.rung.has(event.index)) return;
    this.rung.add(event.index);
    this.mark('hit', now);
    this.queued.push(this.voice('ding', copy(at)));
  }

  /** What body `id`'s figure takes at `now` (ms): its flinch, until it has settled, and its fall once killed. */
  figureOverlay(id: number, now: number): FigureOverlay {
    const s = this.bodies.get(id);
    const fall = this.falls.get(id);
    const age = s ? Math.max(0, now - s.at) / 1000 : Number.POSITIVE_INFINITY;
    const flinch = s && age < this.t.flinchSpan * this.t.flinchS ? { dir: s.dir, age, head: s.head } : null;
    if (!flinch && !fall) return NONE;
    return { ...(flinch ? { flinch } : {}), ...fall };
  }

  /** What has been made, for the hooks: voices by kind, flashes, and the markers shown by kind (not those a greater one kept from showing). */
  state(): { voices: Record<string, number>; flashes: number; markers: Record<MarkerKind, number> } {
    return { voices: { ...this.tally }, flashes: this.flashes, markers: { ...this.markers } };
  }

  /** Everything forgotten, and nothing showing (a match begun or over). */
  clear(): void {
    this.bodies.clear();
    this.falls.clear();
    this.chests.clear();
    this.rung.clear();
    this.queued = [];
    this.hurtAt = this.feltAt = this.wordAt = Number.NEGATIVE_INFINITY;
    this.flashStrength = this.wordDamage = 0;
    this.marker.clear();
  }

  /** A round of a tick into a body: its flinch and its last hit, a headshot of the same tick's kept, and its chest as drawn this frame. */
  private struck(h: CombatEvents['hits'][number], now: number): void {
    const was = this.bodies.get(h.body);
    const sameTick = was !== undefined && was.tick === h.tick && was.at === now;
    const chest = this.chests.get(h.body);
    this.bodies.set(h.body, { position: copy(h.position), dir: copy(h.dir), zone: h.zone, at: now, tick: h.tick, head: h.zone === 'head' || (sameTick && was.head), chest: chest ? copy(chest) : null });
  }

  /**
   * Rounds into the player, a tick's, `damage` all told, the first along `dir`: the flash, the jolt and
   * the voice. `blast`, the frame's blasts' harm felt with them: the flash at the larger share, the
   * jolt the rounds' alone.
   */
  private hurt(session: Session, damage: number, dir: V3, now: number, out: FeedbackVoice[], blast = 0): void {
    const t = this.t;
    const share = Math.min(1, damage / 100);
    this.feltAt = now;
    this.flash(Math.max(t.flashMin, share, Math.min(1, blast / 100)), now);
    // Away from the round: across the view the way it went, and up for one that came at the face
    // (down for one from behind), as the body takes it.
    const p = session.player;
    const { forward, right, up } = viewBasis(p.yaw, p.pitch);
    const across = dot(dir, right);
    const rise = dot(dir, up) - dot(dir, forward);
    const n = Math.hypot(across, rise);
    const [yaw, pitch] = n > 1e-6 ? [across / n, rise / n] : [0, 1];
    const deg = t.jolt[0] + t.jolt[1] * share;
    session.jolt(yaw * deg, pitch * deg);
    // The room's word of this hit came first, and was voiced.
    if (now - this.wordAt > t.killWindowS * 1000) out.push(this.voice('hurt', null));
  }

  /** Blasts' `amount` of harm on the player, a frame's: the flash and the voice, as a hit of as much gives; the shell shakes the view itself. Felt, for died and a word. */
  private shelled(amount: number, now: number, out: FeedbackVoice[]): void {
    this.feltAt = now;
    this.flash(Math.max(this.t.flashMin, Math.min(1, amount / 100)), now);
    out.push(this.voice('hurt', null));
  }

  /** The red flash started at `now` (ms) at `strength`, counted; kept as the marker shows it, the larger of that and what still showed. */
  private flash(strength: number, now: number): void {
    this.flashStrength = Math.max(strength, this.shownFlash(now));
    this.hurtAt = now;
    this.marker.flash(strength, now);
    this.flashes++;
  }

  /** How strongly the red flash shows at `now` (ms): its strength as it started, faded out over hurt_flash_s. */
  private shownFlash(now: number): number {
    return this.flashStrength * Math.max(0, 1 - (now - this.hurtAt) / (this.t.flashS * 1000));
  }

  private mark(kind: MarkerKind, now: number): void {
    if (this.marker.show(kind, now)) this.markers[kind]++;
  }

  /** A voice of `kind` at `at` (null, the ear), at its gain unless told another. */
  private voice(kind: FeedbackKind, at: [number, number, number] | null, gain = this.t.gains[kind]): FeedbackVoice {
    this.tally[kind] = (this.tally[kind] ?? 0) + 1;
    return { kind, at, gain };
  }

  /** Bodies' hits past any use: their flinch settled and no kill to take them. */
  private forget(now: number): void {
    const keep = 1000 * Math.max(this.t.killWindowS, this.t.flinchSpan * this.t.flinchS);
    for (const [id, s] of this.bodies) if (now - s.at > keep) this.bodies.delete(id);
  }
}

/** A round into the player that is felt: another player's (owner 2 on), or the front's (owner 1) in a room (`room`, the session's); never their own. */
function intoPlayer(h: CombatEvents['hits'][number], room: boolean): boolean {
  return h.body === LOCAL_BODY && (h.owner >= 2 || (h.owner === 1 && room));
}

/** The player's eye (metres). */
function eyeOf(session: Session): V3 {
  const p = session.player;
  return [p.position.x, p.position.y + session.controller.eyeHeight(p), p.position.z];
}

/** The way from `from` to `to`, unit; straight on along +z where they meet. */
function away(from: readonly number[], to: readonly number[]): V3 {
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const n = Math.hypot(d[0], d[1], d[2]);
  return n > 1e-9 ? [d[0] / n, d[1] / n, d[2] / n] : [0, 0, 1];
}
