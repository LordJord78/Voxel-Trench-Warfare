/**
 * Particles, ported from the reference's `combat/particles.py`: cosmetic,
 * deterministic, and simulated on the simulation's side, so a headless run
 * throws the same brass as a windowed one. Nothing reads them back.
 *
 * Struct-of-arrays float64 in a fixed pool; live particles are a prefix of it.
 * A step is the reference's: velocity loses `drag`·dt of itself (per second),
 * gravity adds to its y, then it moves; a particle at the end of its life is
 * removed in place, the rest keeping their order. `emit` draws as the
 * reference's does — speed jittered by N(0, `speedJitter`), then an N(0, 1)
 * vector times `spread` added — and a full pool refuses the rest and counts
 * them. Billboards run size and colour from start to end by age, for the
 * renderer (effects.ts), which lights the ones not emissive, and blood (its
 * own kind) no darker than a floor and no smaller than a few pixels, so it reads
 * at range and at dusk; a casing (the brass, its own kind) is drawn along its
 * way, its billboard carrying its velocity's direction.
 *
 * A particle may be anchored to a point the renderer draws elsewhere than the
 * simulation holds it (the shot's flash, brass and smoke, to the drawn rifle's
 * muzzle and port): its billboard is drawn off by where that point is drawn now
 * less where the particle was thrown, so it leaves the rifle as drawn whatever
 * has moved it since (the shot's own kick, thrown before it, 17 cm at the SVD's
 * muzzle). The flash and brass then join their own paths as they age (`heldShare`);
 * a kept one (the smoke) keeps that drift as the frame that first drew it held it
 * (`hold`), for good: it stays where the drawn gun left it. The wind (`wind`, set each frame from the
 * battle's) carries each kind by its share ([particles.<kind>] wind): a velocity
 * added to its own as it moves, the light ones whole, the heavy barely or not.
 */

import { pow } from '../core/dmath';
import type { Rng } from '../core/rng';
import type { Tunables } from '../core/tunables';

export interface ParticleSpec {
  lifeS: number;
  gravity: number;
  /** Per-second velocity decay. */
  drag: number;
  sizeStartM: number;
  sizeEndM: number;
  /** How its size runs from start to end: start + (end − start)(1 − (1 − t)^k) at t of its life, k this (1, or none: evenly). A puff of mist bursts out and then slows. */
  sizeEase?: number;
  colourStart: [number, number, number, number];
  colourEnd: [number, number, number, number];
  /** Light of its own (the flash, sparks), or lit by the world (brass, dust). */
  emissive: boolean;
  /** Drawn square (a shell's debris), not round; lit, unless emissive. */
  square: boolean;
  /** Blood (its table's `blood = true`): a lit disc of its own kind, BLOOD_BILLBOARD. */
  blood?: boolean;
  /** A casing (its table's `casing = true`, the brass): lit, of its own kind, CASING_BILLBOARD, drawn along its way. */
  casing?: boolean;
  /** Smoke (its table's `smoke = true`, the muzzle's): lit, of its own kind, SMOKE_BILLBOARD, drawn as a soft puff. */
  smoke?: boolean;
  /** How it is thrown: how many; speed along its direction, plus lift upward; spread and jitter. */
  count: number;
  speed: number;
  lift: number;
  spread: number;
  speedJitter: number;
  /** How much of the wind carries it: 1 the light (smoke, mist, dust), a little or none the heavy (droplets, soil, debris, brass), none the emissive. */
  wind: number;
}

function rgba(tun: Tunables, key: string): [number, number, number, number] {
  const value = tun.get(key);
  if (!Array.isArray(value) || value.length !== 4 || !value.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw new TypeError(`tunable '${key}' is not four finite numbers: ${JSON.stringify(value)}`);
  }
  return value as [number, number, number, number];
}

/** `[particles.<kind>]`. */
export function particleSpec(tun: Tunables, kind: string): ParticleSpec {
  const k = `particles.${kind}`;
  const emissive = tun.get(`${k}.emissive`);
  if (typeof emissive !== 'boolean') throw new TypeError(`tunable '${k}.emissive' is not true or false`);
  const square = tun.get(`${k}.square`);
  if (typeof square !== 'boolean') throw new TypeError(`tunable '${k}.square' is not true or false`);
  const blood = tun.has(`${k}.blood`) ? tun.get(`${k}.blood`) : false;
  if (typeof blood !== 'boolean') throw new TypeError(`tunable '${k}.blood' is not true or false`);
  const casing = tun.has(`${k}.casing`) ? tun.get(`${k}.casing`) : false;
  if (typeof casing !== 'boolean') throw new TypeError(`tunable '${k}.casing' is not true or false`);
  const smoke = tun.has(`${k}.smoke`) ? tun.get(`${k}.smoke`) : false;
  if (typeof smoke !== 'boolean') throw new TypeError(`tunable '${k}.smoke' is not true or false`);
  return {
    lifeS: tun.f(`${k}.life_s`),
    gravity: tun.f(`${k}.gravity`),
    drag: tun.f(`${k}.drag`),
    sizeStartM: tun.f(`${k}.size_start_m`),
    sizeEndM: tun.f(`${k}.size_end_m`),
    sizeEase: tun.has(`${k}.size_ease`) ? tun.f(`${k}.size_ease`) : 1,
    colourStart: rgba(tun, `${k}.colour_start`),
    colourEnd: rgba(tun, `${k}.colour_end`),
    emissive,
    square,
    blood,
    casing,
    smoke,
    count: tun.i(`${k}.count`),
    speed: tun.f(`${k}.speed`),
    lift: tun.f(`${k}.lift`),
    spread: tun.f(`${k}.spread`),
    speedJitter: tun.f(`${k}.speed_jitter`),
    wind: tun.f(`${k}.wind`),
  };
}

/**
 * How much of an anchored particle's drift it is drawn off by at `ageS` (s), joining its own path by
 * `driftS`: all of it when thrown, none from `driftS` on, eased out and in between (1 − a smootherstep),
 * so a particle a tick old is still on the drawn gun and none jolts as it lets go.
 */
export function heldShare(ageS: number, driftS: number): number {
  if (!(driftS > 0)) return 0;
  const u = Math.min(1, Math.max(0, ageS / driftS));
  return 1 - u * u * u * (u * (u * 6 - 15) + 10);
}

/**
 * A billboard's floats: centre (3), half its size (1), colour premultiplied by its alpha (4), its kind
 * (0 a lit disc, 1 emissive, 2 a lit square, BLOOD_BILLBOARD blood, CASING_BILLBOARD a casing,
 * SMOKE_BILLBOARD smoke), and a casing's way, the unit direction it is drawn along (3; zero for the
 * rest, and unread).
 */
export const BILLBOARD_FLOATS = 12;
/**
 * Blood's kind of billboard, after effects.ts's 3 (a tracer's head) and 4 (an ember): a lit disc, lit
 * no darker than [effects] blood_light_floor and drawn no smaller than blood_min_px across
 * (effects-light.wgsl), so a droplet at 25 m is not a pixel of soot.
 */
export const BLOOD_BILLBOARD = 5;
/**
 * A casing's kind of billboard (the brass): lit as a mote is, and drawn as a casing (effects.wgsl): its
 * half size half its length, along its way (the billboard's last three floats), [effects]
 * casing_width_share of it across, its length held to casing_max_px pixels (effects.wgsl casingDrawn).
 */
export const CASING_BILLBOARD = 6;
/**
 * Smoke's kind of billboard (the muzzle's): lit as a mote is, and drawn as a soft puff (effects.wgsl), its
 * light falling away from its middle to nothing at its rim. A mote's firm disc, lit by the shot's own light a
 * hand from the eye, read as a bright ball over the view and widened the tracer it hung about.
 */
export const SMOKE_BILLBOARD = 7;

export class Particles {
  count = 0;
  /** Particles a full pool refused. */
  dropped = 0;
  /** The wind (m/s), added to each particle's velocity as it moves, times its kind's share: the battle's, set each frame (app/main.ts); none unless set. */
  wind: [number, number, number] = [0, 0, 0];
  /** A billboard's floats (BILLBOARD_FLOATS), for what reads them in the page (the capture tools, the e2e tests). */
  readonly floats = BILLBOARD_FLOATS;
  private readonly pos: Float64Array;
  private readonly vel: Float64Array;
  private readonly age: Float64Array;
  private readonly life: Float64Array;
  private readonly gravity: Float64Array;
  private readonly drag: Float64Array;
  private readonly sizeStart: Float64Array;
  private readonly sizeEnd: Float64Array;
  private readonly sizeEase: Float64Array;
  private readonly colourStart: Float64Array;
  private readonly colourEnd: Float64Array;
  /** 0 lit, 1 emissive, 2 lit and square, BLOOD_BILLBOARD blood, CASING_BILLBOARD a casing, SMOKE_BILLBOARD smoke: the billboard's kind. */
  private readonly kind: Uint8Array;
  private readonly anchor: Uint8Array;
  /** Where each was thrown (m): an anchored one is drawn off by where its anchor is drawn less this. */
  private readonly from: Float64Array;
  /** Its kind's share of the wind. */
  private readonly windShare: Float64Array;
  /** An anchored one's drift kept for good: 0 not kept (eased out by heldShare), 1 kept and not yet held (`hold`), 2 kept as `kept` holds it. */
  private readonly keep: Uint8Array;
  private readonly kept: Float64Array;

  constructor(readonly capacity: number) {
    const n = capacity;
    this.pos = new Float64Array(n * 3);
    this.vel = new Float64Array(n * 3);
    this.age = new Float64Array(n);
    this.life = new Float64Array(n);
    this.gravity = new Float64Array(n);
    this.drag = new Float64Array(n);
    this.sizeStart = new Float64Array(n);
    this.sizeEnd = new Float64Array(n);
    this.sizeEase = new Float64Array(n);
    this.colourStart = new Float64Array(n * 4);
    this.colourEnd = new Float64Array(n * 4);
    this.kind = new Uint8Array(n);
    this.anchor = new Uint8Array(n);
    this.from = new Float64Array(n * 3);
    this.windShare = new Float64Array(n);
    this.keep = new Uint8Array(n);
    this.kept = new Float64Array(n * 3);
  }

  /**
   * `count` particles of `spec` from `origin` (m) at `velocity` (m/s), drawn about it with `rng` if
   * given, their colour times `tint` if given, anchored to `anchor` (0: none), and `kept` at the drift
   * they are first drawn with rather than joining their own paths: how many the pool took.
   */
  emit(origin: readonly number[], velocity: readonly number[], spec: ParticleSpec, count: number, rng?: Rng, tint?: readonly [number, number, number], anchor = 0, kept = false): number {
    const n = Math.max(0, Math.min(count, this.capacity - this.count));
    this.dropped += count - n;
    for (let k = 0; k < n; k++) {
      const i = this.count++;
      let scale = 1;
      let dx = 0;
      let dy = 0;
      let dz = 0;
      if (rng) {
        scale = 1 + rng.normal(0, spec.speedJitter);
        dx = rng.normal() * spec.spread;
        dy = rng.normal() * spec.spread;
        dz = rng.normal() * spec.spread;
      }
      this.pos[i * 3] = origin[0];
      this.pos[i * 3 + 1] = origin[1];
      this.pos[i * 3 + 2] = origin[2];
      this.from[i * 3] = origin[0];
      this.from[i * 3 + 1] = origin[1];
      this.from[i * 3 + 2] = origin[2];
      this.vel[i * 3] = velocity[0] * scale + dx;
      this.vel[i * 3 + 1] = velocity[1] * scale + dy;
      this.vel[i * 3 + 2] = velocity[2] * scale + dz;
      this.age[i] = 0;
      this.life[i] = spec.lifeS;
      this.gravity[i] = spec.gravity;
      this.drag[i] = spec.drag;
      this.sizeStart[i] = spec.sizeStartM;
      this.sizeEnd[i] = spec.sizeEndM;
      this.sizeEase[i] = spec.sizeEase ?? 1;
      for (let c = 0; c < 4; c++) {
        const t = c < 3 && tint ? tint[c] : 1;
        this.colourStart[i * 4 + c] = spec.colourStart[c] * t;
        this.colourEnd[i * 4 + c] = spec.colourEnd[c] * t;
      }
      this.kind[i] = spec.emissive ? 1 : spec.blood ? BLOOD_BILLBOARD : spec.casing ? CASING_BILLBOARD : spec.smoke ? SMOKE_BILLBOARD : spec.square ? 2 : 0;
      this.anchor[i] = anchor;
      this.windShare[i] = spec.wind;
      this.keep[i] = anchor > 0 && kept ? 1 : 0;
      this.kept.fill(0, i * 3, i * 3 + 3);
    }
    return n;
  }

  step(dt: number): void {
    let w = 0;
    const wind = this.wind;
    for (let i = 0; i < this.count; i++) {
      const keep = Math.max(0, 1 - this.drag[i] * dt);
      for (let k = 0; k < 3; k++) this.vel[i * 3 + k] *= keep;
      this.vel[i * 3 + 1] += this.gravity[i] * dt;
      // The wind carries each by its kind's share: smoke and mist whole, a droplet or a clod barely.
      const share = this.windShare[i];
      for (let k = 0; k < 3; k++) this.pos[i * 3 + k] += (this.vel[i * 3 + k] + wind[k] * share) * dt;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) continue;
      if (w !== i) this.move(i, w);
      w++;
    }
    this.count = w;
  }

  /**
   * A frame's drawing of the anchors, `anchors[a - 1]` where anchor `a` is drawn now (metres; none: not
   * drawn, as the rifle through a scope): each kept particle not yet held takes its drift from it,
   * where it is drawn less where it was thrown (none where its anchor is not drawn), for good. The
   * frame's builder holds them before it draws the billboards (app/effects-frame.ts).
   */
  hold(anchors?: readonly (readonly number[] | undefined)[]): void {
    for (let i = 0; i < this.count; i++) {
      if (this.keep[i] !== 1) continue;
      const a = anchors?.[this.anchor[i] - 1];
      for (let k = 0; k < 3; k++) this.kept[i * 3 + k] = a ? a[k] - this.from[i * 3 + k] : 0;
      this.keep[i] = 2;
    }
  }

  /**
   * Each live particle's billboard into `out` (BILLBOARD_FLOATS each): how many. A particle anchored
   * to `a` is drawn off by where that anchor is drawn now, `anchors[a - 1]` (metres), less where it was
   * thrown: all of it when thrown and none by `driftS` (heldShare); a kept one by its drift as it was
   * held (`hold`), whatever its age, and where it is if not yet held. It changes nothing.
   */
  billboards(out: Float32Array, anchors?: readonly (readonly number[] | undefined)[], driftS = 0): number {
    const n = Math.min(this.count, Math.floor(out.length / BILLBOARD_FLOATS));
    for (let i = 0; i < n; i++) {
      const t = Math.min(1, Math.max(0, this.age[i] / this.life[i]));
      const o = i * BILLBOARD_FLOATS;
      const a = this.anchor[i];
      const drawn = a > 0 && this.keep[i] === 0 ? anchors?.[a - 1] : undefined;
      if (this.keep[i] === 2) for (let k = 0; k < 3; k++) out[o + k] = this.pos[i * 3 + k] + this.kept[i * 3 + k];
      else if (drawn) {
        const share = heldShare(this.age[i], driftS);
        for (let k = 0; k < 3; k++) out[o + k] = this.pos[i * 3 + k] + (drawn[k] - this.from[i * 3 + k]) * share;
      } else for (let k = 0; k < 3; k++) out[o + k] = this.pos[i * 3 + k];
      const grown = this.sizeEase[i] === 1 ? t : 1 - pow(1 - t, this.sizeEase[i]);
      out[o + 3] = (this.sizeStart[i] + (this.sizeEnd[i] - this.sizeStart[i]) * grown) * 0.5;
      const alpha = this.colourStart[i * 4 + 3] + (this.colourEnd[i * 4 + 3] - this.colourStart[i * 4 + 3]) * t;
      for (let c = 0; c < 3; c++) out[o + 4 + c] = (this.colourStart[i * 4 + c] + (this.colourEnd[i * 4 + c] - this.colourStart[i * 4 + c]) * t) * alpha;
      out[o + 7] = alpha;
      out[o + 8] = this.kind[i];
      // A casing's way: its velocity's direction (none while it is still).
      let ax = 0;
      let ay = 0;
      let az = 0;
      if (this.kind[i] === CASING_BILLBOARD) {
        const vx = this.vel[i * 3];
        const vy = this.vel[i * 3 + 1];
        const vz = this.vel[i * 3 + 2];
        const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (speed > 0) [ax, ay, az] = [vx / speed, vy / speed, vz / speed];
      }
      out[o + 9] = ax;
      out[o + 10] = ay;
      out[o + 11] = az;
    }
    return n;
  }

  /** Where particle `i` was thrown (metres). */
  thrown(i: number): [number, number, number] {
    return [this.from[i * 3], this.from[i * 3 + 1], this.from[i * 3 + 2]];
  }

  /** Copy particle `from` into slot `to`. */
  private move(from: number, to: number): void {
    this.pos.copyWithin(to * 3, from * 3, from * 3 + 3);
    this.vel.copyWithin(to * 3, from * 3, from * 3 + 3);
    this.age[to] = this.age[from];
    this.life[to] = this.life[from];
    this.gravity[to] = this.gravity[from];
    this.drag[to] = this.drag[from];
    this.sizeStart[to] = this.sizeStart[from];
    this.sizeEnd[to] = this.sizeEnd[from];
    this.sizeEase[to] = this.sizeEase[from];
    this.colourStart.copyWithin(to * 4, from * 4, from * 4 + 4);
    this.colourEnd.copyWithin(to * 4, from * 4, from * 4 + 4);
    this.kind[to] = this.kind[from];
    this.anchor[to] = this.anchor[from];
    this.from.copyWithin(to * 3, from * 3, from * 3 + 3);
    this.windShare[to] = this.windShare[from];
    this.keep[to] = this.keep[from];
    this.kept.copyWithin(to * 3, from * 3, from * 3 + 3);
  }
}
