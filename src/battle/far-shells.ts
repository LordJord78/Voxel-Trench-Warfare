/**
 * Shells into the far field (the battle spec's §3): falling `distance_m` from the map's middle, within
 * `arc_deg` of toward the enemy (+z), so beyond the map's edge. Each is a flash (its light on the far
 * field and the haze, and a disc), a thump after its distance, and a column of smoke: `puffs` let out
 * one every `puff_every_s`, each rising `rise_mps` and slowing by e over `rise_s`, carried by the wind
 * from its release, growing over `puff_radius_m`, the whole column thinning away over `smoke_s`.
 * A column is a pure function of its shell, the time and the wind.
 */

import { cos, exp, radians, sin } from '../core/dmath';
import type { Rng } from '../core/rng';
import type { Tunables } from '../core/tunables';
import type { PlannedShell } from './barrages';
import type { Wind } from './wind';

export interface FarShellTunables {
  /** Mean seconds between far shells, at the front's light and heavy intensities. */
  everyLightS: number;
  everyHeavyS: number;
  distanceM: [number, number];
  arcDeg: number;
  power: [number, number];
  flashS: number;
  flashSizeM: [number, number];
  flashGlow: number;
  smokeS: number;
  puffs: number;
  puffEveryS: number;
  riseMps: number;
  riseS: number;
  puffRadiusM: [number, number];
  smokeAlpha: number;
  smokeColour: [number, number, number];
}

export function farShellTunables(tun: Tunables): FarShellTunables {
  const f = (k: string) => tun.f(`battle.far_shells.${k}`);
  const pair = (k: string) => tun.pair(`battle.far_shells.${k}`);
  return {
    everyLightS: f('every_light_s'),
    everyHeavyS: f('every_heavy_s'),
    distanceM: pair('distance_m'),
    arcDeg: f('arc_deg'),
    power: pair('power'),
    flashS: f('flash_s'),
    flashSizeM: pair('flash_size_m'),
    flashGlow: f('flash_glow'),
    smokeS: f('smoke_s'),
    puffs: tun.i('battle.far_shells.puffs'),
    puffEveryS: f('puff_every_s'),
    riseMps: f('rise_mps'),
    riseS: f('rise_s'),
    puffRadiusM: pair('puff_radius_m'),
    smokeAlpha: f('smoke_alpha'),
    smokeColour: tun.triple('battle.far_shells.smoke_colour'),
  };
}

/** A far shell landing at `t`, about `centre` (x, z metres). */
export function planFarShell(t: number, centre: readonly [number, number], rng: Rng, ft: FarShellTunables): PlannedShell {
  const bearing = radians(rng.uniform(-ft.arcDeg, ft.arcDeg));
  const d = rng.uniform(ft.distanceM[0], ft.distanceM[1]);
  const power = rng.uniform(ft.power[0], ft.power[1]);
  return { t, x: centre[0] + sin(bearing) * d, z: centre[1] + cos(bearing) * d, power };
}

/** A puff of a column of smoke: its middle (metres), its radius, and how much it covers. */
export interface ColumnPuff {
  centre: [number, number, number];
  radiusM: number;
  alpha: number;
}

/** The column a far shell landed at `shell.t` throws up, at `now`: its puffs let out so far, oldest first; none once it has thinned away. */
export function columnPuffs(shell: { t: number; position: readonly number[] }, now: number, wind: Wind, ft: FarShellTunables): ColumnPuff[] {
  const life = now - shell.t;
  if (life < 0 || life >= ft.smokeS) return [];
  const alpha = ft.smokeAlpha * (1 - life / ft.smokeS);
  const [r0, r1] = ft.puffRadiusM;
  const puffs: ColumnPuff[] = [];
  for (let k = 0; k < ft.puffs; k++) {
    const release = shell.t + k * ft.puffEveryS;
    if (release > now) break;
    const age = now - release;
    const [dx, dz] = wind.drift(release, now);
    puffs.push({
      centre: [shell.position[0] + dx, shell.position[1] + ft.riseMps * ft.riseS * (1 - exp(-age / ft.riseS)), shell.position[2] + dz],
      radiusM: r0 + (r1 - r0) * Math.min(1, age / ft.smokeS),
      alpha,
    });
  }
  return puffs;
}
