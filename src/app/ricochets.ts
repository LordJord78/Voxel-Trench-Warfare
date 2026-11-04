/**
 * Embers and ricochets (the shots spec §1). A tracer that strikes leaves an ember — a spark of its
 * colour that fades over `ember_s` — and one that strikes at a graze (within `max_deg` of the
 * face's plane) glances off, sometimes: `chance_hard` off timber, steel and masonry, `chance_soil`
 * off the rest. It leaves along the reflection, within `turn_deg` of it, at `speed` of its own,
 * falls under gravity and burns out, fading, in `burn_s`. The draws come from the impact (a hash of
 * its cell, tick, material, owner and place, seeding an Rng), never from a clock or Math.random, so
 * the same events give the same ricochets. Time is explicit: `step(dt)` ages them by the world's.
 */

import type { Impact } from '../combat/ballistics';
import { hash32 } from '../core/hash';
import { Rng } from '../core/rng';
import type { Tunables } from '../core/tunables';
import { K, PALETTE_KIND } from '../world/materials';

type V3 = [number, number, number];

export interface RicochetTunables {
  maxDeg: number;
  chanceSoil: number;
  chanceHard: number;
  turnDeg: number;
  speed: [number, number];
  burnS: [number, number];
  max: number;
  emberM: number;
  emberS: number;
  /** Gravity (m/s², negative down), [ballistics]'s. */
  gravity: number;
  /** A flight's streak: this much of its flight (s) behind its head, no longer than it has flown; [effects].tracer_streak_s. */
  trailS: number;
}

export function ricochetTunables(tun: Tunables): RicochetTunables {
  const f = (k: string) => tun.f(`effects.ricochet.${k}`);
  return {
    maxDeg: f('max_deg'),
    chanceSoil: f('chance_soil'),
    chanceHard: f('chance_hard'),
    turnDeg: f('turn_deg'),
    speed: tun.pair('effects.ricochet.speed'),
    burnS: tun.pair('effects.ricochet.burn_s'),
    max: tun.i('effects.ricochet.max'),
    emberM: f('ember_m'),
    emberS: f('ember_s'),
    gravity: tun.f('ballistics.gravity'),
    trailS: tun.f('effects.tracer_streak_s'),
  };
}

/** The kinds that ring a round off: wood, steel, wire and masonry (concrete, brick and its mortar). */
const HARD = new Set<number>([K.TIMBER, K.TRUNK, K.DUCKBOARD, K.HULL, K.PICKET, K.CORRUGATE, K.WIRE, K.CONCRETE, K.BRICK, K.MORTAR]);

interface Ember {
  at: V3;
  kind: number;
  age: number;
}

interface Flight {
  pos: V3;
  vel: V3;
  kind: number;
  age: number;
  burnS: number;
  /** Path length since the strike (m). */
  flown: number;
}

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: V3): V3 => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

export class Ricochets {
  private emberList: Ember[] = [];
  private flightList: Flight[] = [];

  constructor(private readonly t: RicochetTunables) {}

  /** A tracer of `colourKind` (net/gear.ts TRACER_KIND) struck: its ember, and, drawn from the impact, its ricochet. */
  strike(i: Impact & { tick?: number }, colourKind: number): void {
    const t = this.t;
    this.emberList.push({ at: [i.position[0], i.position[1], i.position[2]], kind: colourKind, age: 0 });
    const seed = hash32(i.cell[0], i.cell[1], i.cell[2], i.tick ?? 0, i.material, i.owner, Math.round(i.position[0] * 100), Math.round(i.position[1] * 100), Math.round(i.position[2] * 100));
    const rng = Rng.root(seed);
    // Every draw is made whether or not it is used, so the stream never depends on the outcome.
    const roll = rng.float();
    const spin = rng.float() * 2 * Math.PI;
    const lean = rng.float();
    const speedDraw = rng.float();
    const burnDraw = rng.float();
    const n = i.normal;
    if (n[0] === 0 && n[1] === 0 && n[2] === 0) return;
    const d = i.dir;
    const into = dot(d, n);
    // Within max_deg of the face's plane: the angle to the plane is asin of its part along the normal.
    if (!(into < 0) || -into > Math.sin((t.maxDeg * Math.PI) / 180)) return;
    const chance = HARD.has(PALETTE_KIND[i.material]) ? t.chanceHard : t.chanceSoil;
    if (!(roll < chance)) return;

    const reflect: V3 = [d[0] - 2 * into * n[0], d[1] - 2 * into * n[1], d[2] - 2 * into * n[2]];
    // Two directions across it, to turn it by up to turn_deg toward any side.
    const pick: V3 = Math.abs(reflect[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = unit([reflect[1] * pick[2] - reflect[2] * pick[1], reflect[2] * pick[0] - reflect[0] * pick[2], reflect[0] * pick[1] - reflect[1] * pick[0]]);
    const w: V3 = [reflect[1] * u[2] - reflect[2] * u[1], reflect[2] * u[0] - reflect[0] * u[2], reflect[0] * u[1] - reflect[1] * u[0]];
    const turn = (t.turnDeg * Math.PI) / 180 * lean;
    const c = Math.cos(turn);
    const s = Math.sin(turn);
    const side: V3 = [u[0] * Math.cos(spin) + w[0] * Math.sin(spin), u[1] * Math.cos(spin) + w[1] * Math.sin(spin), u[2] * Math.cos(spin) + w[2] * Math.sin(spin)];
    let out: V3 = [reflect[0] * c + side[0] * s, reflect[1] * c + side[1] * s, reflect[2] * c + side[2] * s];
    // Never into the face it glanced off: mirrored back out, which only brings it nearer the reflection.
    const out0 = dot(out, n);
    if (out0 < 0) out = [out[0] - 2 * out0 * n[0], out[1] - 2 * out0 * n[1], out[2] - 2 * out0 * n[2]];
    out = unit(out);
    const speed = i.speed * (t.speed[0] + (t.speed[1] - t.speed[0]) * speedDraw);
    this.flightList.push({
      pos: [i.position[0], i.position[1], i.position[2]],
      vel: [out[0] * speed, out[1] * speed, out[2] * speed],
      kind: colourKind,
      age: 0,
      burnS: t.burnS[0] + (t.burnS[1] - t.burnS[0]) * burnDraw,
      flown: 0,
    });
    if (this.flightList.length > t.max) this.flightList.splice(0, this.flightList.length - t.max);
  }

  /** Age everything by `dt` seconds of the world's time: flights move and fall, and the spent go. */
  step(dt: number): void {
    if (!(dt > 0)) return;
    for (const e of this.emberList) e.age += dt;
    this.emberList = this.emberList.filter((e) => e.age < this.t.emberS);
    for (const f of this.flightList) {
      f.age += dt;
      f.vel[1] += this.t.gravity * dt;
      const before = f.pos.slice() as V3;
      for (let k = 0; k < 3; k++) f.pos[k] += f.vel[k] * dt;
      f.flown += Math.hypot(f.pos[0] - before[0], f.pos[1] - before[1], f.pos[2] - before[2]);
    }
    this.flightList = this.flightList.filter((f) => f.age < f.burnS);
  }

  /** The embers: where, how wide (m), of which tracer kind, and how bright (1 to 0 over ember_s). */
  embers(): { at: V3; size: number; kind: number; alpha: number }[] {
    return this.emberList.map((e) => ({ at: [e.at[0], e.at[1], e.at[2]], size: this.t.emberM, kind: e.kind, alpha: 1 - e.age / this.t.emberS }));
  }

  /** The ricochets in flight: the streak from tail to head, of a tracer kind, fading (1 to 0) over its burn. */
  flights(): { tail: V3; head: V3; kind: number; alpha: number }[] {
    return this.flightList.map((f) => {
      const speed = Math.hypot(f.vel[0], f.vel[1], f.vel[2]);
      const back = speed > 0 ? Math.min(f.flown, speed * this.t.trailS) / speed : 0;
      return {
        tail: [f.pos[0] - f.vel[0] * back, f.pos[1] - f.vel[1] * back, f.pos[2] - f.vel[2] * back],
        head: [f.pos[0], f.pos[1], f.pos[2]],
        kind: f.kind,
        alpha: 1 - f.age / f.burnS,
      };
    });
  }
}
