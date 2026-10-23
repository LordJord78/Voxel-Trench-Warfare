/**
 * The view kick, ported from the reference's `combat/viewkick.py`: everything
 * felt of a shot and nothing that moves the round. The aim belongs to
 * recoil.ts; this is the impression — the viewmodel's punch back, up, aside
 * and in pitch, yaw and roll, and a pulse of the field of view. Nothing here is
 * read back by ballistics or the world: delete it and every round lands where
 * it did. Weight can be spent freely here, where it costs only taste, while the
 * aim stays light and honest.
 *
 * The same shot drives both layers on the same tick, and the viewmodel's pitch
 * follows the aim's kick, so the two never read as two guns; they settle in
 * near the same time. Every channel is displaced by a shot (its peak on the
 * shot's tick) and pulled back by its own damped spring; the rifle's springs
 * are a little under critical, so the viewmodel overshoots on its way home.
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
];

/** `[viewkick.defaults]` overlaid by `[viewkick.<weapon>]`; a field neither holds is named. */
export function viewKickProfile(tun: Tunables, weapon: string): ViewKickProfile {
  const values: Record<string, unknown> = { ...tun.section('viewkick.defaults'), ...tun.section(`viewkick.${weapon}`) };
  const missing = FIELDS.filter(([, key]) => !(key in values)).map(([, key]) => key);
  if (missing.length) throw new Error(`view kick '${weapon}' is missing ${missing.join(', ')}: add them to [viewkick.${weapon}] or [viewkick.defaults]`);
  return Object.fromEntries(FIELDS.map(([field, key]) => [field, Number(values[key])])) as unknown as ViewKickProfile;
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
  private readonly velocity: Record<Channel, number> = { back: 0, up: 0, side: 0, pitch: 0, yaw: 0, roll: 0 };
  private fovVelocity = 0;
  private readonly omega: number;
  private readonly fovOmega: number;

  constructor(readonly profile: ViewKickProfile) {
    this.omega = SETTLE_CONSTANT / Math.max(1e-3, profile.settleS);
    this.fovOmega = SETTLE_CONSTANT / Math.max(1e-3, profile.fovSettleS);
  }

  /** One round has gone off, the aim kicked by `aimKickDeg`: six draws, in channel order. */
  shot(aimKickDeg: number, rng: Rng): void {
    const p = this.profile;
    const punch: Record<Channel, number> = { back: p.punchBackM, up: p.punchUpM, side: p.punchSideM, pitch: p.punchPitchDeg, yaw: p.punchYawDeg, roll: p.punchRollDeg };
    for (const c of CHANNELS) {
      const draw = p.jitterScale > 0 ? rng.uniform(-Math.abs(punch[c]) * p.jitterScale, Math.abs(punch[c]) * p.jitterScale) : 0;
      this[c] += (punch[c] + (c === 'pitch' ? aimKickDeg * p.aimPitchFollow : 0) + draw) * this.scale;
    }
    this.fovOffset += p.fovPulseDeg * this.scale;
  }

  tick(dt: number): void {
    const p = this.profile;
    for (const c of CHANNELS) [this[c], this.velocity[c]] = advanceSpring(this[c], this.velocity[c], this.omega, p.damping, dt);
    [this.fovOffset, this.fovVelocity] = advanceSpring(this.fovOffset, this.fovVelocity, this.fovOmega, p.fovDamping, dt);
  }
}
