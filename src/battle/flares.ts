/**
 * A flare's flight (the battle spec's §2): fired from its post at its
 * elevation, toward its bearing over no man's land, it climbs without drag at
 * the speed that brings it to its burst height at its apogee; there it bursts,
 * its light catching over `ignite_s`. Under its parachute it drifts with the
 * wind and sinks `sink_mps`, burns `burn_s` and gutters out over the last
 * `fade_s`. A pure function of its launch and the time: the director keeps the
 * launches, and any moment of any flare is had without stepping to it.
 */

import { cos, sin } from '../core/dmath';
import type { Tunables } from '../core/tunables';
import type { Wind } from './wind';

export interface FlareTunables {
  burstM: [number, number];
  elevationDeg: [number, number];
  spreadDeg: number;
  sinkMps: number;
  burnS: number;
  igniteS: number;
  fadeS: number;
  radiusM: number;
  intensity: number;
  white: [number, number, number];
  red: [number, number, number];
  redShare: number;
  meanLight: number;
  heavyScale: number;
  offPerMin: number;
  darkAbove: number;
  nearShare: number;
  nearM: number;
  /** m/s²: the ballistics' real gravity, downward. */
  gravity: number;
}

const triple = (tun: Tunables, key: string): [number, number, number] => {
  const v = tun.get(key);
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number')) throw new TypeError(`tunable '${key}' is not three numbers`);
  return [v[0], v[1], v[2]];
};

export function flareTunables(tun: Tunables): FlareTunables {
  const f = (k: string) => tun.f(`battle.flares.${k}`);
  return {
    burstM: tun.pair('battle.flares.burst_m'),
    elevationDeg: tun.pair('battle.flares.elevation_deg'),
    spreadDeg: f('spread_deg'),
    sinkMps: f('sink_mps'),
    burnS: f('burn_s'),
    igniteS: f('ignite_s'),
    fadeS: f('fade_s'),
    radiusM: f('radius_m'),
    intensity: f('intensity'),
    white: triple(tun, 'battle.flares.white'),
    red: triple(tun, 'battle.flares.red'),
    redShare: f('red_share'),
    meanLight: f('mean_light'),
    heavyScale: f('heavy_scale'),
    offPerMin: f('off_per_min'),
    darkAbove: f('dark_above'),
    nearShare: f('near_share'),
    nearM: f('near_m'),
    gravity: -tun.f('ballistics.gravity'),
  };
}

/** A flare fired: from its post (metres) at `t0` (seconds on the battle's clock), toward `bearing` (radians as yaw) at `elevation` (radians), to burst `burstM` above the post. */
export interface Launch {
  id: number;
  post: [number, number, number];
  t0: number;
  bearing: number;
  elevation: number;
  burstM: number;
  /** Its light's colour, linear RGB. */
  colour: [number, number, number];
}

export interface FlareState {
  id: number;
  position: [number, number, number];
  /** How brightly it burns, 0 to 1: 0 climbing and out. */
  glow: number;
  stage: 'climb' | 'burning' | 'out';
  /** Its light's colour, linear RGB (its launch's). */
  colour: [number, number, number];
}

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** The flare of `l` at `t` (seconds on the battle's clock). */
export function flareAt(l: Launch, t: number, wind: Wind, ft: FlareTunables): FlareState {
  const g = ft.gravity;
  const climb = Math.sqrt((2 * l.burstM) / g);
  const across = Math.sqrt(2 * g * l.burstM) * (cos(l.elevation) / sin(l.elevation));
  const out = (position: [number, number, number]): FlareState => ({ id: l.id, position, glow: 0, stage: 'out', colour: l.colour });
  const tau = t - l.t0;
  if (tau < 0) return out([l.post[0], l.post[1], l.post[2]]);
  const ahead = (s: number): [number, number] => [l.post[0] + sin(l.bearing) * across * s, l.post[2] + cos(l.bearing) * across * s];
  if (tau < climb) {
    const [x, z] = ahead(tau);
    const up = Math.sqrt(2 * g * l.burstM);
    return { id: l.id, position: [x, l.post[1] + up * tau - (g * tau * tau) / 2, z], glow: 0, stage: 'climb', colour: l.colour };
  }
  const [bx, bz] = ahead(climb);
  const tb = l.t0 + climb;
  const s = Math.min(t - tb, ft.burnS);
  const d = wind.drift(tb, tb + s);
  const position: [number, number, number] = [bx + d[0], l.post[1] + l.burstM - ft.sinkMps * s, bz + d[1]];
  if (t - tb > ft.burnS) return out(position);
  return { id: l.id, position, glow: smooth(s / ft.igniteS) * smooth((ft.burnS - s) / ft.fadeS), stage: 'burning', colour: l.colour };
}
