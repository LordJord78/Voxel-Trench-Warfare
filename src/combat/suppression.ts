/**
 * Suppression, ported from the reference's `combat/suppression.py`: being shot
 * at, with nothing hitting you. Most rounds miss at trench ranges, and the ones
 * that miss do the work.
 *
 * Two things raise it. A crack — a supersonic round passing within
 * `crack_radius_m` of the head, measured along each substep's flight segment,
 * since a round covers metres a substep — adds `crack_amount` × nearness² and
 * flinches the aim up and aside. An impact nearby adds less: dirt kicked up
 * beside you frightens, a crack past your ear also says they have your range.
 * The level holds briefly after each event, so a burst does not bleed off
 * mid-burst, then decays.
 *
 * What it does, in order of how much it is felt: slows your feet, shakes your
 * aim apart (the cone grows toward `sway_at_full`), takes you off the firing
 * step and the periscope (`eject_from_step_at`), and greys the picture. The
 * first three are simulation; the last is the renderer's. Deterministic: the
 * only draw is the flinch's sideways pull.
 */

import { exp, sin } from '../core/dmath';
import type { Rng } from '../core/rng';
import type { Tunables } from '../core/tunables';

export interface SuppressionTunables {
  crackRadiusM: number;
  crackAmount: number;
  impactRadiusM: number;
  impactAmount: number;
  decayPerS: number;
  holdS: number;
  maxLevel: number;
  swayAtFull: number;
  speedAtFull: number;
  flinchDeg: number;
  flinchRecoveryS: number;
  ejectFromStepAt: number;
  shakeDegAtFull: number;
  shakeHz: number;
  desaturateAtFull: number;
  vignetteAtFull: number;
}

export function suppressionTunables(tun: Tunables): SuppressionTunables {
  const f = (k: string) => tun.f(`suppression.${k}`);
  return {
    crackRadiusM: f('crack_radius_m'),
    crackAmount: f('crack_amount'),
    impactRadiusM: f('impact_radius_m'),
    impactAmount: f('impact_amount'),
    decayPerS: f('decay_per_s'),
    holdS: f('hold_s'),
    maxLevel: f('max_level'),
    swayAtFull: f('sway_at_full'),
    speedAtFull: f('speed_at_full'),
    flinchDeg: f('flinch_deg'),
    flinchRecoveryS: f('flinch_recovery_s'),
    ejectFromStepAt: f('eject_from_step_at'),
    shakeDegAtFull: f('shake_deg_at_full'),
    shakeHz: f('shake_hz'),
    desaturateAtFull: f('desaturate_at_full'),
    vignetteAtFull: f('vignette_at_full'),
  };
}

/** The closest approach of the segment a → b to point p. */
export function segmentDistance(a: readonly number[], b: readonly number[], p: readonly number[]): number {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const lengthSq = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  let t = 0;
  if (lengthSq >= 1e-12) t = Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / lengthSq));
  const q = [a[0] + d[0] * t - p[0], a[1] + d[1] * t - p[1], a[2] + d[2] * t - p[2]];
  return Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2]);
}

const TAU = 2 * Math.PI;

export class Suppression {
  level = 0;
  flinchPitch = 0;
  flinchYaw = 0;
  cracks = 0;
  impacts = 0;
  private sinceEvent = Infinity;
  private shakePhase = 0;

  constructor(readonly t: SuppressionTunables) {}

  /** A round went past at `missM` metres. */
  crack(missM: number, rng: Rng): void {
    if (missM > this.t.crackRadiusM) return;
    // Closer is worse, and not linearly: a round that parts your hair is far worse than one two metres off.
    const nearness = 1 - missM / this.t.crackRadiusM;
    this.add(this.t.crackAmount * nearness * nearness);
    this.cracks++;
    const flinch = this.t.flinchDeg * nearness;
    this.flinchPitch += flinch;
    this.flinchYaw += rng.uniform(-flinch, flinch);
  }

  /** Something struck `distanceM` metres from the head. */
  impact(distanceM: number): void {
    if (distanceM > this.t.impactRadiusM) return;
    const nearness = 1 - distanceM / this.t.impactRadiusM;
    this.add(this.t.impactAmount * nearness * nearness);
    this.impacts++;
  }

  tick(dt: number): void {
    this.sinceEvent += dt;
    if (this.sinceEvent >= this.t.holdS) this.level = Math.max(0, this.level - this.t.decayPerS * dt);
    const decay = exp(-dt / Math.max(1e-3, this.t.flinchRecoveryS));
    this.flinchPitch *= decay;
    this.flinchYaw *= decay;
    this.shakePhase = this.level > 0 ? (this.shakePhase + dt * this.t.shakeHz * TAU) % TAU : 0;
  }

  /** Movement's scale: 1 at rest, `speed_at_full` at full. */
  get speedScale(): number {
    return this.blend(this.t.speedAtFull);
  }

  /** The cone's scale: 1 at rest, `sway_at_full` at full. */
  get swayScale(): number {
    return this.blend(this.t.swayAtFull);
  }

  /** Too suppressed to keep your head up: off the firing step and the periscope. */
  get pinned(): boolean {
    return this.level >= this.t.ejectFromStepAt;
  }

  /** The camera's shake, degrees of pitch and roll. */
  get shake(): { pitch: number; roll: number } {
    const amount = this.t.shakeDegAtFull * this.level;
    if (amount <= 0) return { pitch: 0, roll: 0 };
    return { pitch: sin(this.shakePhase * 1.7) * amount, roll: sin(this.shakePhase) * amount * 0.7 };
  }

  get desaturation(): number {
    return this.t.desaturateAtFull * this.level;
  }

  get vignette(): number {
    return this.t.vignetteAtFull * this.level;
  }

  private add(amount: number): void {
    this.level = Math.min(this.t.maxLevel, this.level + amount);
    this.sinceEvent = 0;
  }

  private blend(atFull: number): number {
    return 1 + (atFull - 1) * this.level;
  }
}
