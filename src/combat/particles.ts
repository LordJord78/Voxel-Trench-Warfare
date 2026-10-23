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
 * renderer (effects.ts), which lights the ones not emissive.
 */

import type { Rng } from '../core/rng';
import type { Tunables } from '../core/tunables';

export interface ParticleSpec {
  lifeS: number;
  gravity: number;
  /** Per-second velocity decay. */
  drag: number;
  sizeStartM: number;
  sizeEndM: number;
  colourStart: [number, number, number, number];
  colourEnd: [number, number, number, number];
  /** Light of its own (the flash, sparks), or lit by the world (brass, dust). */
  emissive: boolean;
  /** How it is thrown: how many; speed along its direction, plus lift upward; spread and jitter. */
  count: number;
  speed: number;
  lift: number;
  spread: number;
  speedJitter: number;
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
  return {
    lifeS: tun.f(`${k}.life_s`),
    gravity: tun.f(`${k}.gravity`),
    drag: tun.f(`${k}.drag`),
    sizeStartM: tun.f(`${k}.size_start_m`),
    sizeEndM: tun.f(`${k}.size_end_m`),
    colourStart: rgba(tun, `${k}.colour_start`),
    colourEnd: rgba(tun, `${k}.colour_end`),
    emissive,
    count: tun.i(`${k}.count`),
    speed: tun.f(`${k}.speed`),
    lift: tun.f(`${k}.lift`),
    spread: tun.f(`${k}.spread`),
    speedJitter: tun.f(`${k}.speed_jitter`),
  };
}

/** A billboard's floats: centre (3), half its size (1), colour premultiplied by its alpha (4), emissive (1, or 0). */
export const BILLBOARD_FLOATS = 9;

export class Particles {
  count = 0;
  /** Particles a full pool refused. */
  dropped = 0;
  private readonly pos: Float64Array;
  private readonly vel: Float64Array;
  private readonly age: Float64Array;
  private readonly life: Float64Array;
  private readonly gravity: Float64Array;
  private readonly drag: Float64Array;
  private readonly sizeStart: Float64Array;
  private readonly sizeEnd: Float64Array;
  private readonly colourStart: Float64Array;
  private readonly colourEnd: Float64Array;
  private readonly emissive: Uint8Array;

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
    this.colourStart = new Float64Array(n * 4);
    this.colourEnd = new Float64Array(n * 4);
    this.emissive = new Uint8Array(n);
  }

  /** `count` particles of `spec` from `origin` (m) at `velocity` (m/s), drawn about it with `rng` if given, their colour times `tint` if given: how many the pool took. */
  emit(origin: readonly number[], velocity: readonly number[], spec: ParticleSpec, count: number, rng?: Rng, tint?: readonly [number, number, number]): number {
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
      this.vel[i * 3] = velocity[0] * scale + dx;
      this.vel[i * 3 + 1] = velocity[1] * scale + dy;
      this.vel[i * 3 + 2] = velocity[2] * scale + dz;
      this.age[i] = 0;
      this.life[i] = spec.lifeS;
      this.gravity[i] = spec.gravity;
      this.drag[i] = spec.drag;
      this.sizeStart[i] = spec.sizeStartM;
      this.sizeEnd[i] = spec.sizeEndM;
      for (let c = 0; c < 4; c++) {
        const t = c < 3 && tint ? tint[c] : 1;
        this.colourStart[i * 4 + c] = spec.colourStart[c] * t;
        this.colourEnd[i * 4 + c] = spec.colourEnd[c] * t;
      }
      this.emissive[i] = spec.emissive ? 1 : 0;
    }
    return n;
  }

  step(dt: number): void {
    let w = 0;
    for (let i = 0; i < this.count; i++) {
      const keep = Math.max(0, 1 - this.drag[i] * dt);
      for (let k = 0; k < 3; k++) this.vel[i * 3 + k] *= keep;
      this.vel[i * 3 + 1] += this.gravity[i] * dt;
      for (let k = 0; k < 3; k++) this.pos[i * 3 + k] += this.vel[i * 3 + k] * dt;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) continue;
      if (w !== i) this.move(i, w);
      w++;
    }
    this.count = w;
  }

  /** Each live particle's billboard into `out` (BILLBOARD_FLOATS each): how many. */
  billboards(out: Float32Array): number {
    const n = Math.min(this.count, Math.floor(out.length / BILLBOARD_FLOATS));
    for (let i = 0; i < n; i++) {
      const t = Math.min(1, Math.max(0, this.age[i] / this.life[i]));
      const o = i * BILLBOARD_FLOATS;
      out[o] = this.pos[i * 3];
      out[o + 1] = this.pos[i * 3 + 1];
      out[o + 2] = this.pos[i * 3 + 2];
      out[o + 3] = (this.sizeStart[i] + (this.sizeEnd[i] - this.sizeStart[i]) * t) * 0.5;
      const alpha = this.colourStart[i * 4 + 3] + (this.colourEnd[i * 4 + 3] - this.colourStart[i * 4 + 3]) * t;
      for (let c = 0; c < 3; c++) out[o + 4 + c] = (this.colourStart[i * 4 + c] + (this.colourEnd[i * 4 + c] - this.colourStart[i * 4 + c]) * t) * alpha;
      out[o + 7] = alpha;
      out[o + 8] = this.emissive[i];
    }
    return n;
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
    this.colourStart.copyWithin(to * 4, from * 4, from * 4 + 4);
    this.colourEnd.copyWithin(to * 4, from * 4, from * 4 + 4);
    this.emissive[to] = this.emissive[from];
  }
}
