/**
 * Barrages beyond the map (the battle spec's §3): a run of `shells` over `duration_s`, falling
 * `distance_m` off from the map's middle, along the front to either side and beyond the enemy's line
 * (within `arc_deg` of toward them, +z), in a box `width_m` across and `depth_m` deep about its point.
 * A barrage is planned whole when it starts, from its stream; each of its shells lands at its time.
 *
 * Each shell landed beyond the map, or in the far field (far-shells.ts), is a flash: its power its own,
 * falling by e every `decay_s` and gone after `window_s`. The sky takes the newest sixteen.
 */

import { cos, exp, radians, sin } from '../core/dmath';
import type { Rng } from '../core/rng';
import type { Tunables } from '../core/tunables';

export interface BarrageTunables {
  /** Mean seconds between barrages' starts, at the front's light and heavy intensities. */
  everyLightS: number;
  everyHeavyS: number;
  arcDeg: number;
  distanceM: [number, number];
  shells: [number, number];
  durationS: [number, number];
  widthM: number;
  depthM: number;
  /** A shell's own power, over a flash's at full. */
  power: [number, number];
}

export function barrageTunables(tun: Tunables): BarrageTunables {
  const f = (k: string) => tun.f(`battle.barrages.${k}`);
  const pair = (k: string) => tun.pair(`battle.barrages.${k}`);
  return {
    everyLightS: f('every_light_s'),
    everyHeavyS: f('every_heavy_s'),
    arcDeg: f('arc_deg'),
    distanceM: pair('distance_m'),
    shells: pair('shells'),
    durationS: pair('duration_s'),
    widthM: f('width_m'),
    depthM: f('depth_m'),
    power: pair('power'),
  };
}

export interface FlashTunables {
  /** Seconds a flash is seen after its shell lands. */
  windowS: number;
  /** Seconds its power falls by e over. */
  decayS: number;
}

export function flashTunables(tun: Tunables): FlashTunables {
  return { windowS: tun.f('battle.flashes.window_s'), decayS: tun.f('battle.flashes.decay_s') };
}

/** The most flashes the sky takes: the newest. */
export const HORIZON_FLASHES = 16;

/** A shell planned: when it lands (seconds on the battle's clock), where (metres), and its power. */
export interface PlannedShell {
  t: number;
  x: number;
  z: number;
  power: number;
}

/** A barrage started at `t0`, about `centre` (x, z metres): its shells by time. */
export function planBarrage(t0: number, centre: readonly [number, number], rng: Rng, bt: BarrageTunables): PlannedShell[] {
  const bearing = radians(rng.uniform(-bt.arcDeg, bt.arcDeg));
  const d = rng.uniform(bt.distanceM[0], bt.distanceM[1]);
  const n = rng.randint(bt.shells[0], bt.shells[1] + 1);
  const length = rng.uniform(bt.durationS[0], bt.durationS[1]);
  // Toward the barrage, and across it.
  const along = [sin(bearing), cos(bearing)];
  const across = [cos(bearing), -sin(bearing)];
  const at = [centre[0] + along[0] * d, centre[1] + along[1] * d];
  const shells: PlannedShell[] = [];
  for (let k = 0; k < n; k++) {
    const t = t0 + rng.uniform(0, length);
    const u = rng.uniform(-0.5, 0.5) * bt.widthM;
    const v = rng.uniform(-0.5, 0.5) * bt.depthM;
    const power = rng.uniform(bt.power[0], bt.power[1]);
    shells.push({ t, x: at[0] + across[0] * u + along[0] * v, z: at[1] + across[1] * u + along[1] * v, power });
  }
  return shells.sort((a, b) => a.t - b.t);
}

/** A landed shell's flash at `now`: its power at its landing, falling by e every `decay_s`; none before it lands or after the window. */
export function flashPower(shell: { t: number; power: number }, now: number, ft: FlashTunables): number {
  const age = now - shell.t;
  if (age < 0 || age > ft.windowS) return 0;
  return shell.power * exp(-age / ft.decayS);
}
