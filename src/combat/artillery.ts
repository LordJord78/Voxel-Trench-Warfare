/**
 * The front's artillery (the spec's §3, "Shells"): a scheduler, as the rifle
 * fire is (front.ts), with no gun behind it. Off, light or heavy. Light lands
 * a shell every `light_mean_s` or so, never two within `light_gap_s`; heavy
 * about one a second. Each is announced `whistle_s` before it lands — that is
 * its whistle (§5) — and its flight before that is not simulated. Its radius is
 * drawn uniform in `radius_m`.
 *
 * Where it lands is its source's. Over a generated world (planShellSource) a
 * share lands in the player's sector — `light_sector_m` from them on light,
 * `heavy_sector_m` on heavy — and the rest in no man's land or on a front or
 * support line of either side, within `reach_m` along the front of them. On
 * light none lands nearer than the sector's 15 m, whichever it was drawn for;
 * heavy may land anywhere near.
 */

import { cos, log, sin } from '../core/dmath';
import type { Rng } from '../core/rng';
import type { Tunables } from '../core/tunables';
import type { WorldPlan } from '../world/generation/plan';
import type { Intensity } from './front';

export interface ArtilleryTunables {
  lightMeanS: number;
  lightGapS: number;
  heavyMeanS: number;
  heavyGapS: number;
  whistleS: number;
  radiusM: [number, number];
  lightSectorShare: number;
  heavySectorShare: number;
  lightSectorM: [number, number];
  heavySectorM: [number, number];
  reachM: number;
}

function pair(tun: Tunables, key: string): [number, number] {
  const value = tun.get(key);
  if (!Array.isArray(value) || value.length !== 2 || !value.every((v) => typeof v === 'number' && Number.isFinite(v)) || !(value[0] <= value[1])) {
    throw new TypeError(`tunable '${key}' is not two finite numbers, low first: ${JSON.stringify(value)}`);
  }
  return [value[0], value[1]];
}

export function artilleryTunables(tun: Tunables): ArtilleryTunables {
  const f = (k: string) => tun.f(`artillery.${k}`);
  return {
    lightMeanS: f('light_mean_s'),
    lightGapS: f('light_gap_s'),
    heavyMeanS: f('heavy_mean_s'),
    heavyGapS: f('heavy_gap_s'),
    whistleS: f('whistle_s'),
    radiusM: pair(tun, 'artillery.radius_m'),
    lightSectorShare: f('light_sector_share'),
    heavySectorShare: f('heavy_sector_share'),
    lightSectorM: pair(tun, 'artillery.light_sector_m'),
    heavySectorM: pair(tun, 'artillery.heavy_sector_m'),
    reachM: f('reach_m'),
  };
}

/** Where a shell lands, (x, z) in metres, aimed about `target` (metres): or null to send none. */
export type ShellSource = (target: readonly [number, number, number], rng: Rng, intensity: Intensity, t: ArtilleryTunables) => [number, number] | null;

const TAU = 2 * Math.PI;

/** A test's: anywhere `minM`–`maxM` from the target. */
export function ringSource(minM: number, maxM: number): ShellSource {
  return (target, rng) => {
    const turn = rng.uniform(0, TAU);
    const d = rng.uniform(minM, maxM);
    return [target[0] + cos(turn) * d, target[2] + sin(turn) * d];
  };
}

/** Draws a source may make for one shell before it sends none. */
const TRIES = 8;

/** A generated world's: the player's sector, no man's land, or a front or support line of either side. */
export function planShellSource(plan: WorldPlan): ShellSource {
  const v = plan.params.voxel;
  const size = [plan.params.dims.x * v, plan.params.dims.z * v];
  const lines = plan.lines.filter((l) => l.spec.longAxis === 0 && /(^|_)(front|support)$/.test(l.spec.name)).map((l) => l.spec.crossBase * v);
  const ours = plan.lines.find((l) => l.spec.name === 'front');
  const theirs = plan.lines.find((l) => l.spec.name === 'enemy_front');
  const nml = ours && theirs ? [Math.min(ours.spec.crossBase, theirs.spec.crossBase) * v + 8, Math.max(ours.spec.crossBase, theirs.spec.crossBase) * v - 8] : null;
  return (target, rng, intensity, t) => {
    const share = intensity === 'heavy' ? t.heavySectorShare : t.lightSectorShare;
    const nearest = intensity === 'heavy' ? 0 : t.lightSectorM[0];
    for (let k = 0; k < TRIES; k++) {
      const pick = rng.float();
      let at: [number, number];
      if (pick < share || lines.length === 0) {
        const [lo, hi] = intensity === 'heavy' ? t.heavySectorM : t.lightSectorM;
        const turn = rng.uniform(0, TAU);
        const d = rng.uniform(lo, hi);
        at = [target[0] + cos(turn) * d, target[2] + sin(turn) * d];
      } else {
        const along = target[0] + rng.uniform(-t.reachM, t.reachM);
        if (nml && pick < share + (1 - share) / 2) at = [along, rng.uniform(nml[0], nml[1])];
        else at = [along, lines[rng.randint(0, lines.length)] + rng.uniform(-4, 4)];
      }
      const onMap = at[0] >= 0 && at[0] < size[0] && at[1] >= 0 && at[1] < size[1];
      const dx = at[0] - target[0];
      const dz = at[1] - target[2];
      if (onMap && dx * dx + dz * dz >= nearest * nearest) return at;
    }
    return null;
  };
}

export interface Shell {
  id: number;
  /** Where it lands, metres. */
  x: number;
  z: number;
  radiusM: number;
  /** Its crater's draw (world/detonation.ts). */
  seed: number;
}

export class Artillery {
  intensity: Intensity = 'off';
  /** Time to the next shell's announcement, once armed. */
  private wait = 0;
  private armed = false;
  private nextId = 1;
  /** Shells announced and not yet down, oldest first, with the time each has left. */
  private readonly flying: { shell: Shell; left: number }[] = [];

  constructor(
    readonly t: ArtilleryTunables,
    private readonly source: ShellSource,
    private readonly rng: Rng,
  ) {}

  /** One tick: the shells announced now, aimed about `target` (metres), and those that land now. Shells in the air land whatever the intensity becomes. */
  tick(dt: number, target: readonly [number, number, number]): { announced: Shell[]; landed: Shell[] } {
    const announced: Shell[] = [];
    const landed: Shell[] = [];
    for (const f of this.flying) f.left -= dt;
    while (this.flying.length > 0 && this.flying[0].left <= 1e-9) landed.push(this.flying.shift()!.shell);
    if (this.intensity === 'off') {
      this.armed = false;
      return { announced, landed };
    }
    if (!this.armed) {
      this.armed = true;
      this.wait = this.interval();
    }
    while (this.wait <= 1e-9) {
      this.wait += this.interval();
      const at = this.source(target, this.rng, this.intensity, this.t);
      if (!at) continue;
      const shell: Shell = { id: this.nextId++, x: at[0], z: at[1], radiusM: this.rng.uniform(this.t.radiusM[0], this.t.radiusM[1]), seed: this.rng.nextU32() };
      this.flying.push({ shell, left: this.t.whistleS });
      announced.push(shell);
    }
    this.wait -= dt;
    return { announced, landed };
  }

  /** The time to the next shell: the intensity's gap, and the rest drawn exponential about its mean. */
  private interval(): number {
    const heavy = this.intensity === 'heavy';
    const gap = heavy ? this.t.heavyGapS : this.t.lightGapS;
    const rest = (heavy ? this.t.heavyMeanS : this.t.lightMeanS) - gap;
    return gap + (rest > 0 ? -rest * log(1 - this.rng.float()) : 0);
  }
}
