/**
 * The water's rings (the battle spec's §6): a round or a shell falling in water starts a ring that
 * spreads at `ring_speed_mps` and fades over `ring_fade_s`, as high as its strength, which grows
 * with the splash's energy (the log of it: a round's kilojoule small, a shell's megajoules near
 * whole). The director keeps them on its clock, the 32 newest; the render side shapes the surface
 * from them, and from the wind's roughness. Pure functions of the ring and the time.
 */

import { log } from '../core/dmath';
import type { Tunables } from '../core/tunables';

type V3 = [number, number, number];

export interface WaterTunables {
  ringSpeedMps: number;
  ringFadeS: number;
  maxRings: number;
  /** A whole ring's height, metres, at its start. */
  ringHeightM: number;
  /** log10 of the energy (J) that makes a whole ring. */
  ringLogFull: number;
  ringWavelengthM: number;
  ringWidthM: number;
  /** The surface's slope a metre a second of wind. */
  roughnessPerMps: number;
}

export function waterTunables(tun: Tunables): WaterTunables {
  const f = (k: string) => tun.f(`battle.water.${k}`);
  return {
    ringSpeedMps: f('ring_speed_mps'),
    ringFadeS: f('ring_fade_s'),
    maxRings: tun.i('battle.water.max_rings'),
    ringHeightM: f('ring_height_m'),
    ringLogFull: f('ring_log_full'),
    ringWavelengthM: f('ring_wavelength_m'),
    ringWidthM: f('ring_width_m'),
    roughnessPerMps: f('roughness_per_mps'),
  };
}

/** A ring: where the splash met the water (metres, its top), when, and how strong (0 to 1). */
export interface Ring {
  at: V3;
  t0: number;
  strength: number;
}

/** A ring as it is at a moment: where, how far it has spread, how high it still stands, and its age. */
export interface RingState {
  at: V3;
  radiusM: number;
  heightM: number;
  age: number;
}

const LN10 = log(10);

/** A splash's ring's strength by its energy (J): its log over ring_log_full's, never under a twentieth or over whole. */
export function ringStrength(energyJ: number, wt: WaterTunables): number {
  const decades = log(Math.max(1, energyJ)) / LN10;
  return Math.min(1, Math.max(0.05, decades / wt.ringLogFull));
}

/** The ring at `t`: null before it starts and once it has faded. */
export function ringAt(ring: Ring, t: number, wt: WaterTunables): RingState | null {
  const age = t - ring.t0;
  if (age < 0 || age >= wt.ringFadeS) return null;
  const left = 1 - age / wt.ringFadeS;
  return { at: ring.at, radiusM: wt.ringSpeedMps * age, heightM: ring.strength * wt.ringHeightM * left * left, age };
}
