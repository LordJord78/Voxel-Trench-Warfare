/**
 * Hit feedback (the shots spec's §4): what a frame's hits, the room's kills and the range's plates
 * show and sound, so that landing a shot is felt.
 *
 * - **The player's hits** (owner 0, into any body): the marker, and on a headshot the HEADSHOT pop;
 *   at the ear the thwack, or a headshot's crack and gush. A tick's hits are one marker and one voice
 *   of a kind, however many of a shotgun's pellets struck.
 * - **Every hit on a body seen** (the player's, and others' into others): the body flinches along the
 *   round, kept by its id until it has settled (figureOverlay), and its last hit is kept for a kill.
 *   Another's is heard where it struck: its thwack within [hits] hit_heard_m, a headshot's gush within
 *   gush_heard_m; its crack and its kill are the shooter's own.
 * - **Rounds into the player** (LOCAL_BODY; never their own, which a body's test leaves out): the red
 *   flash at the damage's share of 100, the aim jolted away from the round, and the hurt voice, once a
 *   tick; the damage as the room reckons it (the zone's by the gun's scale, net/gear.ts), a tick's
 *   added up. In a room the front's round (owner 1) is the harm the page sends for it: the zone's by
 *   `frontDamageScale` (combat/harm.ts frontHarm).
 * - **A blast's harm on the player** (a room's shell, `events.harms` of cause 'shell'): the same red
 *   flash at the harm's share of 100 and the hurt voice; no jolt, the blast's own shake and
 *   suppression stand for it. A round's harm adds nothing: its body hit flashes already.
 * - **A kill** (the room's death in a match, the range's own at once): when it was the player's, the
 *   kill marker, the pop (KILL, or HEADSHOT for a headshot's), and the kill's thud and chime at the
 *   ear. The body falls along the last round seen to strike it within kill_window_s, in head_fall_s
 *   from a headshot; and bursts critical there (failing such a hit, at its chest as last drawn),
 *   unless a headshot killed it, which bled and spattered as it struck: one critical burst a hit.
 * - **A plate** (the range's): the hit marker, and its ring where it stands.
 *
 * A kill's and a plate's voices go out with the next frame's (frame). Times are the frame's clock, ms.
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

/** What hit feedback shows (ui/hit-marker.ts's HitMarker): the marker, the words under it, the red flash. */
export interface FeedbackMarker {
  show(kind: MarkerKind, now: number): void;
  pop(text: PopText, name: { name: string; team: Team } | null, now: number): void;
  flash(strength: number, now: number): void;
  clear(): void;
}

/** [hits] as the feedback reads it: the kill's window (s), each voice's gain, how near another's hit and gush are heard (m), the flash's least, the jolt's terms (°), the fall's times and the flinch's (s). */
export interface HitFeedbackTunables {
  killWindowS: number;
  gains: Record<FeedbackKind, number>;
  hitHeardM: number;
  gushHeardM: number;
  flashMin: number;
  jolt: [number, number];
  fallS: number;
  headFallS: number;
  flinchS: number;
}

export function hitFeedbackTunables(tun: Tunables): HitFeedbackTunables {
  const f = (k: string) => tun.f(`hits.${k}`);
  return {
    killWindowS: f('kill_window_s'),
    gains: { hit: f('hit_gain'), head: f('head_gain'), gush: f('gush_gain'), kill: f('kill_gain'), ding: f('ding_gain'), hurt: f('hurt_gain') },
    hitHeardM: f('hit_heard_m'),
    gushHeardM: f('gush_heard_m'),
    flashMin: f('hurt_flash_min'),
    jolt: tun.pair('hits.hurt_jolt_deg'),
    fallS: f('fall_s'),
    headFallS: f('head_fall_s'),
    flinchS: f('flinch_s'),
  };
}

/** What a figure (together.ts's Figure) takes from its hits: its flinch, and killed, its fall. */
export interface FigureOverlay {
  flinch?: Flinch;
  fallYaw?: number;
  fallS?: number;
}

/** A body's last hit: where its round went in, which way, where on it, when (ms; its tick), and whether its tick struck the head. */
interface Struck {
  position: V3;
  dir: V3;
  zone: Zone;
  at: number;
  tick: number;
  head: boolean;
}

const NONE: FigureOverlay = Object.freeze({});
const DEG = 180 / Math.PI;
/** A flinch is given for this many times flinch_s: settled to 2% at one, to nothing that shows at two. */
const FLINCH_SPAN = 2;

const copy = (v: readonly number[]): V3 => [v[0], v[1], v[2]];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export class HitFeedback {
  /** Each body's last hit, by its id. */
  private readonly bodies = new Map<number, Struck>();
  /** Each body killed: the way and time it falls, by its id. */
  private readonly falls = new Map<number, { fallYaw?: number; fallS: number }>();
  /** Each body's chest as last drawn, by its id. */
  private readonly chests = new Map<number, V3>();
  /** Voices of kills and plates, for the next frame. */
  private queued: FeedbackVoice[] = [];
  /** What has been made, for the hooks: voices and markers by kind, and flashes. */
  private readonly tally: Partial<Record<FeedbackKind, number>> = {};
  private readonly markers: Record<MarkerKind, number> = { hit: 0, head: 0, kill: 0 };
  private flashes = 0;

  constructor(
    readonly t: HitFeedbackTunables,
    private readonly marker: FeedbackMarker,
    /** [room_battle] front_damage_scale (combat/harm.ts harmTunables): the front's round in a room, as its harm. */
    private readonly frontDamageScale = 1,
  ) {}

  /**
   * After the frame's ticks, at `now` (ms): what its hits show and sound (the drawn bodies, `others`,
   * say where each one's chest is, for a kill): the voices to play, any a kill or a plate made since
   * the last frame first.
   */
  frame(session: Session, events: CombatEvents, now: number, others: readonly SoldierDraw[] = []): FeedbackVoice[] {
    this.chests.clear();
    for (const d of others) this.chests.set(d.seat, toWorld(d.frames.torso, CHEST));
    const out = this.queued;
    this.queued = [];
    const t = this.t;
    const eye = eyeOf(session);
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
      if (hurt) this.hurt(session, hurt.damage, hurt.dir, now, out);
      body = head = false;
      heard.clear();
      hurt = null;
    };
    for (const h of events.hits) {
      if (h.tick !== tick) {
        done();
        tick = h.tick;
      }
      if (h.body >= 0) {
        if (h.owner !== 0 && h.owner < 2) continue;
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
          out.push(this.voice(kind, copy(h.position)));
        };
        hear('hit', t.hitHeardM);
        if (h.zone === 'head') hear('gush', t.gushHeardM);
      } else if (h.body === LOCAL_BODY && h.owner !== 0) {
        hurt ??= { damage: 0, dir: copy(h.dir) };
        // In a room the front's round (owner 1) is felt as the harm the page sends for it: its zone's
        // damage × front_damage_scale (sim/session.ts, combat/harm.ts frontHarm).
        const front = session.room && h.owner === 1 ? this.frontDamageScale : 1;
        hurt.damage += gunDamage(DAMAGE[h.zone], h.gun) * front;
      }
    }
    done();
    // A blast's harm on the player (in a room): felt as a hit of as much is, but for the jolt.
    for (const h of events.harms) if (h.cause === 'shell') this.shelled(h.amount, now, out);
    this.forget(now);
    return out;
  }

  /**
   * Body `victimId` killed (the room's death, the range's kill) at `now` (ms), by the player's round
   * if `killerIsYou`, `victim` their name and team (none on the range), `zone` where the killing round
   * struck (null: no round killed them, a shell or a fire).
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
    // The round that kills is critical: its burst where it went in. A headshot's was its own, as it struck.
    if (zone === null || zone === 'head') return;
    const at = recent?.position ?? this.chests.get(victimId);
    if (!at) return;
    const dir = recent?.dir ?? away(eyeOf(session), at);
    session.bleed(at, dir, true);
    session.spatterAt(at, dir, hash32(victimId, Math.round(now)));
  }

  /** A round of the player's rang one of the range's plates, standing at `at` (metres), at `now` (ms): the hit marker, and its ring there. */
  plate(_event: Extract<RangeEvent, { kind: 'plate' }>, at: readonly number[], now: number): void {
    this.mark('hit', now);
    this.queued.push(this.voice('ding', copy(at)));
  }

  /** What body `id`'s figure takes at `now` (ms): its flinch, until it has settled, and its fall once killed. */
  figureOverlay(id: number, now: number): FigureOverlay {
    const s = this.bodies.get(id);
    const fall = this.falls.get(id);
    const age = s ? Math.max(0, now - s.at) / 1000 : Number.POSITIVE_INFINITY;
    const flinch = s && age < FLINCH_SPAN * this.t.flinchS ? { dir: s.dir, age, head: s.head } : null;
    if (!flinch && !fall) return NONE;
    return { ...(flinch ? { flinch } : {}), ...fall };
  }

  /** What has been made, for the hooks: voices by kind, flashes, markers by kind. */
  state(): { voices: Record<string, number>; flashes: number; markers: Record<MarkerKind, number> } {
    return { voices: { ...this.tally }, flashes: this.flashes, markers: { ...this.markers } };
  }

  /** Everything forgotten, and nothing showing (a match begun or over). */
  clear(): void {
    this.bodies.clear();
    this.falls.clear();
    this.chests.clear();
    this.queued = [];
    this.marker.clear();
  }

  /** A round of a tick into a body: its flinch and its last hit, a headshot of the same tick's kept. */
  private struck(h: CombatEvents['hits'][number], now: number): void {
    const was = this.bodies.get(h.body);
    const sameTick = was !== undefined && was.tick === h.tick && was.at === now;
    this.bodies.set(h.body, { position: copy(h.position), dir: copy(h.dir), zone: h.zone, at: now, tick: h.tick, head: h.zone === 'head' || (sameTick && was.head) });
  }

  /** Rounds into the player, a tick's, `damage` all told, the first along `dir`: the flash, the jolt and the voice. */
  private hurt(session: Session, damage: number, dir: V3, now: number, out: FeedbackVoice[]): void {
    const t = this.t;
    const share = Math.min(1, damage / 100);
    this.marker.flash(Math.max(t.flashMin, share), now);
    this.flashes++;
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
    out.push(this.voice('hurt', null));
  }

  /** A blast's `amount` of harm on the player: the flash and the voice, as a hit of as much gives; the shell shakes the view itself. */
  private shelled(amount: number, now: number, out: FeedbackVoice[]): void {
    this.marker.flash(Math.max(this.t.flashMin, Math.min(1, amount / 100)), now);
    this.flashes++;
    out.push(this.voice('hurt', null));
  }

  private mark(kind: MarkerKind, now: number): void {
    this.marker.show(kind, now);
    this.markers[kind]++;
  }

  private voice(kind: FeedbackKind, at: [number, number, number] | null): FeedbackVoice {
    this.tally[kind] = (this.tally[kind] ?? 0) + 1;
    return { kind, at, gain: this.t.gains[kind] };
  }

  /** Bodies' hits past any use: their flinch settled and no kill to take them. */
  private forget(now: number): void {
    const keep = 1000 * Math.max(this.t.killWindowS, FLINCH_SPAN * this.t.flinchS);
    for (const [id, s] of this.bodies) if (now - s.at > keep) this.bodies.delete(id);
  }
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
