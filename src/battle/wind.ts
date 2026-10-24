/**
 * The wind over the battle (the battle spec's §1): one wind for the whole map,
 * which carries the flares and leans the smoke. It is a pure function of time:
 * its bearing the prevailing one plus two slow sines (together at most
 * `veer_deg`), its speed the middle of its bounds plus two gust sines, kept
 * within them. A drift is its integral, by the midpoint rule in quarter
 * seconds, so a flare's place at any moment needs no stepping to it.
 */

import { cos, radians, sin } from '../core/dmath';
import type { Rng } from '../core/rng';
import type { Tunables } from '../core/tunables';

export interface WindTunables {
  /** The bearing it blows toward, degrees as yaw (0 = +z, 90 = +x). */
  prevailingDeg: number;
  veerDeg: number;
  veerPeriodS: [number, number];
  speedMps: [number, number];
  gustMps: number;
  gustPeriodS: [number, number];
}

export function windTunables(tun: Tunables): WindTunables {
  return {
    prevailingDeg: tun.f('battle.wind.prevailing_deg'),
    veerDeg: tun.f('battle.wind.veer_deg'),
    veerPeriodS: tun.pair('battle.wind.veer_period_s'),
    speedMps: tun.pair('battle.wind.speed_mps'),
    gustMps: tun.f('battle.wind.gust_mps'),
    gustPeriodS: tun.pair('battle.wind.gust_period_s'),
  };
}

/** Seconds a drift's midpoint rule steps by. */
const STEP_S = 0.25;
const TAU = 2 * Math.PI;

/** A sine's share of its pair's amplitude, its angular frequency and its phase. */
type Sine = readonly [number, number, number];

export class Wind {
  private readonly veer: readonly Sine[];
  private readonly gust: readonly Sine[];

  constructor(
    readonly t: WindTunables,
    rng: Rng,
  ) {
    const sines = (period: readonly [number, number]): Sine[] =>
      [0.6, 0.4].map((share) => [share, TAU / rng.uniform(period[0], period[1]), rng.uniform(0, TAU)] as const);
    this.veer = sines(t.veerPeriodS);
    this.gust = sines(t.gustPeriodS);
  }

  /** The wind at `seconds`, metres a second along x and z. */
  at(seconds: number): [number, number] {
    let veer = 0;
    for (const [share, w, phase] of this.veer) veer += share * sin(w * seconds + phase);
    let gust = 0;
    for (const [share, w, phase] of this.gust) gust += share * sin(w * seconds + phase);
    const [lo, hi] = this.t.speedMps;
    const speed = Math.min(hi, Math.max(lo, (lo + hi) / 2 + this.t.gustMps * gust));
    const bearing = radians(this.t.prevailingDeg + this.t.veerDeg * veer);
    return [speed * sin(bearing), speed * cos(bearing)];
  }

  /** Metres the wind carries something along x and z from `t0` to `t1` (seconds). */
  drift(t0: number, t1: number): [number, number] {
    if (t1 <= t0) return [0, 0];
    const n = Math.ceil((t1 - t0) / STEP_S);
    const h = (t1 - t0) / n;
    let x = 0;
    let z = 0;
    for (let k = 0; k < n; k++) {
      const v = this.at(t0 + (k + 0.5) * h);
      x += v[0] * h;
      z += v[1] * h;
    }
    return [x, z];
  }
}
