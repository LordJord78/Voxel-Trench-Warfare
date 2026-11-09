/**
 * The view kick, ported from the reference's `combat/viewkick.py`: everything
 * felt of a shot and nothing that moves the round. The aim belongs to
 * recoil.ts; this is the impression — the viewmodel's punch back, up, aside
 * and in pitch, yaw and roll, a pulse of the field of view, and the camera's
 * own roll and shake. Nothing here is read back by ballistics or the world:
 * delete it and every round lands where it did. Weight can be spent freely
 * here, where it costs only taste, while the aim stays light and honest.
 *
 * The same shot drives both layers on the same tick, and the viewmodel's pitch
 * follows the aim's kick, so the two never read as two guns; they settle in
 * near the same time. Every channel is displaced by a shot (its peak on the
 * shot's tick) and pulled back by its own damped spring; the rifle's springs
 * are a little under critical, so the viewmodel overshoots on its way home.
 *
 * The camera's two channels (the shots spec's §3) turn the view and move the
 * eye, never the round, which leaves along the aim: a roll about the line of
 * sight, kicked to a side drawn for each shot and back to level on a spring of
 * its own; and a shake, the eye moved and turned by a fresh draw each tick for
 * `cam_shake_s` after a shot, then still. Their draws come from a stream of
 * their own, passed in, so the viewmodel's six draws a shot are as they were.
 * `[viewkick.defaults]` overlaid by `[viewkick.<weapon>]`; no magnitude here.
 */

import type { Rng } from '../core/rng';
import type { Tunables } from '../core/tunables';
import { advanceSpring, SETTLE_CONSTANT } from './spring';

export interface ViewKickProfile {
  punchBackM: number;
  punchUpM: number;
  punchSideM: number;
  punchPitchDeg: number;
  punchYawDeg: number;
  punchRollDeg: number;
  /** How much of the aim's kick the viewmodel's pitch follows. */
  aimPitchFollow: number;
  settleS: number;
  damping: number;
  fovPulseDeg: number;
  fovSettleS: number;
  fovDamping: number;
  /** Each channel's draw, as a fraction of its punch. */
  jitterScale: number;
  /** The camera's roll a shot (degrees, its side drawn), back to level over its settling time on a spring of this damping. */
  camRollDeg: number;
  camRollSettleS: number;
  camRollDamping: number;
  /** The camera's shake after a shot: the eye moved up to this on each axis (metres) and turned up to this in pitch and yaw (degrees), drawn afresh each tick for this long (seconds). */
  camShakeM: number;
  camShakeDeg: number;
  camShakeS: number;
}

const FIELDS: readonly [keyof ViewKickProfile, string][] = [
  ['punchBackM', 'punch_back_m'],
  ['punchUpM', 'punch_up_m'],
  ['punchSideM', 'punch_side_m'],
  ['punchPitchDeg', 'punch_pitch_deg'],
  ['punchYawDeg', 'punch_yaw_deg'],
  ['punchRollDeg', 'punch_roll_deg'],
  ['aimPitchFollow', 'aim_pitch_follow'],
  ['settleS', 'settle_time_s'],
  ['damping', 'damping_ratio'],
  ['fovPulseDeg', 'fov_pulse_deg'],
  ['fovSettleS', 'fov_settle_s'],
  ['fovDamping', 'fov_damping_ratio'],
  ['jitterScale', 'jitter_scale'],
  ['camRollDeg', 'cam_roll_deg'],
  ['camRollSettleS', 'cam_roll_settle_s'],
  ['camRollDamping', 'cam_roll_damping_ratio'],
  ['camShakeM', 'cam_shake_m'],
  ['camShakeDeg', 'cam_shake_deg'],
  ['camShakeS', 'cam_shake_s'],
];

/** `[viewkick.defaults]` overlaid by `[viewkick.<weapon>]`; a field neither holds is named. */
export function viewKickProfile(tun: Tunables, weapon: string): ViewKickProfile {
  const values: Record<string, unknown> = { ...tun.section('viewkick.defaults'), ...tun.section(`viewkick.${weapon}`) };
  const missing = FIELDS.filter(([, key]) => !(key in values)).map(([, key]) => key);
  if (missing.length) throw new Error(`view kick '${weapon}' is missing ${missing.join(', ')}: add them to [viewkick.${weapon}] or [viewkick.defaults]`);
  return Object.fromEntries(FIELDS.map(([field, key]) => [field, Number(values[key])])) as unknown as ViewKickProfile;
}

/** The camera's shake: the eye's offset (metres, along the world's axes: a shake keeps no direction) and its turns (degrees). */
export interface CameraShake {
  offset: [number, number, number];
  pitch: number;
  yaw: number;
}

type Channel = 'back' | 'up' | 'side' | 'pitch' | 'yaw' | 'roll';
const CHANNELS: readonly Channel[] = ['back', 'up', 'side', 'pitch', 'yaw', 'roll'];

export class ViewKick {
  /** The shot's scale (the reference never changed it). */
  scale = 1;
  back = 0;
  up = 0;
  side = 0;
  pitch = 0;
  yaw = 0;
  roll = 0;
  /** Degrees added to the field of view. */
  fovOffset = 0;
  /** Degrees the camera is rolled about the line of sight (its right side up). */
  camRoll = 0;
  /** The camera's shake now: still but for cam_shake_s after a shot. */
  readonly shake: CameraShake = { offset: [0, 0, 0], pitch: 0, yaw: 0 };
  private readonly velocity: Record<Channel, number> = { back: 0, up: 0, side: 0, pitch: 0, yaw: 0, roll: 0 };
  private fovVelocity = 0;
  private camRollVelocity = 0;
  /** Seconds since the last shot. */
  private sinceShot = Number.POSITIVE_INFINITY;
  private readonly omega: number;
  private readonly fovOmega: number;
  private readonly camRollOmega: number;

  constructor(readonly profile: ViewKickProfile) {
    this.omega = SETTLE_CONSTANT / Math.max(1e-3, profile.settleS);
    this.fovOmega = SETTLE_CONSTANT / Math.max(1e-3, profile.fovSettleS);
    this.camRollOmega = SETTLE_CONSTANT / Math.max(1e-3, profile.camRollSettleS);
  }

  /**
   * One round has gone off, the aim kicked by `aimKickDeg`: six draws from `rng`, in channel order;
   * then from `camera`, the camera's own stream, the roll's side and the shake's first draw.
   */
  shot(aimKickDeg: number, rng: Rng, camera: Rng): void {
    const p = this.profile;
    const punch: Record<Channel, number> = { back: p.punchBackM, up: p.punchUpM, side: p.punchSideM, pitch: p.punchPitchDeg, yaw: p.punchYawDeg, roll: p.punchRollDeg };
    for (const c of CHANNELS) {
      const draw = p.jitterScale > 0 ? rng.uniform(-Math.abs(punch[c]) * p.jitterScale, Math.abs(punch[c]) * p.jitterScale) : 0;
      this[c] += (punch[c] + (c === 'pitch' ? aimKickDeg * p.aimPitchFollow : 0) + draw) * this.scale;
    }
    this.fovOffset += p.fovPulseDeg * this.scale;
    this.camRoll += (camera.randint(0, 2) * 2 - 1) * p.camRollDeg * this.scale;
    this.sinceShot = 0;
    this.shaken(camera);
  }

  /** A tick: every spring toward rest, and the shake drawn afresh while a shot's lasts (from `camera`), or still. */
  tick(dt: number, camera: Rng): void {
    const p = this.profile;
    for (const c of CHANNELS) [this[c], this.velocity[c]] = advanceSpring(this[c], this.velocity[c], this.omega, p.damping, dt);
    [this.fovOffset, this.fovVelocity] = advanceSpring(this.fovOffset, this.fovVelocity, this.fovOmega, p.fovDamping, dt);
    [this.camRoll, this.camRollVelocity] = advanceSpring(this.camRoll, this.camRollVelocity, this.camRollOmega, p.camRollDamping, dt);
    this.sinceShot += dt;
    this.shaken(camera);
  }

  /** The shake for now: while a shot's lasts, a fresh draw on each axis and in pitch and yaw, within cam_shake_m and cam_shake_deg (by the shot's scale); still after. */
  private shaken(camera: Rng): void {
    const p = this.profile;
    const s = this.shake;
    if (this.sinceShot < p.camShakeS) {
      const m = p.camShakeM * this.scale;
      const deg = p.camShakeDeg * this.scale;
      for (let k = 0; k < 3; k++) s.offset[k] = camera.jitter(m);
      s.pitch = camera.jitter(deg);
      s.yaw = camera.jitter(deg);
    } else {
      s.offset[0] = s.offset[1] = s.offset[2] = 0;
      s.pitch = s.yaw = 0;
    }
  }
}
