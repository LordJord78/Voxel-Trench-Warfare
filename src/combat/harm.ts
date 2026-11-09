/**
 * Harm in a room (the shared-battle spec's "Damage"): what the battle does to a player's body, which
 * each page reckons for its own player and tells the room as a hurt (the relay applies it, from the
 * battle, scoring nothing).
 *
 * - **A blast:** `blast_hp` within `lethal_radii` of the shell's radius, falling linearly to nothing
 *   at `reach_radii`; times `cover_share` when a voxel ray from it to the chest is blocked.
 * - **The front's round:** its zone's damage (net/match-rules.ts DAMAGE) times `front_damage_scale`.
 */

import type { Tunables } from '../core/tunables';
import { DAMAGE } from '../net/match-rules';
import type { Zone } from '../net/protocol';

/** `[room_battle]`'s harm: a blast's, its lethal and reach radii (in the shell's radii), cover's share, and the front's scale. */
export interface HarmTunables {
  blastHp: number;
  lethalRadii: number;
  reachRadii: number;
  coverShare: number;
  frontDamageScale: number;
}

export function harmTunables(tun: Tunables): HarmTunables {
  const f = (k: string) => tun.f(`room_battle.${k}`);
  return {
    blastHp: f('blast_hp'),
    lethalRadii: f('lethal_radii'),
    reachRadii: f('reach_radii'),
    coverShare: f('cover_share'),
    frontDamageScale: f('front_damage_scale'),
  };
}

/** A blast of a shell of `radiusM` on a body `distanceM` from it, `covered` if its way there is blocked. */
export function blastHarm(distanceM: number, radiusM: number, covered: boolean, t: HarmTunables): number {
  const lethal = t.lethalRadii * radiusM;
  const reach = t.reachRadii * radiusM;
  const share = distanceM <= lethal ? 1 : distanceM >= reach ? 0 : (reach - distanceM) / (reach - lethal);
  return t.blastHp * share * (covered ? t.coverShare : 1);
}

/** The front's round into a body's `zone`. */
export function frontHarm(zone: Zone, t: HarmTunables): number {
  return DAMAGE[zone] * t.frontDamageScale;
}
