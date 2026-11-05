/**
 * The gun in the hands, moving as a held gun does (the shots spec's §2): it bobs with the stride,
 * trails the view's turn, breathes at rest, swings low and across at a sprint, dips on a hard
 * landing, overshoots the aim as the sights arrive (§3), and works through its reload and its pump.
 * The session ticks it with the tick's own time and turn, so the muzzle the tracers and the flash
 * leave from is the drawn gun's; none of it moves a round, which leaves from the eye.
 *
 * What it gives is a change to the held pose (viewmodel.ts `heldPose`, which adds it after the aim's
 * blend): an offset in view space, metres x right, y up and z forward, and turns in degrees, pitch
 * muzzle up, yaw muzzle right and roll right side up. It keeps the last two ticks' so a frame between
 * them is drawn between them, as the view kick is.
 *
 * The sway and the landing are springs (spring.ts's exact step). The reloads are curves keyed over
 * the reload's phase and eased between keys, as the shovel's stroke is, and a key's cue is heard on
 * the tick its mark is passed: the last phase under it, this one at or over it. Every magnitude is
 * `[handling]`'s.
 */

import { PI, TAU, sin } from '../core/dmath';
import type { Tunables } from '../core/tunables';
import type { GunKey } from '../net/gear';
import { advanceSpring, SETTLE_CONSTANT } from './spring';

type V3 = [number, number, number];

/** A change to the held pose: an offset in view space (metres) and turns (degrees). */
export interface HandsDelta {
  offset: [number, number, number];
  pitch: number;
  yaw: number;
  roll: number;
}

const frozen = <T>(v: T): T => Object.freeze(v) as T;

/** No change: the held pose as it is. Frozen, since every default shares it. */
export const ZERO_HANDS: HandsDelta = frozen({ offset: frozen<V3>([0, 0, 0]), pitch: 0, yaw: 0, roll: 0 });

/** What the hands do that is heard: the magazine out and in, the bolt, the M249's feed cover, a shell, the pump, and a dry click (the session's). */
export type HandlingCue = 'mag-out' | 'mag-in' | 'bolt' | 'cover' | 'shell' | 'pump' | 'dry';

/** How a gun is worked: a long gun's magazine and bolt, the machine gun's, a pistol's, or the shotgun's shells and pump. */
export type GunClass = 'long' | 'mg' | 'pistol' | 'pump';

/** `[handling]`, and the shotgun's reload times, by which its pushes are laid out. */
export interface HandlingTunables {
  /** The stride's bob: up and down (m), across and its roll (m, °), and its share aimed and at a sprint. */
  bobUpM: number;
  bobSideM: number;
  bobRollDeg: number;
  bobAimed: number;
  bobSprint: number;
  /** The look's sway: metres and degrees of roll per °/s of turn, held to a most, on a spring; its share aimed. */
  swayMPerDps: number;
  swayRollDegPerDps: number;
  swayMaxM: number;
  swayMaxDeg: number;
  swaySettleS: number;
  swayDamping: number;
  swayAimed: number;
  /** Breathing: up and down and aside (m, Hz), and its share aimed. */
  breathUpM: number;
  breathUpHz: number;
  breathSideM: number;
  breathSideHz: number;
  breathAimed: number;
  /** The sprint's pose, how long it takes to come in and to leave, and the blend at or over which no shot leaves (the session's). */
  sprintOffsetM: V3;
  sprintPitchDeg: number;
  sprintYawDeg: number;
  sprintRollDeg: number;
  sprintInS: number;
  sprintOutS: number;
  sprintBlocksFire: number;
  /** A landing's dip (m, °), the landing speed (m/s) that dips it fully, and its spring. */
  landingDropM: number;
  landingPitchDeg: number;
  landingHardMps: number;
  landingSettleS: number;
  landingDamping: number;
  /** An aim-in: the pitch (°) the muzzle is carried past the aim as the sights arrive, how long it takes to get there, and how long after they arrive it is back. */
  aimOvershootDeg: number;
  aimOvershootRiseS: number;
  aimOvershootS: number;
  /** The long guns' reload: its keys' phases and poses. */
  reloadTiltAt: number;
  reloadTiltM: V3;
  reloadTiltPitchDeg: number;
  reloadTiltRollDeg: number;
  reloadMagOutAt: number;
  reloadMagOutDropM: number;
  reloadHoldAt: number;
  reloadMagInAt: number;
  reloadMagInRiseM: number;
  reloadMagInPitchDeg: number;
  reloadBoltAt: number;
  reloadBoltBackM: number;
  reloadBoltRollDeg: number;
  /** How long a reload cut short takes to ease back to rest. */
  reloadCutS: number;
  /** The machine gun's: the long guns', this many times as deep, with the feed cover's mark. */
  mgDepth: number;
  mgCoverAt: number;
  /** A pistol's: its tilt and its marks (the bolt is the slide's release). */
  pistolTiltRollDeg: number;
  pistolMagOutAt: number;
  pistolMagInAt: number;
  pistolSlideAt: number;
  /** The shotgun's shells: each one's push (m, °), after `[weapon.m870]`'s base time, each its per-shell time. */
  shellPushM: V3;
  shellPitchDeg: number;
  shellBaseS: number;
  shellEachS: number;
  /** Its pump: from this long after a shot, back this far over the stroke's time and forward over as long again. */
  pumpAfterS: number;
  pumpBackM: number;
  pumpStrokeS: number;
  /** Empty: how long after the dry click a reload begins (the session's). */
  dryReloadS: number;
  /** A run's speed (m/s): the session's share of a run is the body's speed over this. */
  runMps: number;
}

export function handlingTunables(tun: Tunables): HandlingTunables {
  const f = (key: string) => tun.f(`handling.${key}`);
  const v = (key: string) => tun.triple(`handling.${key}`);
  return {
    bobUpM: f('bob_up_m'),
    bobSideM: f('bob_side_m'),
    bobRollDeg: f('bob_roll_deg'),
    bobAimed: f('bob_aimed'),
    bobSprint: f('bob_sprint'),
    swayMPerDps: f('sway_m_per_dps'),
    swayRollDegPerDps: f('sway_roll_deg_per_dps'),
    swayMaxM: f('sway_max_m'),
    swayMaxDeg: f('sway_max_deg'),
    swaySettleS: f('sway_settle_s'),
    swayDamping: f('sway_damping'),
    swayAimed: f('sway_aimed'),
    breathUpM: f('breath_up_m'),
    breathUpHz: f('breath_up_hz'),
    breathSideM: f('breath_side_m'),
    breathSideHz: f('breath_side_hz'),
    breathAimed: f('breath_aimed'),
    sprintOffsetM: v('sprint_offset_m'),
    sprintPitchDeg: f('sprint_pitch_deg'),
    sprintYawDeg: f('sprint_yaw_deg'),
    sprintRollDeg: f('sprint_roll_deg'),
    sprintInS: f('sprint_in_s'),
    sprintOutS: f('sprint_out_s'),
    sprintBlocksFire: f('sprint_blocks_fire'),
    landingDropM: f('landing_drop_m'),
    landingPitchDeg: f('landing_pitch_deg'),
    landingHardMps: f('landing_hard_mps'),
    landingSettleS: f('landing_settle_s'),
    landingDamping: f('landing_damping'),
    aimOvershootDeg: f('aim_overshoot_deg'),
    aimOvershootRiseS: f('aim_overshoot_rise_s'),
    aimOvershootS: f('aim_overshoot_s'),
    reloadTiltAt: f('reload_tilt_at'),
    reloadTiltM: v('reload_tilt_m'),
    reloadTiltPitchDeg: f('reload_tilt_pitch_deg'),
    reloadTiltRollDeg: f('reload_tilt_roll_deg'),
    reloadMagOutAt: f('reload_mag_out_at'),
    reloadMagOutDropM: f('reload_mag_out_drop_m'),
    reloadHoldAt: f('reload_hold_at'),
    reloadMagInAt: f('reload_mag_in_at'),
    reloadMagInRiseM: f('reload_mag_in_rise_m'),
    reloadMagInPitchDeg: f('reload_mag_in_pitch_deg'),
    reloadBoltAt: f('reload_bolt_at'),
    reloadBoltBackM: f('reload_bolt_back_m'),
    reloadBoltRollDeg: f('reload_bolt_roll_deg'),
    reloadCutS: f('reload_cut_s'),
    mgDepth: f('mg_depth'),
    mgCoverAt: f('mg_cover_at'),
    pistolTiltRollDeg: f('pistol_tilt_roll_deg'),
    pistolMagOutAt: f('pistol_mag_out_at'),
    pistolMagInAt: f('pistol_mag_in_at'),
    pistolSlideAt: f('pistol_slide_at'),
    shellPushM: v('shell_push_m'),
    shellPitchDeg: f('shell_pitch_deg'),
    shellBaseS: tun.f('weapon.m870.reload_base_s'),
    shellEachS: tun.f('weapon.m870.reload_per_round_s'),
    pumpAfterS: f('pump_after_s'),
    pumpBackM: f('pump_back_m'),
    pumpStrokeS: f('pump_stroke_s'),
    dryReloadS: f('dry_reload_s'),
    runMps: f('run_mps'),
  };
}

const GUN_CLASS: Record<GunKey, GunClass> = {
  ak74: 'long',
  m4: 'long',
  mp5: 'long',
  svd: 'long',
  m249: 'mg',
  m870: 'pump',
  m17: 'pistol',
  pm: 'pistol',
};

/** How a gun is worked: the rifle, carbine, SMG and marksman are long guns. */
export function gunClass(key: GunKey): GunClass {
  return GUN_CLASS[key];
}

/** One tick's handling, as the session reads it. */
export interface HandlingInput {
  /** The tick's length and the session's time (s). */
  dt: number;
  time: number;
  /** This tick's turn of the view (°/s): to the right, and up. */
  yawRate: number;
  pitchRate: number;
  /** The run's share of full speed (held to 0 to 1), the stride's phase (radians, wrapping at a turn), on the ground or not, and the speed (m/s) the body last landed at. */
  speedRatio: number;
  bobPhase: number;
  onGround: boolean;
  landingImpact: number;
  /** Sprinting (the session's rule), and how far aimed (0 to 1). */
  sprinting: boolean;
  aimed: number;
  /** A reload under way: its phase (0 to 1) and, for the shotgun, the shells it loads (counted as it begins). */
  reload: { phase: number; shells: number } | null;
  /** Seconds since the last shot. */
  sinceShot: number;
  gun: GunClass;
}

/** A key of a reload's curve: where in its phase, and the pose there (from rest). */
interface Key extends HandsDelta {
  at: number;
}

/** Where in a reload's phase a cue is heard. */
interface Mark {
  at: number;
  cue: HandlingCue;
}

interface Curve {
  keys: readonly Key[];
  marks: readonly Mark[];
}

const smooth = (u: number) => u * u * (3 - 2 * u);
/** `a` at k = 0, `b` at k = 1, exactly. */
const mix = (a: number, b: number, k: number) => a * (1 - k) + b * k;
const hold = (x: number, most: number) => Math.min(most, Math.max(-most, x));
const zero = (): HandsDelta => ({ offset: [0, 0, 0], pitch: 0, yaw: 0, roll: 0 });
const copy = (d: HandsDelta): HandsDelta => ({ offset: [d.offset[0], d.offset[1], d.offset[2]], pitch: d.pitch, yaw: d.yaw, roll: d.roll });
const byPhase = (a: { at: number }, b: { at: number }) => a.at - b.at;

/** `d` × `k` summed into `to`, which is returned. */
function addScaled(to: HandsDelta, d: HandsDelta, k: number): HandsDelta {
  for (let a = 0; a < 3; a++) to.offset[a] += d.offset[a] * k;
  to.pitch += d.pitch * k;
  to.yaw += d.yaw * k;
  to.roll += d.roll * k;
  return to;
}

/** From `a` toward `b`, `u` of the way: a fresh delta. */
function lerpHands(a: HandsDelta, b: HandsDelta, u: number): HandsDelta {
  const lerp = (from: number, to: number) => from + (to - from) * u;
  return { offset: [lerp(a.offset[0], b.offset[0]), lerp(a.offset[1], b.offset[1]), lerp(a.offset[2], b.offset[2])], pitch: lerp(a.pitch, b.pitch), yaw: lerp(a.yaw, b.yaw), roll: lerp(a.roll, b.roll) };
}

/**
 * A magazine gun's reload, laid out as the long guns' is: tilted; the magazine out, a jolt down;
 * held tilted; the magazine in, a jolt up and the muzzle up; the bolt, drawn back and turned
 * further; at rest. `depth` deepens every key (the machine gun's), and `marks` are heard as well.
 */
function magazineCurve(t: HandlingTunables, tiltRoll: number, magOutAt: number, magInAt: number, boltAt: number, depth: number, marks: readonly Mark[]): Curve {
  const [x, y, z] = t.reloadTiltM;
  const pitch = t.reloadTiltPitchDeg;
  const key = (at: number, o: V3, keyPitch: number, roll: number): Key => ({ at, offset: [o[0] * depth, o[1] * depth, o[2] * depth], pitch: keyPitch * depth, yaw: 0, roll: roll * depth });
  const keys = [
    key(0, [0, 0, 0], 0, 0),
    key(t.reloadTiltAt, [x, y, z], pitch, tiltRoll),
    key(magOutAt, [x, y - t.reloadMagOutDropM, z], pitch, tiltRoll),
    key(t.reloadHoldAt, [x, y, z], pitch, tiltRoll),
    key(magInAt, [x, y + t.reloadMagInRiseM, z], pitch + t.reloadMagInPitchDeg, tiltRoll),
    key(boltAt, [x, y, z - t.reloadBoltBackM], pitch, t.reloadBoltRollDeg),
    key(1, [0, 0, 0], 0, 0),
  ];
  const heard: Mark[] = [{ at: magOutAt, cue: 'mag-out' }, { at: magInAt, cue: 'mag-in' }, { at: boltAt, cue: 'bolt' }, ...marks];
  return { keys: keys.sort(byPhase), marks: heard.sort(byPhase) };
}

/** A curve's pose at `phase` (0 to 1): between the keys either side of it, eased, as the shovel's stroke is. */
function keyedAt(keys: readonly Key[], phase: number): HandsDelta {
  const p = Math.min(1, Math.max(0, phase));
  let i = 0;
  while (i < keys.length - 2 && p > keys[i + 1].at) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const span = b.at - a.at;
  return lerpHands(a, b, span > 0 ? smooth(Math.min(1, Math.max(0, (p - a.at) / span))) : 1);
}

/**
 * The shotgun's reload at `phase`, loading `shells`: still through the base time, then a push for
 * each shell over its own turn, up to its height at the turn's middle and back by its end.
 */
function shellsAt(t: HandlingTunables, phase: number, shells: number): HandsDelta {
  // How many shells' turns in, after the base.
  const s = (Math.min(1, Math.max(0, phase)) * (t.shellBaseS + shells * t.shellEachS) - t.shellBaseS) / t.shellEachS;
  if (!(s > 0) || s >= shells) return zero();
  const w = (s - Math.floor(s)) * 2;
  const push = w < 1 ? smooth(w) : 1 - smooth(w - 1);
  const o = t.shellPushM;
  return { offset: [o[0] * push, o[1] * push, o[2] * push], pitch: t.shellPitchDeg * push, yaw: 0, roll: 0 };
}

/** Where in the shotgun's reload each shell is pushed in: the middle of its turn. */
function shellMarks(t: HandlingTunables, shells: number): Mark[] {
  const total = t.shellBaseS + shells * t.shellEachS;
  return Array.from({ length: shells }, (_, j) => ({ at: (t.shellBaseS + ((2 * j + 1) * t.shellEachS) / 2) / total, cue: 'shell' as const }));
}

/** The gun in the hands, ticked by the session. */
export class Handling {
  private readonly swayOmega: number;
  private readonly landOmega: number;
  private readonly curves: Record<Exclude<GunClass, 'pump'>, Curve>;
  // The hands' state. Each field starts in one place, reset(), which the constructor calls too: a
  // fresh pair and a pair reset are made alike, and cannot drift apart.
  /** The sprint's blend, 0 to 1: in over sprint_in_s, out over sprint_out_s. */
  private blend!: number;
  /** The sway's springs, aside, up and in roll: each where it is and how fast it moves. */
  private swaySide!: [number, number];
  private swayUp!: [number, number];
  private swayRoll!: [number, number];
  /** The landing's dip, as a share of a full one, and its spring's speed; and whether the body was on the ground last tick. */
  private land!: number;
  private landSpeed!: number;
  private wasOnGround!: boolean;
  /**
   * The aim's blend last tick; the overshoot under way, how long since the sights arrived and the
   * pitch it carries on from (null once it is back at the aim); and the pitch it drew last tick.
   */
  private lastAimed!: number;
  private overshoot!: { t: number; from: number } | null;
  private overshot!: number;
  /** The stride's last phase, and whether this is the second of a pair (the swing across runs over two). */
  private lastBob!: number;
  private secondStride!: boolean;
  /** The reload drawn last tick (with the shells it counted as it began), and its pose; one let go, easing back from where it was. */
  private lastReload!: { phase: number; gun: GunClass; shells: number } | null;
  private lastCurve!: HandsDelta;
  private release!: { from: HandsDelta; t: number } | null;
  /** The last tick's shot clock and gun, for the pump's cue. */
  private lastSinceShot!: number;
  private lastGun!: GunClass | null;
  /** The last two ticks' deltas. */
  private prev!: HandsDelta;
  private cur!: HandsDelta;

  constructor(readonly t: HandlingTunables) {
    this.swayOmega = SETTLE_CONSTANT / Math.max(1e-3, t.swaySettleS);
    this.landOmega = SETTLE_CONSTANT / Math.max(1e-3, t.landingSettleS);
    this.curves = {
      long: magazineCurve(t, t.reloadTiltRollDeg, t.reloadMagOutAt, t.reloadMagInAt, t.reloadBoltAt, 1, []),
      mg: magazineCurve(t, t.reloadTiltRollDeg, t.reloadMagOutAt, t.reloadMagInAt, t.reloadBoltAt, t.mgDepth, [{ at: t.mgCoverAt, cue: 'cover' }]),
      pistol: magazineCurve(t, t.pistolTiltRollDeg, t.pistolMagOutAt, t.pistolMagInAt, t.pistolSlideAt, 1, []),
    };
    this.reset();
  }

  /** The sprint's blend now (0 to 1): no shot leaves while it is at or over `sprintBlocksFire`. */
  get sprint(): number {
    return this.blend;
  }

  /**
   * The hands as a fresh pair's, as the constructor makes them and for a deploy (the session's equip
   * and respawn): no sprint, the sway and the landing at rest (on the ground), no reload drawn or
   * easing back, no overshoot, the stride's pair and the last gun's shot forgotten (so no pump is to
   * come), and both ticks' deltas none. Every field of the state starts here, and only here.
   */
  reset(): void {
    this.blend = 0;
    this.swaySide = [0, 0];
    this.swayUp = [0, 0];
    this.swayRoll = [0, 0];
    this.land = 0;
    this.landSpeed = 0;
    this.wasOnGround = true;
    this.lastAimed = 0;
    this.overshoot = null;
    this.overshot = 0;
    this.lastBob = 0;
    this.secondStride = false;
    this.lastReload = null;
    this.lastCurve = zero();
    this.release = null;
    this.lastSinceShot = Number.POSITIVE_INFINITY;
    this.lastGun = null;
    this.prev = zero();
    this.cur = zero();
  }

  /** The delta as the last tick left it. */
  get delta(): HandsDelta {
    return copy(this.cur);
  }

  /** The delta between the last two ticks, `alpha` of the way. */
  at(alpha: number): HandsDelta {
    return lerpHands(this.prev, this.cur, alpha);
  }

  /** One tick: the delta now, the sprint blend, and the cues crossed this tick (a curve's marks passed between its last phase and this). */
  tick(i: HandlingInput): { delta: HandsDelta; sprint: number; cues: HandlingCue[] } {
    const t = this.t;
    const cues: HandlingCue[] = [];
    const aimed = Math.min(1, Math.max(0, i.aimed));
    const speed = Math.min(1, Math.max(0, i.speedRatio));
    const d = zero();
    const o = d.offset;

    this.blend = i.sprinting ? Math.min(1, this.blend + i.dt / t.sprintInS) : Math.max(0, this.blend - i.dt / t.sprintOutS);
    const sprint = smooth(this.blend);

    // The stride's bob: up and down at its phase, across and rolling at half of it, so the second
    // stride of a pair swings the other way (the body wraps the phase at a turn).
    if (i.bobPhase < this.lastBob - PI) this.secondStride = !this.secondStride;
    this.lastBob = i.bobPhase;
    const across = sin((i.bobPhase + (this.secondStride ? TAU : 0)) / 2);
    const bob = speed * mix(1, t.bobAimed, aimed) * mix(1, t.bobSprint, sprint);
    o[0] += t.bobSideM * across * bob;
    o[1] += t.bobUpM * sin(i.bobPhase) * bob;
    d.roll += t.bobRollDeg * across * bob;

    // The look's sway: trailing the turn, aside and up, and banking into it, as a gun hung from the hands.
    this.swaySide = this.follow(this.swaySide, hold(-t.swayMPerDps * i.yawRate, t.swayMaxM), i.dt);
    this.swayUp = this.follow(this.swayUp, hold(-t.swayMPerDps * i.pitchRate, t.swayMaxM), i.dt);
    this.swayRoll = this.follow(this.swayRoll, hold(-t.swayRollDegPerDps * i.yawRate, t.swayMaxDeg), i.dt);
    const sway = mix(1, t.swayAimed, aimed);
    o[0] += hold(this.swaySide[0], t.swayMaxM) * sway;
    o[1] += hold(this.swayUp[0], t.swayMaxM) * sway;
    d.roll += hold(this.swayRoll[0], t.swayMaxDeg) * sway;

    // Breathing, at rest: gone at a run.
    const breath = Math.max(0, 1 - speed) * mix(1, t.breathAimed, aimed);
    o[0] += t.breathSideM * sin(TAU * t.breathSideHz * i.time) * breath;
    o[1] += t.breathUpM * sin(TAU * t.breathUpHz * i.time) * breath;

    // The sprint: low and across.
    o[0] += t.sprintOffsetM[0] * sprint;
    o[1] += t.sprintOffsetM[1] * sprint;
    o[2] += t.sprintOffsetM[2] * sprint;
    d.pitch += t.sprintPitchDeg * sprint;
    d.yaw += t.sprintYawDeg * sprint;
    d.roll += t.sprintRollDeg * sprint;

    // A landing: dipped on the tick it lands by its share of a hard one (the deeper, if one is
    // still settling), then settling back.
    [this.land, this.landSpeed] = advanceSpring(this.land, this.landSpeed, this.landOmega, t.landingDamping, i.dt);
    if (i.onGround && !this.wasOnGround) {
      const share = Math.min(1, Math.max(0, i.landingImpact / t.landingHardMps));
      if (share > this.land) {
        this.land = share;
        this.landSpeed = 0;
      }
    }
    this.wasOnGround = i.onGround;
    o[1] -= t.landingDropM * this.land;
    d.pitch += t.landingPitchDeg * this.land;

    // An aim-in: as the sights arrive (the aim's blend reaching 1), the muzzle is carried on past the
    // aim from that tick, at a steady rate to aim_overshoot_deg over aim_overshoot_rise_s, then eased
    // back to it, as a reload let go is, until aim_overshoot_s after they arrived. The sights arrive
    // with no speed, so it starts from nothing rather than all at once, which would pop; arriving
    // again while it is drawn, it carries on up from where it is.
    if (aimed >= 1 && this.lastAimed < 1) this.overshoot = { t: 0, from: this.overshot };
    this.lastAimed = aimed;
    this.overshot = 0;
    if (this.overshoot !== null) {
      const o = this.overshoot;
      o.t += i.dt;
      if (o.t >= t.aimOvershootS) {
        this.overshoot = null;
      } else {
        const peak = t.aimOvershootDeg;
        const rise = t.aimOvershootRiseS;
        this.overshot = o.t < rise ? o.from + (peak - o.from) * (o.t / rise) : peak * (1 - smooth((o.t - rise) / (t.aimOvershootS - rise)));
        d.pitch += this.overshot;
      }
    }

    addScaled(d, this.reloadPose(i, cues), 1);

    // The pump, after a shot: back over its stroke, forward over as long again.
    if (i.gun === 'pump') {
      const s = i.sinceShot - t.pumpAfterS;
      const back = s < 0 ? 0 : s < t.pumpStrokeS ? smooth(s / t.pumpStrokeS) : s < 2 * t.pumpStrokeS ? 1 - smooth(s / t.pumpStrokeS - 1) : 0;
      o[2] -= t.pumpBackM * back;
      if (this.lastGun === 'pump' && this.lastSinceShot < t.pumpAfterS && t.pumpAfterS <= i.sinceShot) cues.push('pump');
    }
    this.lastSinceShot = i.sinceShot;
    this.lastGun = i.gun;

    this.prev = this.cur;
    this.cur = d;
    return { delta: copy(this.cur), sprint: this.blend, cues };
  }

  /** A sway spring's step toward `target`, held there over the tick. */
  private follow(s: [number, number], target: number, dt: number): [number, number] {
    const [x, v] = advanceSpring(s[0] - target, s[1], this.swayOmega, this.t.swayDamping, dt);
    return [target + x, v];
  }

  /**
   * The reload's curve at this tick's phase, the marks passed since the last heard, and what is
   * left of one let go: cut short, ended, or begun afresh over, it eases back to rest from where it
   * was drawn over reload_cut_s, never snapping. The shotgun's shells are counted as its reload
   * begins and kept for the whole of it, so a count read differently part-way moves no push or mark.
   */
  private reloadPose(i: HandlingInput, cues: HandlingCue[]): HandsDelta {
    const r = i.reload;
    const last = this.lastReload;
    const going = last !== null && r !== null && r.phase >= last.phase && i.gun === last.gun;
    if (last && !going) this.letGo();
    const out = zero();
    if (r) {
      const shells = going ? last.shells : Math.max(0, Math.floor(r.shells));
      const curve = i.gun === 'pump' ? null : this.curves[i.gun];
      const marks = curve ? curve.marks : shellMarks(this.t, shells);
      const from = going ? last.phase : 0;
      for (const m of marks) if (from < m.at && m.at <= r.phase) cues.push(m.cue);
      this.lastCurve = curve ? keyedAt(curve.keys, r.phase) : shellsAt(this.t, r.phase, shells);
      this.lastReload = { phase: r.phase, gun: i.gun, shells };
      addScaled(out, this.lastCurve, 1);
    } else {
      this.lastReload = null;
    }
    if (this.release) {
      this.release.t += i.dt;
      const left = this.left(this.release);
      addScaled(out, this.release.from, left);
      if (left <= 0) this.release = null;
    }
    return out;
  }

  /** Let the curve drawn last go, with whatever is still left of one let go before it. */
  private letGo(): void {
    const from = copy(this.lastCurve);
    if (this.release) addScaled(from, this.release.from, this.left(this.release));
    this.release = { from, t: 0 };
    this.lastCurve = zero();
  }

  /** How much of a curve let go is left: all of it, easing to none over reload_cut_s. */
  private left(release: { t: number }): number {
    return 1 - smooth(Math.min(1, release.t / this.t.reloadCutS));
  }
}
