/**
 * The front: incoming fire from the enemy line, with no squad, no AI and no
 * damage behind it — a scheduler that fires rounds at the player so their
 * near misses suppress (suppression.ts). The reference had a tuning rig for
 * this and promised it would go when a squad exists; sub-project 4 builds the
 * battle around the player on the same rounds.
 *
 * Off, light or heavy (`[front]`). Light is aimed single shots at drawn
 * intervals, never nearer each other than `light_gap_s`, each round aimed at a
 * ring about the head so it passes no nearer than `light_miss_m`: heard and
 * felt, never pinning (the spec's light). Heavy is a machine gun's bursts at
 * its cyclic rate, with drawn pauses that bring its mean to `heavy_rpm`, every
 * fifth round a tracer, scattered about the head as the reference's rig did:
 * `spread_m` sideways and `spread_vertical` of it up and down. Each round
 * leaves from where the source says (an enemy bay's crest in a generated
 * world; a line at a set distance in a test's), and its scatter is taken
 * across its line of fire, so a bay far along the line scatters as one
 * straight ahead does.
 */

import { cos, log, sin } from '../core/dmath';
import type { Rng } from '../core/rng';
import type { Tunables } from '../core/tunables';
import type { WorldPlan } from '../world/generation/plan';
import type { ProjectileSpec, Rounds } from './ballistics';

export type Intensity = 'off' | 'light' | 'heavy';

export interface FrontTunables {
  lightRpm: number;
  lightGapS: number;
  lightMissM: number;
  heavyRpm: number;
  burstRounds: number;
  burstRpm: number;
  tracerEvery: number;
  spreadM: number;
  spreadVertical: number;
  reachM: number;
}

export function frontTunables(tun: Tunables): FrontTunables {
  return {
    lightRpm: tun.f('front.light_rpm'),
    lightGapS: tun.f('front.light_gap_s'),
    lightMissM: tun.f('front.light_miss_m'),
    heavyRpm: tun.f('front.heavy_rpm'),
    burstRounds: tun.i('front.burst_rounds'),
    burstRpm: tun.f('front.burst_rpm'),
    tracerEvery: tun.i('front.tracer_every'),
    spreadM: tun.f('front.spread_m'),
    spreadVertical: tun.f('front.spread_vertical'),
    reachM: tun.f('front.reach_m'),
  };
}

/** Where the front fires from at `target` (metres): a muzzle, or null to hold fire. */
export type FrontSource = (target: readonly [number, number, number], rng: Rng) => [number, number, number] | null;

/** The reference's rig, for a world without a plan: a line `rangeM` off along +z, rounds 0.4–1.2 m over `groundY`. */
export function lineSource(rangeM: number, groundY: number): FrontSource {
  return (target, rng) => [target[0] + rng.uniform(-20, 20), groundY + rng.uniform(0.4, 1.2), target[2] + rng.uniform(0.7 * rangeM, rangeM)];
}

/** A generated world's enemy front line: a bay within `reachM` of the target along the line, the round from 0.4–1.2 m over its crest. */
export function planSource(plan: WorldPlan, reachM: number): FrontSource {
  const line = plan.lines.find((l) => l.spec.side === 1 && l.spec.firingSteps);
  const v = plan.params.voxel;
  return (target, rng) => {
    if (!line) return null;
    const near = line.bays.filter((b) => {
      const along = b.longAxis === 0 ? target[0] : target[2];
      return Math.abs(((b.a0 + b.a1) / 2) * v - along) <= reachM;
    });
    if (near.length === 0) return null;
    const bay = near[rng.randint(0, near.length)];
    const a = rng.uniform(bay.a0, bay.a1) * v;
    const b = (bay.facing > 0 ? bay.b1 : bay.b0) * v;
    const y = bay.crestY * v + rng.uniform(0.4, 1.2);
    return bay.longAxis === 0 ? [a, y, b] : [b, y, a];
  };
}

const TAU = 2 * Math.PI;

export class Front {
  intensity: Intensity = 'off';
  /** Time to the next round, and where a burst is: rounds left in it. */
  private wait = 0;
  private burstLeft = 0;
  private fired = 0;

  constructor(
    readonly t: FrontTunables,
    private readonly source: FrontSource,
    private readonly rng: Rng,
  ) {}

  /** One tick: the rounds this intensity owes, fired at `target` into `rounds`; how many left. */
  tick(dt: number, target: readonly [number, number, number], rounds: Rounds, spec: ProjectileSpec): number {
    let shots = 0;
    let tracers = false;
    if (this.intensity === 'light') {
      // Due now, then the tick passes: the next no sooner than light_gap_s, the rest drawn.
      while (this.wait <= 1e-9) {
        shots++;
        this.wait += this.t.lightGapS + this.drawn(60 / this.t.lightRpm - this.t.lightGapS);
      }
      this.wait -= dt;
    } else if (this.intensity === 'heavy') {
      tracers = true;
      // Due now, then the tick passes: a burst's rounds fall 60/burst_rpm apart from its first.
      while (this.wait <= 1e-9) {
        if (this.burstLeft === 0) this.burstLeft = this.t.burstRounds;
        shots++;
        this.burstLeft--;
        const cyclic = 60 / this.t.burstRpm;
        // The pause after a burst is drawn about the mean that brings the rate to heavy_rpm.
        this.wait += this.burstLeft === 0 ? cyclic + this.drawn(this.t.burstRounds * (60 / this.t.heavyRpm - cyclic)) : cyclic;
      }
      this.wait -= dt;
    } else {
      this.burstLeft = 0;
      this.wait = 0;
    }
    let fired = 0;
    for (let k = 0; k < shots; k++) {
      const origin = this.source(target, this.rng);
      if (!origin) continue;
      const aim = this.aimAt(origin, target);
      const d = [aim[0] - origin[0], aim[1] - origin[1], aim[2] - origin[2]];
      const len = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
      if (!(len > 0)) continue;
      const s = spec.muzzleVelocity / len;
      this.fired++;
      const tracer = tracers && this.t.tracerEvery > 0 && this.fired % this.t.tracerEvery === 0;
      if (rounds.fire(origin, [d[0] * s, d[1] * s, d[2] * s], spec, 1, tracer) >= 0) fired++;
    }
    return fired;
  }

  /** A time drawn from an exponential of `mean` seconds (nothing for a mean of 0). */
  private drawn(mean: number): number {
    return mean > 0 ? -mean * log(1 - this.rng.float()) : 0;
  }

  /**
   * Where a round from `origin` is aimed: about the head, across the line of fire — sideways
   * (level) and up. Heavy scatters within ±spread_m by ±spread_vertical of it; light picks a
   * point on the ring light_miss_m to light_miss_m + spread_m out, so it passes no nearer.
   */
  private aimAt(origin: readonly [number, number, number], target: readonly [number, number, number]): [number, number, number] {
    const f = [target[0] - origin[0], target[1] - origin[1], target[2] - origin[2]];
    const level = Math.sqrt(f[0] * f[0] + f[2] * f[2]);
    const len = Math.sqrt(level * level + f[1] * f[1]);
    if (!(len > 0)) return [target[0], target[1], target[2]];
    const side = level > 1e-9 ? [f[2] / level, 0, -f[0] / level] : [1, 0, 0];
    const up = [(f[1] * side[2] - f[2] * side[1]) / len, (f[2] * side[0] - f[0] * side[2]) / len, (f[0] * side[1] - f[1] * side[0]) / len];
    let across: number;
    let rise: number;
    if (this.intensity === 'light') {
      const r = this.rng.uniform(this.t.lightMissM, this.t.lightMissM + this.t.spreadM);
      const turn = this.rng.uniform(0, TAU);
      across = r * cos(turn);
      rise = r * sin(turn);
    } else {
      across = this.rng.uniform(-this.t.spreadM, this.t.spreadM);
      rise = this.rng.uniform(-this.t.spreadVertical * this.t.spreadM, this.t.spreadVertical * this.t.spreadM);
    }
    return [target[0] + side[0] * across + up[0] * rise, target[1] + side[1] * across + up[1] * rise, target[2] + side[2] * across + up[2] * rise];
  }
}
