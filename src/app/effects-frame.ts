/**
 * A frame's effects, from the session and the events the frame drained: the
 * particles' billboards; each tracer round's ribbon, 7 m back from its head,
 * the player's drawn from the rifle's muzzle and joining the round's path by
 * `tracer_converge_m` (the round leaves the eye, so the reticle tells the
 * truth); and each shot's flash — a star of three ribbons from the muzzle and a
 * transient light there — for `flash_frames` frames (spec §4).
 */

import { BILLBOARD_FLOATS } from '../combat/particles';
import type { Tunables } from '../core/tunables';
import { MAX_BILLBOARDS, MAX_RIBBONS, RIBBON_FLOATS, type EffectsFrame, type TransientLight } from '../render/effects';
import type { CombatEvents, Session } from '../sim/session';

type V3 = [number, number, number];

export interface EffectsTunables {
  tracerLengthM: number;
  tracerWidthM: number;
  tracerColour: V3;
  tracerIntensity: number;
  tracerTailAlpha: number;
  tracerConvergeM: number;
  flashFrames: number;
  flashStarLengthM: number;
  flashStarWidthM: number;
  flashColour: V3;
  flashIntensity: number;
  flashLightRadiusM: number;
  flashLightIntensity: number;
  flashLightColour: V3;
}

function rgb(tun: Tunables, key: string): V3 {
  const value = tun.get(key);
  if (!Array.isArray(value) || value.length !== 3 || !value.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw new TypeError(`tunable '${key}' is not three finite numbers: ${JSON.stringify(value)}`);
  }
  return value as V3;
}

export function effectsTunables(tun: Tunables): EffectsTunables {
  const f = (k: string) => tun.f(`effects.${k}`);
  return {
    tracerLengthM: f('tracer_length_m'),
    tracerWidthM: f('tracer_width_m'),
    tracerColour: rgb(tun, 'effects.tracer_colour'),
    tracerIntensity: f('tracer_intensity'),
    tracerTailAlpha: f('tracer_tail_alpha'),
    tracerConvergeM: f('tracer_converge_m'),
    flashFrames: tun.i('effects.flash_frames'),
    flashStarLengthM: f('flash_star_length_m'),
    flashStarWidthM: f('flash_star_width_m'),
    flashColour: rgb(tun, 'effects.flash_colour'),
    flashIntensity: f('flash_intensity'),
    flashLightRadiusM: f('flash_light_radius_m'),
    flashLightIntensity: f('flash_light_intensity'),
    flashLightColour: rgb(tun, 'effects.flash_light_colour'),
  };
}

/** A test's quad: emissive, square to the camera. */
export interface DebugQuad {
  position: V3;
  size: number;
  colour: V3;
}

export interface BuiltEffects {
  frame: EffectsFrame;
  lights: TransientLight[];
  counts: { billboards: number; tracers: number; stars: number; lights: number };
}

const RAD = Math.PI / 180;
/** The flash's star: forward, and two rays 60° either side of it, a little up, each 0.6 as long. */
const STAR_SIDE = 60 * RAD;
const STAR_SIDE_LENGTH = 0.6;
const STAR_LIFT = 0.3;

export class EffectsFrameBuilder {
  /** Quads and transient lights a test asks for, every frame until it asks for none. */
  debug: DebugQuad[] = [];
  debugLights: TransientLight[] = [];
  private readonly billboards = new Float32Array(MAX_BILLBOARDS * BILLBOARD_FLOATS);
  private readonly ribbons = new Float32Array(MAX_RIBBONS * RIBBON_FLOATS);
  private flashes: { muzzle: V3; dir: V3; frames: number }[] = [];

  constructor(readonly t: EffectsTunables) {}

  build(session: Session, events: CombatEvents): BuiltEffects {
    const t = this.t;
    for (const shot of events.shots) this.flashes.push({ muzzle: shot.muzzle, dir: shot.dir, frames: t.flashFrames });

    let billboards = session.particles.billboards(this.billboards);
    for (const q of this.debug) {
      if (billboards >= MAX_BILLBOARDS) break;
      this.billboards.set([...q.position, q.size / 2, ...q.colour, 1, 1], billboards * BILLBOARD_FLOATS);
      billboards++;
    }

    let ribbons = 0;
    const ribbon = (tail: readonly number[], head: readonly number[], width: number, colour: readonly number[], alphaTail: number, alphaHead: number) => {
      if (ribbons >= MAX_RIBBONS) return false;
      this.ribbons.set([tail[0], tail[1], tail[2], width, head[0], head[1], head[2], alphaTail, colour[0], colour[1], colour[2], alphaHead], ribbons * RIBBON_FLOATS);
      ribbons++;
      return true;
    };

    // Tracers: the round's last tracer_length_m, its offset from where it left to where it is
    // drawn from shrinking to nothing by tracer_converge_m.
    let tracers = 0;
    const seg = session.rounds.tracerSegments(t.tracerLengthM);
    const glow = t.tracerColour.map((c) => c * t.tracerIntensity);
    for (let i = 0; i < seg.flown.length; i++) {
      const at = (a: Float32Array) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
      const head = at(seg.head);
      const tail = at(seg.tail);
      const length = Math.hypot(head[0] - tail[0], head[1] - tail[1], head[2] - tail[2]);
      if (!(length > 0)) continue;
      const from = at(seg.from);
      const origin = at(seg.origin);
      const offset = [from[0] - origin[0], from[1] - origin[1], from[2] - origin[2]];
      const share = (flown: number) => Math.max(0, 1 - flown / t.tracerConvergeM);
      const h = share(seg.flown[i]);
      const s = share(seg.flown[i] - length);
      if (!ribbon(tail.map((v, k) => v + offset[k] * s), head.map((v, k) => v + offset[k] * h), t.tracerWidthM, glow, t.tracerTailAlpha, 1)) break;
      tracers++;
    }

    // Each live flash: its star and its light.
    let stars = 0;
    const lights: TransientLight[] = [];
    const flash = t.flashColour.map((c) => c * t.flashIntensity);
    for (const f of this.flashes) {
      const d = f.dir;
      let side: V3 = [d[2], 0, -d[0]];
      const level = Math.hypot(side[0], side[2]);
      side = level > 1e-6 ? [side[0] / level, 0, side[2] / level] : [1, 0, 0];
      const up: V3 = [d[1] * side[2] - d[2] * side[1], d[2] * side[0] - d[0] * side[2], d[0] * side[1] - d[1] * side[0]];
      const rays: [V3, number][] = [[d, t.flashStarLengthM]];
      for (const sign of [1, -1]) {
        const r = [0, 1, 2].map((k) => d[k] * Math.cos(STAR_SIDE) + sign * side[k] * Math.sin(STAR_SIDE) + up[k] * STAR_LIFT);
        const n = Math.hypot(r[0], r[1], r[2]);
        rays.push([[r[0] / n, r[1] / n, r[2] / n], t.flashStarLengthM * STAR_SIDE_LENGTH]);
      }
      for (const [r, length] of rays) {
        if (ribbon(f.muzzle, f.muzzle.map((v, k) => v + r[k] * length), t.flashStarWidthM, flash, 1, 0)) stars++;
      }
      lights.push({ position: f.muzzle, radiusM: t.flashLightRadiusM, colour: t.flashLightColour, intensity: t.flashLightIntensity });
      f.frames--;
    }
    this.flashes = this.flashes.filter((f) => f.frames > 0);
    lights.push(...this.debugLights);

    return {
      frame: { billboards: this.billboards, billboardCount: billboards, ribbons: this.ribbons, ribbonCount: ribbons },
      lights,
      counts: { billboards, tracers, stars, lights: lights.length },
    };
  }
}
