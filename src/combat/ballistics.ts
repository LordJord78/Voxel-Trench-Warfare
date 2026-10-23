/**
 * Rounds in flight, ported from the reference's `combat/ballistics.py`: quadratic
 * drag and real gravity, integrated by semi-implicit Euler in fixed substeps of
 * the 60 Hz tick, in float64.
 *
 *     a = g − (½ ρ Cd A / m) |v| v
 *
 * Everything constant in the bracket but ρ is folded into
 * `ProjectileSpec.dragFactor` once, so the inner loop is two multiplies, and a
 * 5.45 mm round and anything heavier fall differently without either being a
 * special case. A round's dispersion is drawn when it leaves the muzzle
 * (weapon.ts); after that its path is a pure function of its state, so the same
 * seed puts the same round through the same voxel.
 *
 * The pool is struct-of-arrays: live rounds are a prefix of it, retired by
 * swap-with-last. Each substep's segment is raycast through the brick map
 * (world/raycast.ts): the first solid voxel stops the round, and water, wire,
 * cloth and air let it through. A round past its range or flight time, or out
 * of the world's box, is retired; the far field is not hit.
 */

import { hypot } from '../core/dmath';
import type { Tunables } from '../core/tunables';
import type { BrickMap } from '../world/bricks';
import { raycast } from '../world/raycast';

/** What flies, as opposed to what fired it. */
export interface ProjectileSpec {
  name: string;
  muzzleVelocity: number;
  massKg: number;
  /** ½ · Cd · A / m, in m²/kg. */
  dragFactor: number;
}

/** A weapon's round, from its `[weapon.<key>]` table. */
export function projectileSpec(tun: Tunables, weapon: string): ProjectileSpec {
  const key = `weapon.${weapon}`;
  const massKg = tun.f(`${key}.projectile_mass_kg`);
  return {
    name: String(tun.section(key).name),
    muzzleVelocity: tun.f(`${key}.muzzle_velocity`),
    massKg,
    dragFactor: (0.5 * tun.f(`${key}.drag_coefficient`) * tun.f(`${key}.cross_section_m2`)) / massKg,
  };
}

export interface BallisticsTunables {
  gravity: number;
  airDensity: number;
  substeps: number;
  capacity: number;
  maxRangeM: number;
  maxFlightS: number;
}

export function ballisticsTunables(tun: Tunables): BallisticsTunables {
  return {
    gravity: tun.f('ballistics.gravity'),
    airDensity: tun.f('ballistics.air_density'),
    substeps: tun.i('ballistics.substeps_per_tick'),
    capacity: tun.i('ballistics.pool_capacity'),
    maxRangeM: tun.f('ballistics.max_range_m'),
    maxFlightS: tun.f('ballistics.max_flight_time_s'),
  };
}

/** A round stopped by the world. */
export interface Impact {
  /** Where it entered the voxel, in metres. */
  position: [number, number, number];
  /** The struck face's outward normal; (0, 0, 0) for a round that started inside the voxel. */
  normal: [number, number, number];
  /** The voxel. */
  cell: [number, number, number];
  material: number;
  /** m/s at the start of the substep that struck (the reference's). */
  speed: number;
  /** Path length from the muzzle to the hit, in metres. */
  distance: number;
  energyJ: number;
  owner: number;
  spec: string;
}

export class Rounds {
  /** Live rounds: slots [0, count). */
  count = 0;
  /** Shots the pool refused for being full. */
  dropped = 0;
  /** The last step's impacts, in slot order. */
  readonly impacts: Impact[] = [];
  private readonly pos: Float64Array;
  private readonly vel: Float64Array;
  private readonly distance: Float64Array;
  private readonly age: Float64Array;
  private readonly specIndex: Int32Array;
  private readonly owner: Int8Array;
  private readonly tracer: Uint8Array;
  private readonly specs: ProjectileSpec[] = [];
  private readonly size: [number, number, number];

  constructor(
    private readonly t: BallisticsTunables,
    private readonly map: BrickMap,
    private readonly voxel: number,
  ) {
    const n = t.capacity;
    this.pos = new Float64Array(n * 3);
    this.vel = new Float64Array(n * 3);
    this.distance = new Float64Array(n);
    this.age = new Float64Array(n);
    this.specIndex = new Int32Array(n);
    this.owner = new Int8Array(n);
    this.tracer = new Uint8Array(n);
    this.size = [map.dims.x * voxel, map.dims.y * voxel, map.dims.z * voxel];
  }

  /** A round leaving `origin` (m) at `velocity` (m/s): its slot, or −1 if the pool is full or the velocity is zero. */
  fire(origin: readonly [number, number, number], velocity: readonly [number, number, number], spec: ProjectileSpec, owner: number, tracer: boolean): number {
    if (velocity[0] === 0 && velocity[1] === 0 && velocity[2] === 0) return -1;
    if (this.count >= this.t.capacity) {
      this.dropped++;
      return -1;
    }
    const i = this.count++;
    this.pos.set(origin, i * 3);
    this.vel.set(velocity, i * 3);
    this.distance[i] = 0;
    this.age[i] = 0;
    let s = this.specs.indexOf(spec);
    if (s < 0) s = this.specs.push(spec) - 1;
    this.specIndex[i] = s;
    this.owner[i] = owner;
    this.tracer[i] = tracer ? 1 : 0;
    return i;
  }

  /** One tick of `dt` seconds in substeps: this step's impacts, and rounds retired by range, age or the world's edge. */
  step(dt: number): void {
    this.impacts.length = 0;
    const h = dt / this.t.substeps;
    const retire: number[] = [];
    for (let s = 0; s < this.t.substeps; s++) {
      retire.length = 0;
      for (let i = 0; i < this.count; i++) if (this.advance(i, h)) retire.push(i);
      for (let k = retire.length - 1; k >= 0; k--) this.remove(retire[k]);
    }
  }

  position(slot: number): [number, number, number] {
    return [this.pos[slot * 3], this.pos[slot * 3 + 1], this.pos[slot * 3 + 2]];
  }

  velocity(slot: number): [number, number, number] {
    return [this.vel[slot * 3], this.vel[slot * 3 + 1], this.vel[slot * 3 + 2]];
  }

  /** Each tracer round's head and its tail, up to `lengthM` back along its path (no further than it has flown), as [x, y, z] triples in metres. */
  tracerSegments(lengthM: number): { head: Float32Array; tail: Float32Array } {
    let n = 0;
    for (let i = 0; i < this.count; i++) n += this.tracer[i];
    const head = new Float32Array(n * 3);
    const tail = new Float32Array(n * 3);
    let o = 0;
    for (let i = 0; i < this.count; i++) {
      if (!this.tracer[i]) continue;
      const v = this.velocity(i);
      const speed = hypot(v[0], v[1], v[2]);
      const back = speed > 0 ? Math.min(lengthM, this.distance[i]) / speed : 0;
      for (let k = 0; k < 3; k++) {
        head[o + k] = this.pos[i * 3 + k];
        tail[o + k] = this.pos[i * 3 + k] - v[k] * back;
      }
      o += 3;
    }
    return { head, tail };
  }

  /** One substep of round `i`: whether it is to be retired. */
  private advance(i: number, h: number): boolean {
    const spec = this.specs[this.specIndex[i]];
    const p = i * 3;
    const vx0 = this.vel[p];
    const vy0 = this.vel[p + 1];
    const vz0 = this.vel[p + 2];
    const speed = hypot(vx0, vy0, vz0);
    const drag = spec.dragFactor * this.t.airDensity * speed * h;
    const vx = vx0 - vx0 * drag;
    const vy = vy0 - vy0 * drag + this.t.gravity * h;
    const vz = vz0 - vz0 * drag;
    this.vel[p] = vx;
    this.vel[p + 1] = vy;
    this.vel[p + 2] = vz;
    const tx = vx * h;
    const ty = vy * h;
    const tz = vz * h;
    const len = hypot(tx, ty, tz);
    this.age[i] += h;
    if (len > 0) {
      const dir: [number, number, number] = [tx / len, ty / len, tz / len];
      const v = this.voxel;
      const hit = raycast(this.map, [this.pos[p] / v, this.pos[p + 1] / v, this.pos[p + 2] / v], dir, len / v);
      if (hit) {
        const m = hit.t * v;
        const normal: [number, number, number] = [0, 0, 0];
        if (hit.face >= 0) normal[hit.face >> 1] = hit.face & 1 ? 1 : -1;
        this.impacts.push({
          position: [this.pos[p] + dir[0] * m, this.pos[p + 1] + dir[1] * m, this.pos[p + 2] + dir[2] * m],
          normal,
          cell: hit.cell,
          material: hit.material,
          speed,
          distance: this.distance[i] + m,
          energyJ: 0.5 * spec.massKg * speed * speed,
          owner: this.owner[i],
          spec: spec.name,
        });
        return true;
      }
    }
    this.pos[p] += tx;
    this.pos[p + 1] += ty;
    this.pos[p + 2] += tz;
    this.distance[i] += len;
    const x = this.pos[p];
    const y = this.pos[p + 1];
    const z = this.pos[p + 2];
    const [sx, sy, sz] = this.size;
    return this.distance[i] >= this.t.maxRangeM || this.age[i] >= this.t.maxFlightS || x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz;
  }

  /** Retire slot `i`: the last live round takes its place. */
  private remove(i: number): void {
    const last = --this.count;
    if (i === last) return;
    this.pos.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.vel.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.distance[i] = this.distance[last];
    this.age[i] = this.age[last];
    this.specIndex[i] = this.specIndex[last];
    this.owner[i] = this.owner[last];
    this.tracer[i] = this.tracer[last];
  }
}
