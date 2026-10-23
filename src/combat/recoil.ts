/**
 * Recoil, ported from the reference's `combat/recoil.py`: a shared impulse and
 * a damped spring, the aim's offset (it moves the round). A weapon's character
 * is entirely its numbers, `[recoil.defaults]` overlaid by `[recoil.<weapon>]`;
 * no magnitude is written here.
 *
 * Two terms, recovering on different timescales:
 *  - the kick is the snap: each round displaces a spring anchored at zero, so
 *    the muzzle is at its peak on the tick the round leaves and every tick
 *    after is recovery — small and fast, never fought;
 *  - the climb is the pattern: each round adds to an offset that approaches a
 *    ceiling, bleeds off once the trigger rests, and after `drift_onset_shots`
 *    walks sideways too.
 *
 * Its `scale` is the stance's sway: prone shoulders more of each round.
 */

import { exp } from '../core/dmath';
import type { Rng } from '../core/rng';
import type { Tunables } from '../core/tunables';
import { advanceSpring, SETTLE_CONSTANT } from './spring';

export interface RecoilProfile {
  kickPitchDeg: number;
  kickYawDeg: number;
  settleS: number;
  /** The damping ratio: 1 is critically damped, fastest back with no bounce. */
  damping: number;
  climbCeilingDeg: number;
  climbPerShotDeg: number;
  climbRecoveryS: number;
  driftYawDeg: number;
  driftOnsetShots: number;
  driftRampShots: number;
  jitterPitchDeg: number;
  jitterYawDeg: number;
  burstResetS: number;
}

const FIELDS: readonly [keyof RecoilProfile, string][] = [
  ['kickPitchDeg', 'kick_pitch_deg'],
  ['kickYawDeg', 'kick_yaw_deg'],
  ['settleS', 'settle_time_s'],
  ['damping', 'damping_ratio'],
  ['climbCeilingDeg', 'climb_ceiling_deg'],
  ['climbPerShotDeg', 'climb_per_shot_deg'],
  ['climbRecoveryS', 'climb_recovery_s'],
  ['driftYawDeg', 'drift_yaw_deg'],
  ['driftOnsetShots', 'drift_onset_shots'],
  ['driftRampShots', 'drift_ramp_shots'],
  ['jitterPitchDeg', 'jitter_pitch_deg'],
  ['jitterYawDeg', 'jitter_yaw_deg'],
  ['burstResetS', 'burst_reset_s'],
];

/** `[recoil.defaults]` overlaid by `[recoil.<weapon>]`; a field neither holds is named. */
export function recoilProfile(tun: Tunables, weapon: string): RecoilProfile {
  const values: Record<string, unknown> = { ...tun.section('recoil.defaults'), ...tun.section(`recoil.${weapon}`) };
  const missing = FIELDS.filter(([, key]) => !(key in values)).map(([, key]) => key);
  if (missing.length) throw new Error(`recoil profile '${weapon}' is missing ${missing.join(', ')}: add them to [recoil.${weapon}] or [recoil.defaults]`);
  return Object.fromEntries(FIELDS.map(([field, key]) => [field, Number(values[key])])) as unknown as RecoilProfile;
}

export class Recoil {
  /** The stance's sway: it scales each round's kick, climb and drift. */
  scale = 1;
  /** Rounds in the current burst, which the pattern is a function of. */
  shots = 0;
  sinceShot = Infinity;
  kickPitch = 0;
  kickYaw = 0;
  climbPitch = 0;
  climbYaw = 0;
  private kickPitchVel = 0;
  private kickYawVel = 0;
  private readonly omega: number;

  constructor(readonly profile: RecoilProfile) {
    this.omega = SETTLE_CONSTANT / Math.max(1e-3, profile.settleS);
  }

  /** One round has gone off. */
  shot(rng: Rng): void {
    const p = this.profile;
    if (this.sinceShot > p.burstResetS) this.shots = 0;
    this.sinceShot = 0;
    this.shots++;
    this.kickPitch += (p.kickPitchDeg + jitter(rng, p.jitterPitchDeg)) * this.scale;
    this.kickYaw += (p.kickYawDeg + jitter(rng, p.jitterYawDeg)) * this.scale;
    const headroom = 1 - Math.abs(this.climbPitch) / Math.max(1e-6, p.climbCeilingDeg);
    this.climbPitch += p.climbPerShotDeg * Math.max(0, headroom) * this.scale;
    const gain = (this.shots - p.driftOnsetShots) / Math.max(1e-6, p.driftRampShots);
    this.climbYaw += p.driftYawDeg * Math.min(1, Math.max(0, gain)) * this.scale;
  }

  tick(dt: number): void {
    const p = this.profile;
    this.sinceShot += dt;
    [this.kickPitch, this.kickPitchVel] = advanceSpring(this.kickPitch, this.kickPitchVel, this.omega, p.damping, dt);
    [this.kickYaw, this.kickYawVel] = advanceSpring(this.kickYaw, this.kickYawVel, this.omega, p.damping, dt);
    // The climb bleeds off only once the trigger rests.
    if (this.sinceShot > p.burstResetS && p.climbRecoveryS > 0) {
      const decay = exp(-dt / p.climbRecoveryS);
      this.climbPitch *= decay;
      this.climbYaw *= decay;
    }
  }

  /** Degrees the muzzle is off the player's aim: up, and right. */
  get pitch(): number {
    return this.kickPitch + this.climbPitch;
  }

  get yaw(): number {
    return this.kickYaw + this.climbYaw;
  }
}

function jitter(rng: Rng, magnitude: number): number {
  return magnitude > 0 ? rng.uniform(-magnitude, magnitude) : 0;
}
