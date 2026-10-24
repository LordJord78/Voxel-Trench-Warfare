/**
 * The battle's director (the battle spec's §1): a deterministic simulation of
 * the war around the player, on the lights' clock rather than the session's,
 * so every view the world is drawn in sees it. It runs whole 60 Hz steps of
 * the time it is given, so the same steps come of the same time at any frame
 * rate, and `at` seeks a moment by stepping to it from the start.
 *
 * This milestone it fires the flares (§2): from posts on both front lines'
 * parapets, out over no man's land, at a rate by the front's intensity — about
 * `mean_light` alight at once at light, `heavy_scale` times that heavy,
 * `off_per_min` a minute off, never more than `max_alight` at once — and only
 * while the sky is dark enough and the sun down. A quarter come from the posts
 * near the player.
 */

import { radians } from '../core/dmath';
import { Rng } from '../core/rng';
import type { Tunables } from '../core/tunables';
import type { WorldPlan } from '../world/generation/plan';
import type { Intensity } from '../combat/front';
import { flareAt, flareTunables, type FlareState, type FlareTunables, type Launch } from './flares';
import { Wind, windTunables } from './wind';

export interface BattleInputs {
  /** The front's, the pause menu's. */
  intensity: Intensity;
  /** How dark it is, 0 to 1: the sky's flares key while the sun is down (battleDarkness). */
  darkness: number;
  /** The player's feet, metres. */
  player: readonly [number, number, number];
}

export interface BattleEvents {
  launches: Launch[];
}

/** How dark the battle takes it to be: the sky's flares key while the sun is below `sun_below_deg`, and none once it is up (no flare by day). */
export function battleDarkness(sunElevationDeg: number, flaresKey: number, ft: FlareTunables): number {
  return sunElevationDeg < ft.sunBelowDeg ? flaresKey : 0;
}

/** Steps a second. */
const HZ = 60;

interface Post {
  at: [number, number, number];
  /** Metres along its line, and which axis that is. */
  along: number;
  longAxis: 0 | 2;
  /** Radians as yaw: straight across, over no man's land. */
  across: number;
}

export class Director {
  readonly wind: Wind;
  readonly ft: FlareTunables;
  /** Whole steps run, and the time they make. */
  private ticks = 0;
  /** Time given, not yet run as a whole step. */
  private given = 0;
  private readonly posts: Post[] = [];
  private readonly rng: Rng;
  private alight: Launch[] = [];
  private nextId = 1;

  constructor(plan: WorldPlan | null, tun: Tunables, seed: number) {
    const root = Rng.root(seed);
    this.wind = new Wind(windTunables(tun), root.derive('battle.wind'));
    this.rng = root.derive('battle.flares');
    this.ft = flareTunables(tun);
    const v = plan?.params.voxel ?? 0;
    for (const line of plan?.lines ?? []) {
      if (!line.spec.firingSteps) continue;
      for (const b of line.bays) {
        const a = ((b.a0 + b.a1) / 2) * v;
        const across = (b.facing > 0 ? b.b1 : b.b0) * v;
        const y = b.crestY * v;
        this.posts.push({
          at: b.longAxis === 0 ? [a, y, across] : [across, y, a],
          along: a,
          longAxis: b.longAxis,
          across: b.longAxis === 0 ? (b.facing > 0 ? 0 : Math.PI) : b.facing > 0 ? Math.PI / 2 : -Math.PI / 2,
        });
      }
    }
  }

  get seconds(): number {
    return this.ticks / HZ;
  }

  /** `seconds` of the lights' clock, at `inputs`: what was fired. */
  tick(seconds: number, inputs: BattleInputs): BattleEvents {
    this.given += seconds;
    const events: BattleEvents = { launches: [] };
    const target = Math.floor(this.given * HZ + 1e-6);
    while (this.ticks < target) this.step(inputs, events);
    return events;
  }

  /** The flares climbing and burning now, by id. */
  flares(): FlareState[] {
    const t = this.seconds;
    return this.alight.map((l) => flareAt(l, t, this.wind, this.ft)).filter((f) => f.stage !== 'out');
  }

  /** The director at `seconds` from its start, stepped there at `inputs`. */
  static at(seconds: number, plan: WorldPlan | null, tun: Tunables, seed: number, inputs: BattleInputs): Director {
    const d = new Director(plan, tun, seed);
    d.given = seconds;
    const events: BattleEvents = { launches: [] };
    const target = Math.round(seconds * HZ);
    while (d.ticks < target) d.step(inputs, events);
    return d;
  }

  private step(inputs: BattleInputs, events: BattleEvents): void {
    const t = this.ticks / HZ;
    const ft = this.ft;
    const perSecond = inputs.intensity === 'off' ? ft.offPerMin / 60 : (ft.meanLight / ft.burnS) * (inputs.intensity === 'heavy' ? ft.heavyScale : 1);
    if (inputs.darkness > ft.darkAbove && this.posts.length > 0 && this.alight.length < ft.maxAlight && this.rng.float() < perSecond / HZ) {
      const launch = this.fire(t, inputs);
      this.alight.push(launch);
      events.launches.push(launch);
    }
    this.ticks++;
    // Out at its launch, its climb and its burn: no need to fly it to know.
    const now = this.ticks / HZ;
    this.alight = this.alight.filter((l) => now <= l.t0 + Math.sqrt((2 * l.burstM) / ft.gravity) + ft.burnS);
  }

  private fire(t: number, inputs: BattleInputs): Launch {
    const ft = this.ft;
    const r = this.rng;
    const near = this.posts.filter((p) => Math.abs(p.along - (p.longAxis === 0 ? inputs.player[0] : inputs.player[2])) <= ft.nearM);
    const from = near.length > 0 && r.float() < ft.nearShare ? near : this.posts;
    const post = from[r.randint(0, from.length)];
    return {
      id: this.nextId++,
      post: [post.at[0], post.at[1], post.at[2]],
      t0: t,
      bearing: post.across + radians(r.uniform(-ft.spreadDeg, ft.spreadDeg)),
      elevation: radians(r.uniform(ft.elevationDeg[0], ft.elevationDeg[1])),
      burstM: r.uniform(ft.burstM[0], ft.burstM[1]),
      colour: r.float() < ft.redShare ? [...ft.red] : [...ft.white],
    };
  }
}
