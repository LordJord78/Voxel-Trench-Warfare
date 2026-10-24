/**
 * A tracer's flight (the battle spec's §4): the rifle round's ballistics simplified, without strikes.
 * Fired along its line at `muzzle_mps`, drag slows it there, at `v0 / (1 + k·v0·s)` and
 * `ln(1 + k·v0·s) / k` along it s seconds on (k the round's drag factor × the air's density), and
 * gravity drops it `g·s²/2` under that. Where it first goes under the ground it ends; one in six
 * (`ricochet_share`) flies again from there at `ricochet_speed` of its speed, at a random bearing and
 * `ricochet_up_deg` up, until the ground again. Its tracer burns `burn_s` from its firing, whatever it
 * does. Its ends are worked out as it is fired, by marching its path; after that a tracer at any
 * moment is a pure function of its shot and the time.
 */

import { cos, hypot, log, radians, sin, TAU } from '../core/dmath';
import type { Rng } from '../core/rng';
import type { Tunables } from '../core/tunables';
import { ballisticsTunables, projectileSpec } from '../combat/ballistics';

export interface TracerTunables {
  /** Bursts a second at the front's light intensity, and heavy's over that. */
  burstsLight: number;
  heavyScale: number;
  rounds: [number, number];
  rpm: number;
  tracerEvery: number;
  /** Either way of straight across, and the turn over a burst. */
  spreadDeg: number;
  sweepDeg: number;
  elevationDeg: [number, number];
  muzzleMps: number;
  burnS: number;
  ricochetShare: number;
  ricochetSpeed: number;
  ricochetUpDeg: [number, number];
  /** Guns stand more than clearM along the line from the player; a burst whose fire would pass within missM of them is not fired. */
  clearM: number;
  missM: number;
  /** A share of bursts grazes the field this far out (metres), so their strikes and ricochets are near. */
  grazeShare: number;
  grazeM: [number, number];
  maxDrawn: number;
  /** Metres of trail a tracer is drawn with: two frames' flight at 60 Hz, the streak a far one makes. */
  trailM: number;
  /** Per metre: the round's drag factor × the air's density. */
  k: number;
  /** m/s², downward. */
  gravity: number;
}

export function tracerTunables(tun: Tunables): TracerTunables {
  const f = (k: string) => tun.f(`battle.tracers.${k}`);
  const pair = (k: string) => tun.pair(`battle.tracers.${k}`);
  const b = ballisticsTunables(tun);
  return {
    burstsLight: f('bursts_light'),
    heavyScale: f('heavy_scale'),
    rounds: pair('rounds'),
    rpm: f('rpm'),
    tracerEvery: tun.i('battle.tracers.tracer_every'),
    spreadDeg: f('spread_deg'),
    sweepDeg: f('sweep_deg'),
    elevationDeg: pair('elevation_deg'),
    muzzleMps: f('muzzle_mps'),
    burnS: f('burn_s'),
    ricochetShare: f('ricochet_share'),
    ricochetSpeed: f('ricochet_speed'),
    ricochetUpDeg: pair('ricochet_up_deg'),
    clearM: f('clear_m'),
    missM: f('miss_m'),
    grazeShare: f('graze_share'),
    grazeM: pair('graze_m'),
    maxDrawn: tun.i('battle.tracers.max_drawn'),
    trailM: f('trail_m'),
    k: projectileSpec(tun, 'assault_rifle').dragFactor * b.airDensity,
    gravity: -b.gravity,
  };
}

type V3 = [number, number, number];

/** A straight-fired flight: from `from` along `dir` (a unit) at `v0`, from `t0` to `t1` (seconds on the battle's clock). */
export interface Leg {
  from: V3;
  dir: V3;
  v0: number;
  t0: number;
  t1: number;
}

/** A tracer fired: its flight, and its ricochet's if it had one. */
export interface Shot {
  id: number;
  legs: Leg[];
}

/** A tracer as it is: where (metres), its velocity, and how far it has flown since it was fired or struck. */
export interface TracerState {
  id: number;
  position: V3;
  velocity: V3;
  flown: number;
}

/** Seconds a path is marched by, finding where it goes under the ground. */
const MARCH_S = 0.02;

function along(leg: { from: readonly number[]; dir: readonly number[]; v0: number }, s: number, tt: TracerTunables): { position: V3; velocity: V3; flown: number } {
  const u = 1 + tt.k * leg.v0 * s;
  const d = log(u) / tt.k;
  const v = leg.v0 / u;
  return {
    position: [leg.from[0] + leg.dir[0] * d, leg.from[1] + leg.dir[1] * d - (tt.gravity * s * s) / 2, leg.from[2] + leg.dir[2] * d],
    velocity: [leg.dir[0] * v, leg.dir[1] * v - tt.gravity * s, leg.dir[2] * v],
    flown: d,
  };
}

/** A flight's height `s` seconds on. */
function heightAt(leg: { from: readonly number[]; dir: readonly number[]; v0: number }, s: number, tt: TracerTunables): number {
  return leg.from[1] + (leg.dir[1] * log(1 + tt.k * leg.v0 * s)) / tt.k - (tt.gravity * s * s) / 2;
}

/**
 * Where a flight from `t0` first goes under the ground before `until`: its time there, or null.
 * Its lowest over what is left of its flight is at one end of it (its height is concave fired up,
 * and falls all the way fired down), so once both are over `groundTop` (the ground's highest) it
 * cannot strike, and is marched no further.
 */
function strike(leg: { from: readonly number[]; dir: readonly number[]; v0: number }, t0: number, until: number, ground: (xM: number, zM: number) => number, tt: TracerTunables, groundTop: number): number | null {
  const endHigh = heightAt(leg, until - t0, tt) > groundTop;
  let last = 0;
  let lastAbove = Number.NaN;
  for (let s = MARCH_S; t0 + s <= until + 1e-9; s += MARCH_S) {
    const d = log(1 + tt.k * leg.v0 * s) / tt.k;
    const y = leg.from[1] + leg.dir[1] * d - (tt.gravity * s * s) / 2;
    if (endHigh && y > groundTop) return null;
    const above = y - ground(leg.from[0] + leg.dir[0] * d, leg.from[2] + leg.dir[2] * d);
    if (above < 0) {
      // Between the last step over the ground and this one under it, where the two meet.
      const before = Number.isNaN(lastAbove) ? 0 : lastAbove;
      return t0 + last + (MARCH_S * before) / (before - above);
    }
    last = s;
    lastAbove = above;
  }
  return null;
}

/**
 * A tracer fired from `origin` along `dir` (a unit) at `t0`, over `ground` (its height in metres at
 * x, z; never over `groundTop`): its flight to where it strikes or burns out, and its ricochet's. Its ricochet's chance,
 * bearing and climb are drawn whether or not it strikes, so the stream's order never depends on the
 * ground.
 */
export function planShot(id: number, origin: readonly number[], dir: readonly number[], t0: number, ground: (xM: number, zM: number) => number, rng: Rng, tt: TracerTunables, groundTop = Infinity): Shot {
  const roll = rng.float();
  const bearing = rng.uniform(0, TAU);
  const climb = radians(rng.uniform(tt.ricochetUpDeg[0], tt.ricochetUpDeg[1]));
  const end = t0 + tt.burnS;
  const first = { from: [origin[0], origin[1], origin[2]] as V3, dir: [dir[0], dir[1], dir[2]] as V3, v0: tt.muzzleMps };
  const hit = strike(first, t0, end, ground, tt, groundTop);
  const legs: Leg[] = [{ ...first, t0, t1: hit ?? end }];
  if (hit !== null && roll < tt.ricochetShare) {
    const at = along(first, hit - t0, tt);
    const v = hypot(at.velocity[0], at.velocity[1], at.velocity[2]);
    const second = { from: at.position, dir: [sin(bearing) * cos(climb), sin(climb), cos(bearing) * cos(climb)] as V3, v0: tt.ricochetSpeed * v };
    legs.push({ ...second, t0: hit, t1: strike(second, hit, end, ground, tt, groundTop) ?? end });
  }
  return { id, legs };
}

/** The tracer at `t`: on whichever of its legs it is flying; null before it is fired and after it ends. */
export function tracerAt(shot: Shot, t: number, tt: TracerTunables): TracerState | null {
  for (const leg of shot.legs) {
    if (t < leg.t0 || t > leg.t1) continue;
    const at = along(leg, t - leg.t0, tt);
    return { id: shot.id, ...at };
  }
  return null;
}
