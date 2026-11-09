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
 * cloth and air let it through; where it goes into water, it splashes. A round
 * past its range or flight time, or out over the world's sides or under its
 * floor, is retired; one over its top flies on (nothing up there is solid, and
 * the cast clips to the box), so a stream fired up does not vanish in mid-air.
 * The far field is not hit.
 */

import { exp, hypot } from '../core/dmath';
import type { Tunables } from '../core/tunables';
import type { BrickMap } from '../world/bricks';
import { raycast, type WaterEntry } from '../world/raycast';
import type { Zone } from './soldier-rig';

/** A round's ignite distance not given (TracerDraw.igniteM): the draw lights it in as its own. */
const UNSET = -1;
/** A round fired with no pull of the trigger said (Rounds.fire's `shot`): its hits carry none. */
const NO_SHOT = -1;

/** What flies, as opposed to what fired it. */
export interface ProjectileSpec {
  name: string;
  muzzleVelocity: number;
  massKg: number;
  /** ½ · Cd · A / m, in m²/kg. */
  dragFactor: number;
  /** The gun that fires it (net/gear.ts GUNS), for what its hits do; none, the battle's. */
  gun?: number;
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

/**
 * How far a shot from `eye` (m) along `dir` is aimed: the first thing on its line, within `minM` and
 * `maxM` (into the sky, or nothing within `maxM`: `maxM`). The first solid, or nearer than it a body
 * the shooter's round would strike: `body` says how far along the line (unit `u`, within `m` metres)
 * one stops it, if one does. A shooter's tracer joins its round's path there (effects-frame.ts), so
 * from the hip it reaches across to where the reticle sat.
 */
export function aimRangeM(map: BrickMap, voxel: number, eye: readonly [number, number, number], dir: readonly [number, number, number], minM: number, maxM: number, body?: (u: readonly [number, number, number], m: number) => number | null): number {
  const n = hypot(dir[0], dir[1], dir[2]);
  if (!(n > 0)) return maxM;
  const u: [number, number, number] = [dir[0] / n, dir[1] / n, dir[2] / n];
  const hit = raycast(map, [eye[0] / voxel, eye[1] / voxel, eye[2] / voxel], u, maxM / voxel);
  let m = hit ? hit.t * voxel : maxM;
  const struck = body?.(u, m) ?? null;
  if (struck !== null) m = struck;
  return Math.min(maxM, Math.max(minM, m));
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

/**
 * How a round's tracer is drawn, where the shooter says (Rounds.fire): from `from` (the drawn
 * muzzle; the round's origin, unless given), joining its path `convergeM` out (aimRangeM, where the
 * shot was aimed; 0, unless given: it leaves where it is drawn from), lit in over `igniteM` (the
 * shooter's, by how aimed the shot was; unless given, unset (−1): the draw's own, a hip shot's).
 */
export interface TracerDraw {
  from?: readonly [number, number, number];
  convergeM?: number;
  igniteM?: number;
}

/** Where a round stops in a body: how far along its segment (m), whose body, and where it struck. */
export type BodyTest = (owner: number, from: readonly [number, number, number], dir: readonly [number, number, number], length: number) => { t: number; body: number; zone: Zone } | null;

/**
 * A tracer round's draw, carried by the strike that retired it (the pool's own; never sent to the
 * room): where it left and where its tracer is drawn from, how far out it joins its path (m; 0: drawn
 * on it), over how far it is lit in (m; −1 unset: the draw's own), its speed as it struck (m/s), and
 * its kind (net/gear.ts TRACER_KIND). The frame that drains the strike draws the last of its flight by
 * it (effects-frame.ts), so a round whose flight ends within the frame's ticks is seen.
 */
export interface StrikeDraw {
  origin: [number, number, number];
  from: [number, number, number];
  convergeM: number;
  igniteM: number;
  speed: number;
  kind: number;
}

export interface BodyHit {
  owner: number;
  body: number;
  zone: Zone;
  position: [number, number, number];
  dir: readonly [number, number, number];
  /** How far the round had flown (m). */
  distance: number;
  /** The gun it left (its spec's), if it says. */
  gun?: number;
  /**
   * The pull of the trigger it left on (Rounds.fire's `shot`; the player's: the tick it was fired
   * on), if its shooter said: a shotgun's pellets share one, and a round still in the air as the
   * next pull leaves keeps its own.
   */
  shot?: number;
  /** A tracer round's draw (StrikeDraw); none for a round that burns no tracer. */
  draw?: StrikeDraw;
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
  /** The round's unit direction over the substep that struck. */
  dir: [number, number, number];
  /** Its tracer kind (net/gear.ts TRACER_KIND): 0 for a round that burns no tracer. */
  kind: number;
  /** A tracer round's draw (StrikeDraw); none for a round that burns no tracer. */
  draw?: StrikeDraw;
  /** A silent round's (Rounds.fire): its strike suppresses no one, and is not heard. */
  silent?: true;
}

export class Rounds {
  /** Live rounds: slots [0, count). */
  count = 0;
  /** Shots the pool refused for being full. */
  dropped = 0;
  /**
   * The bodies a round may strike before the world (the multiplayer spec's §4): asked of each
   * substep's segment, as far as the world lets it go, for the nearest a round of `owner` meets.
   * None by default (solo play has no one to hit).
   */
  bodies: BodyTest | null = null;
  /** The last step's rounds stopped by a body, in slot order. */
  readonly bodyHits: BodyHit[] = [];
  /** The last step's impacts, in slot order. */
  readonly impacts: Impact[] = [];
  /** Where rounds entered water this step (metres), and with how much energy: a round splashes each time it goes in. */
  readonly splashes: { position: [number, number, number]; energyJ: number }[] = [];
  private readonly water: WaterEntry = { t: -1, cell: [0, 0, 0] };
  /** The last step's near misses of the listener: one per substep a round not the player's passed within its radius, how near (m) and where (suppression counts each). */
  readonly cracks: { missM: number; at: [number, number, number] }[] = [];
  /** The last step's rounds heard passing the listener: one per round, at its nearest approach (or as near as it came before it stopped). */
  readonly passes: { missM: number; at: [number, number, number] }[] = [];
  private listener: readonly [number, number, number] | null = null;
  private listenRadius = 0;
  private readonly pos: Float64Array;
  private readonly vel: Float64Array;
  private readonly distance: Float64Array;
  private readonly age: Float64Array;
  private readonly specIndex: Int32Array;
  private readonly owner: Int8Array;
  private readonly tracer: Uint8Array;
  /** Where each round left, and where its tracer is drawn from: the muzzle for the player's, which leave from the eye; and how far out its tracer joins its path (m; 0 when it leaves where it is drawn from). */
  private readonly origin: Float64Array;
  private readonly from: Float64Array;
  private readonly converge: Float64Array;
  /** Over how far its tracer is lit in (m; 0 from the muzzle; −1 unset: the draw's own, [effects] tracer_ignite_hip_m): the shooter's, by how aimed the shot was. */
  private readonly ignite: Float64Array;
  /** The pull of the trigger each left on, as its shooter numbers them (−1: not said), for its hits to carry. */
  private readonly shot: Float64Array;
  /** Each round's nearest miss of the listener so far (m) and where, and whether its pass has been heard. */
  private readonly nearMiss: Float64Array;
  private readonly nearAt: Float64Array;
  private readonly heard: Uint8Array;
  /** Whether each round flies silent: it cracks nothing and passes unheard. */
  private readonly silent: Uint8Array;
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
    this.origin = new Float64Array(n * 3);
    this.from = new Float64Array(n * 3);
    this.converge = new Float64Array(n);
    this.ignite = new Float64Array(n);
    this.shot = new Float64Array(n);
    this.nearMiss = new Float64Array(n);
    this.nearAt = new Float64Array(n * 3);
    this.heard = new Uint8Array(n);
    this.silent = new Uint8Array(n);
    this.size = [map.dims.x * voxel, map.dims.y * voxel, map.dims.z * voxel];
  }

  /** Rounds the pool has room for now. */
  get room(): number {
    return this.t.capacity - this.count;
  }

  /**
   * A round leaving `origin` (m) at `velocity` (m/s), its tracer drawn as `drawn` says (TracerDraw:
   * from its origin, on its path, lit in as the draw's own, unless given): its slot, or −1 if the pool
   * is full or the velocity is zero. `tracer` is true (the battle's amber), false, or a kind
   * (net/gear.ts TRACER_KIND: 0 none, 2 red, 3 blue). `shot` numbers the pull of the trigger it
   * leaves on (0 or more; a shotgun's pellets share one), for the body it strikes to say
   * (BodyHit.shot); not given, its hit says none. `silent`: it cracks nothing and passes unheard (born
   * heard), and its strikes say so (Impact.silent): another's shot long overdue, flown for its chips.
   */
  fire(origin: readonly [number, number, number], velocity: readonly [number, number, number], spec: ProjectileSpec, owner: number, tracer: boolean | number, drawn: TracerDraw = {}, shot = NO_SHOT, silent = false): number {
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
    this.tracer[i] = tracer === true ? 1 : tracer === false ? 0 : Math.max(0, Math.min(3, Math.round(tracer)));
    this.origin.set(origin, i * 3);
    this.from.set(drawn.from ?? origin, i * 3);
    this.converge[i] = drawn.convergeM ?? 0;
    this.ignite[i] = drawn.igniteM ?? UNSET;
    this.shot[i] = shot;
    this.nearMiss[i] = Infinity;
    this.heard[i] = silent ? 1 : 0;
    this.silent[i] = silent ? 1 : 0;
    return i;
  }

  isTracer(slot: number): boolean {
    return this.tracer[slot] !== 0;
  }

  /**
   * How far a round of `spec` falls below the line it leaves on by `rangeM` along it (m), in this
   * pool's air: its own gravity and quadratic drag, solved for a flat shot. Its speed decays as
   * e^(−ks) over s, k = dragFactor · air density, and the fall's drag with it, so it falls
   *
   *     |g| · (e^(2ks) − 1 − 2ks) / (4 k² v0²)
   *
   * which is |g| s² / 2v0² with no drag. Integrated in substeps (step), a round falls a few mm more
   * by 200 m. The front aims over a crest by it (front.ts).
   */
  dropM(spec: ProjectileSpec, rangeM: number): number {
    const x = 2 * spec.dragFactor * this.t.airDensity * rangeM;
    // (e^x − 1 − x) / (x²/2): 1 with no drag; its series where x is too small to take it directly.
    const r = x > 1e-3 ? (2 * (exp(x) - 1 - x)) / (x * x) : 1 + x / 3;
    return (-this.t.gravity * rangeM * rangeM * r) / (2 * spec.muzzleVelocity * spec.muzzleVelocity);
  }

  /** Who hears near misses: the player's eye (metres), within `radiusM`; null, no one. */
  listen(eye: readonly [number, number, number] | null, radiusM: number): void {
    this.listener = eye;
    this.listenRadius = radiusM;
  }

  /** One tick of `dt` seconds in substeps: this step's impacts, cracks and passes, and rounds retired by range, age, the world's sides or its floor. */
  step(dt: number): void {
    this.impacts.length = 0;
    this.bodyHits.length = 0;
    this.splashes.length = 0;
    this.cracks.length = 0;
    this.passes.length = 0;
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

  /**
   * Each tracer round's head and its tail, `lengthOf` its speed (m/s) back along its path, or a
   * length given outright (m), no further than it has flown, as [x, y, z] triples in metres; where
   * it left and where its tracer is drawn from, how far out its tracer joins its path and over how
   * far it is lit in (m; −1 unset: the draw's own), how far it has flown (m), whose it is, and its
   * kind (its colour).
   */
  tracerSegments(lengthOf: number | ((speed: number) => number)): { head: Float32Array; tail: Float32Array; origin: Float32Array; from: Float32Array; converge: Float32Array; ignite: Float32Array; flown: Float32Array; owner: Int8Array; kind: Uint8Array } {
    let n = 0;
    for (let i = 0; i < this.count; i++) if (this.tracer[i] !== 0) n++;
    const head = new Float32Array(n * 3);
    const tail = new Float32Array(n * 3);
    const origin = new Float32Array(n * 3);
    const from = new Float32Array(n * 3);
    const converge = new Float32Array(n);
    const ignite = new Float32Array(n);
    const flown = new Float32Array(n);
    const owner = new Int8Array(n);
    const kind = new Uint8Array(n);
    let o = 0;
    for (let i = 0; i < this.count; i++) {
      if (!this.tracer[i]) continue;
      const v = this.velocity(i);
      const speed = hypot(v[0], v[1], v[2]);
      const lengthM = typeof lengthOf === 'number' ? lengthOf : lengthOf(speed);
      const back = speed > 0 ? Math.min(lengthM, this.distance[i]) / speed : 0;
      for (let k = 0; k < 3; k++) {
        head[o * 3 + k] = this.pos[i * 3 + k];
        tail[o * 3 + k] = this.pos[i * 3 + k] - v[k] * back;
        origin[o * 3 + k] = this.origin[i * 3 + k];
        from[o * 3 + k] = this.from[i * 3 + k];
      }
      converge[o] = this.converge[i];
      ignite[o] = this.ignite[i];
      flown[o] = this.distance[i];
      owner[o] = this.owner[i];
      kind[o] = this.tracer[i];
      o++;
    }
    return { head, tail, origin, from, converge, ignite, flown, owner, kind };
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
    // A crack is measured along the substep's whole segment, as the reference does, even where it
    // strikes partway: a round covers metres a substep, and either end alone would miss most.
    if (this.owner[i] !== 0 && this.listener && !this.silent[i]) {
      const [lx, ly, lz] = this.listener;
      const ax = this.pos[p];
      const ay = this.pos[p + 1];
      const az = this.pos[p + 2];
      const lengthSq = tx * tx + ty * ty + tz * tz;
      const u = lengthSq >= 1e-12 ? Math.max(0, Math.min(1, ((lx - ax) * tx + (ly - ay) * ty + (lz - az) * tz) / lengthSq)) : 0;
      const cx = ax + tx * u;
      const cy = ay + ty * u;
      const cz = az + tz * u;
      const miss = Math.sqrt((cx - lx) * (cx - lx) + (cy - ly) * (cy - ly) + (cz - lz) * (cz - lz));
      if (miss <= this.listenRadius) {
        this.cracks.push({ missM: miss, at: [cx, cy, cz] });
        if (miss < this.nearMiss[i]) {
          this.nearMiss[i] = miss;
          this.nearAt[p] = cx;
          this.nearAt[p + 1] = cy;
          this.nearAt[p + 2] = cz;
        }
      }
      // Its nearest approach is in this substep (the segment's nearest point short of its end), or behind it.
      if (u < 1) this.hearPass(i);
    }
    if (len > 0) {
      const dir: [number, number, number] = [tx / len, ty / len, tz / len];
      const v = this.voxel;
      this.water.t = -1;
      const hit = raycast(this.map, [this.pos[p] / v, this.pos[p + 1] / v, this.pos[p + 2] / v], dir, len / v, this.water);
      const body = this.bodies?.(this.owner[i], [this.pos[p], this.pos[p + 1], this.pos[p + 2]], dir, hit ? hit.t * v : len) ?? null;
      if (body) {
        this.bodyHits.push({
          owner: this.owner[i],
          body: body.body,
          zone: body.zone,
          position: [this.pos[p] + dir[0] * body.t, this.pos[p + 1] + dir[1] * body.t, this.pos[p + 2] + dir[2] * body.t],
          dir,
          distance: this.distance[i] + body.t,
          ...(spec.gun === undefined ? {} : { gun: spec.gun }),
          ...(this.shot[i] === NO_SHOT ? {} : { shot: this.shot[i] }),
          ...(this.tracer[i] ? { draw: this.strikeDraw(i, speed) } : {}),
        });
        this.hearPass(i);
        return true;
      }
      if (this.water.t >= 0) {
        const m = this.water.t * v;
        this.splashes.push({ position: [this.pos[p] + dir[0] * m, this.pos[p + 1] + dir[1] * m, this.pos[p + 2] + dir[2] * m], energyJ: 0.5 * spec.massKg * speed * speed });
      }
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
          dir,
          kind: this.tracer[i],
          ...(this.tracer[i] ? { draw: this.strikeDraw(i, speed) } : {}),
          ...(this.silent[i] ? { silent: true as const } : {}),
        });
        // Stopped before it passed: heard as near as it came.
        this.hearPass(i);
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
    // Over the world's top it flies on, to its range or its flight time: nothing above it is solid.
    const [sx, , sz] = this.size;
    const retired = this.distance[i] >= this.t.maxRangeM || this.age[i] >= this.t.maxFlightS || x < 0 || y < 0 || z < 0 || x >= sx || z >= sz;
    if (retired) this.hearPass(i);
    return retired;
  }

  /** Round `i`'s tracer as it strikes at `speed` (m/s): what its last streak is drawn by. */
  private strikeDraw(i: number, speed: number): StrikeDraw {
    const p = i * 3;
    return {
      origin: [this.origin[p], this.origin[p + 1], this.origin[p + 2]],
      from: [this.from[p], this.from[p + 1], this.from[p + 2]],
      convergeM: this.converge[i],
      igniteM: this.ignite[i],
      speed,
      kind: this.tracer[i],
    };
  }

  /** Round `i` is heard passing the listener, once, if it has come within reach. */
  private hearPass(i: number): void {
    if (this.heard[i] || !(this.nearMiss[i] <= this.listenRadius)) return;
    this.heard[i] = 1;
    this.passes.push({ missM: this.nearMiss[i], at: [this.nearAt[i * 3], this.nearAt[i * 3 + 1], this.nearAt[i * 3 + 2]] });
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
    this.origin.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.from.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.converge[i] = this.converge[last];
    this.ignite[i] = this.ignite[last];
    this.shot[i] = this.shot[last];
    this.nearMiss[i] = this.nearMiss[last];
    this.nearAt.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.heard[i] = this.heard[last];
    this.silent[i] = this.silent[last];
  }
}
