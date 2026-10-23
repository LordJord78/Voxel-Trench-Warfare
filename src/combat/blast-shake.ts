/**
 * A shell's shake of the view (milestone 4's plan, ruling 8): a kick whose
 * size falls with the blast's distance as (1 − d / `shake_radius_m`)², the
 * larger of it and what is left of the last, dying away exponentially over
 * `shake_decay_s`, a wobble at `shake_hz` in pitch and roll. Cosmetic: the
 * camera's alone, as suppression's shake is, never the aim's.
 */

import { exp, sin } from '../core/dmath';
import type { Tunables } from '../core/tunables';

export interface BlastShakeTunables {
  /** Degrees, for a blast at the head. */
  deg: number;
  radiusM: number;
  decayS: number;
  hz: number;
}

export function blastShakeTunables(tun: Tunables): BlastShakeTunables {
  return { deg: tun.f('artillery.shake_deg'), radiusM: tun.f('artillery.shake_radius_m'), decayS: tun.f('artillery.shake_decay_s'), hz: tun.f('artillery.shake_hz') };
}

const TAU = 2 * Math.PI;
/** Degrees under which a shake is over. */
const STILL = 1e-4;

export class BlastShake {
  /** Degrees, now. */
  amplitude = 0;
  private phase = 0;

  constructor(readonly t: BlastShakeTunables) {}

  /** A blast `distanceM` from the head. */
  kick(distanceM: number): void {
    if (!(distanceM < this.t.radiusM)) return;
    const near = 1 - distanceM / this.t.radiusM;
    this.amplitude = Math.max(this.amplitude, this.t.deg * near * near);
  }

  tick(dt: number): void {
    this.amplitude *= exp(-dt / Math.max(1e-3, this.t.decayS));
    if (this.amplitude < STILL) this.amplitude = 0;
    this.phase = this.amplitude > 0 ? (this.phase + dt * this.t.hz * TAU) % TAU : 0;
  }

  /** Degrees of pitch and roll. */
  get pitch(): number {
    return sin(this.phase * 1.3) * this.amplitude;
  }

  get roll(): number {
    return sin(this.phase) * this.amplitude * 0.6;
  }
}
