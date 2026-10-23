/**
 * The front: incoming fire from the enemy line, with no squad, no AI and no
 * damage behind it — a scheduler that fires rounds at the player so their
 * near misses suppress (suppression.ts). The reference had a tuning rig for
 * this and promised it would go when a squad exists; sub-project 4 builds the
 * battle around the player on the same rounds.
 *
 * Off, light or heavy (`[front]`): light is single shots, sporadic sniping;
 * heavy is a machine gun's bursts at its cyclic rate, with pauses that bring
 * its mean to `heavy_rpm`, every fifth round a tracer. Each round leaves from
 * where the source says (an enemy bay's crest in a generated world; a line at
 * a set distance in a test's), aimed at the player's head with the
 * reference's scatter: `spread_m` sideways, 0.6 of it up and down.
 */

import type { Rng } from '../core/rng';
import type { Tunables } from '../core/tunables';
import type { WorldPlan } from '../world/generation/plan';
import type { ProjectileSpec, Rounds } from './ballistics';

export type Intensity = 'off' | 'light' | 'heavy';

export interface FrontTunables {
  lightRpm: number;
  heavyRpm: number;
  burstRounds: number;
  burstRpm: number;
  tracerEvery: number;
  spreadM: number;
  reachM: number;
}

export function frontTunables(tun: Tunables): FrontTunables {
  return {
    lightRpm: tun.f('front.light_rpm'),
    heavyRpm: tun.f('front.heavy_rpm'),
    burstRounds: tun.i('front.burst_rounds'),
    burstRpm: tun.f('front.burst_rpm'),
    tracerEvery: tun.i('front.tracer_every'),
    spreadM: tun.f('front.spread_m'),
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

export class Front {
  intensity: Intensity = 'off';
  /** Rounds owed, and where a burst is: rounds left in it, and time to the next. */
  private due = 0;
  private burstLeft = 0;
  private wait = 0;
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
      this.due += (dt * this.t.lightRpm) / 60;
      while (this.due >= 1) {
        this.due -= 1;
        shots++;
      }
    } else if (this.intensity === 'heavy') {
      tracers = true;
      // Due now, then the tick passes: a burst's rounds fall 60/burst_rpm apart from its first.
      while (this.wait <= 1e-9) {
        if (this.burstLeft === 0) this.burstLeft = this.t.burstRounds;
        shots++;
        this.burstLeft--;
        const cyclic = 60 / this.t.burstRpm;
        // The pause after a burst brings the mean to heavy_rpm.
        const pause = this.t.burstRounds * (60 / this.t.heavyRpm - cyclic);
        this.wait += this.burstLeft === 0 ? cyclic + pause : cyclic;
      }
      this.wait -= dt;
    } else {
      this.due = 0;
      this.burstLeft = 0;
      this.wait = 0;
    }
    let fired = 0;
    for (let k = 0; k < shots; k++) {
      const origin = this.source(target, this.rng);
      if (!origin) continue;
      const aim = [target[0] + this.rng.uniform(-this.t.spreadM, this.t.spreadM), target[1] + this.rng.uniform(-0.6 * this.t.spreadM, 0.6 * this.t.spreadM), target[2]];
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
}
