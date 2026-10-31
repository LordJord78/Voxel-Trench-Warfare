/**
 * Shell holes.
 *
 * The Python game carved every crater as a sphere and let the whole map's soil
 * collapse into it afterwards. At 10 cm that collapse is 125 times the work, so
 * open-field craters are built settled instead: a bowl cut into the terrain and
 * a spoil rim around it, both pure functions of the crater list, with the rim
 * kept under the 45° that loose spoil holds. Direct hits on the trench lines
 * are still carved and collapsed for real, as events, because there the
 * collapse is the point: the parapet comes down into the trench.
 */

import { PI, TAU, cos, sin } from '../../core/dmath';
import { hash32x4 } from '../../core/hash';
import type { Rng } from '../../core/rng';
import { vx, type GenParams } from './params';
import { surfaceAt, type TerrainModel } from './terrain';

export interface Crater {
  x: number;
  z: number;
  /** Radius in voxels. */
  r: number;
  /** How far from round, 0 (a perfect bowl, as in Python) to 1 (lobed, its rim heaped to one side). */
  ragged?: number;
}

export interface DirectHit {
  x: number;
  y: number;
  z: number;
  r: number;
  seed: number;
}

function radius(p: GenParams, rng: Rng, cap: number): number {
  return Math.min(cap, p.craters.radiusMin + rng.gamma(p.craters.gammaShape, p.craters.gammaScale));
}

export function planCraters(
  p: GenParams,
  t: TerrainModel,
  rng: Rng,
  frontLines: { z: number; facing: 1 | -1 }[],
): { open: Crater[]; direct: DirectHit[] } {
  const edge = vx(1.5, p.voxel);
  const open: Crater[] = [];
  // Pull a crater in from the map's sides until its rim clears them: the far
  // field continues the bare field there, so a bowl at the boundary is a cliff.
  const inside = (v: number, r: number, size: number) => {
    const keep = Math.ceil(REACH * r) + 2;
    return keep + ((v - edge) * (size - 2 * keep)) / (size - 2 * edge);
  };

  // No man's land, densest near the parapets: the ground nobody crosses twice.
  const nml = rng.derive('craters.nml');
  const zLo = p.layout.front + vx(2.0, p.voxel);
  const zHi = p.layout.enemyFront - vx(2.0, p.voxel);
  for (let i = 0; i < p.craters.nml; i++) {
    const x = nml.randint(edge, p.dims.x - edge);
    const z = zLo + nml.beta(0.7, 0.7) * (zHi - zLo);
    const r = radius(p, nml, p.craters.radiusCap);
    open.push({ x: inside(x, r, p.dims.x), z, r, ragged: 1 });
  }

  // Harassing fire behind both lines.
  const rear = rng.derive('craters.rear');
  for (let i = 0; i < p.craters.rear; i++) {
    const x = rear.randint(edge, p.dims.x - edge);
    let z = rear.randint(edge, p.dims.z - edge);
    while (z >= p.layout.front && z <= p.layout.enemyFront) z = rear.randint(edge, p.dims.z - edge);
    const r = radius(p, rear, p.craters.radiusCap);
    open.push({ x: inside(x, r, p.dims.x), z: inside(z, r, p.dims.z), r, ragged: 1 });
  }

  // Direct hits on each front line: real breaches in the parapet.
  const direct: DirectHit[] = [];
  frontLines.forEach((line, index) => {
    const hits = rng.derive(`craters.direct.${index}`);
    const near = vx(1.0, p.voxel);
    const far = vx(6.5, p.voxel);
    const lo = line.facing > 0 ? line.z - near : line.z - far;
    const hi = line.facing > 0 ? line.z + far : line.z + near;
    for (let i = 0; i < p.craters.directPerLine; i++) {
      const x = p.trench.lineMargin + hits.float() * (p.dims.x - 2 * p.trench.lineMargin);
      const z = lo + hits.float() * (hi - lo);
      const r = radius(p, hits, p.craters.directCap);
      const y = surfaceAt(t, p, Math.floor(x), Math.floor(z)) - Math.trunc(r * 0.55);
      direct.push({ x, y, z, r, seed: hits.nextU32() });
    }
  });

  return { open, direct };
}

const CELL = 64;

/** Bowl depth as a fraction of the radius: steep enough to hold water, gentle enough to read. */
const DEPTH = 0.75;
/** Rim height as a fraction of the radius, peaking at 1.2 r and gone by 1.4 r. */
const RIM = 0.12;

/**
 * A ragged crater's outline: its radius scaled, round the bowl, by 1 plus three harmonics (2, 3
 * and 5 lobes) of these amplitudes at phases of its own, so at most by 1 ± LOBES.
 */
const A2 = 0.08;
const A3 = 0.05;
const A5 = 0.025;
const LOBES = A2 + A3 + A5;
/** How far a crater reaches, rim and all, in radii. */
const REACH = 1.4 * (1 + LOBES);

/** One crater's outline: harmonic weights (cos, sin of each phase, times its amplitude) and the way its rim is heaped. */
interface Outline {
  c2: number; s2: number; c3: number; s3: number; c5: number; s5: number;
  /** A unit vector: the rim stands tallest on this side. */
  hx: number; hz: number;
  ragged: number;
}

/** A crater's outline, from its own position and size: a pure function of the crater, so the plan's random streams are untouched. */
function outline(c: Crater): Outline {
  const ragged = c.ragged ?? 0;
  const phase = (k: number) => (hash32x4(Math.floor(c.x * 16), Math.floor(c.z * 16), Math.floor(c.r * 16), k) / 4294967296) * TAU;
  const [p2, p3, p5, ph] = [phase(2), phase(3), phase(5), phase(7)];
  return {
    c2: ragged * A2 * cos(p2), s2: ragged * A2 * sin(p2),
    c3: ragged * A3 * cos(p3), s3: ragged * A3 * sin(p3),
    c5: ragged * A5 * cos(p5), s5: ragged * A5 * sin(p5),
    hx: cos(ph), hz: sin(ph),
    ragged,
  };
}

/** The radius scale of outline `o` in the direction (ux, uz), a unit vector: the harmonics by the multiple-angle formulas, no trigonometry per column. */
function lobes(o: Outline, ux: number, uz: number): number {
  const c2 = ux * ux - uz * uz;
  const s2 = 2 * ux * uz;
  const c3 = ux * (4 * ux * ux - 3);
  const s3 = uz * (3 - 4 * uz * uz);
  const c5 = c2 * c3 - s2 * s3;
  const s5 = s2 * c3 + c2 * s3;
  return 1 + o.c2 * c2 + o.s2 * s2 + o.c3 * c3 + o.s3 * s3 + o.c5 * c5 + o.s5 * s5;
}

export class CraterField {
  private readonly craters: readonly Crater[];
  private readonly outlines: readonly Outline[];
  private readonly cells = new Map<number, number[]>();

  constructor(craters: readonly Crater[]) {
    this.craters = craters;
    this.outlines = craters.map(outline);
    craters.forEach((c, i) => {
      const reach = c.r * REACH;
      for (let cz = Math.floor((c.z - reach) / CELL); cz <= Math.floor((c.z + reach) / CELL); cz++) {
        for (let cx = Math.floor((c.x - reach) / CELL); cx <= Math.floor((c.x + reach) / CELL); cx++) {
          const key = cz * 65536 + cx;
          const list = this.cells.get(key);
          if (list) list.push(i);
          else this.cells.set(key, [i]);
        }
      }
    });
  }

  private near(x: number, z: number): number[] {
    return this.cells.get(Math.floor(z / CELL) * 65536 + Math.floor(x / CELL)) ?? [];
  }

  /** Crater `i`'s radius toward (dx, dz), d from its centre: lobed if it is ragged. */
  private reachOf(i: number, dx: number, dz: number, d: number): number {
    const c = this.craters[i];
    const o = this.outlines[i];
    return o.ragged === 0 || d === 0 ? c.r : c.r * lobes(o, dx / d, dz / d);
  }

  /** The lowest bowl over this column, or Infinity where no crater covers it. */
  bowl(x: number, z: number, base: number): number {
    let low = Infinity;
    for (const i of this.near(x, z)) {
      const c = this.craters[i];
      const dx = x - c.x;
      const dz = z - c.z;
      const d2 = dx * dx + dz * dz;
      const most = this.outlines[i].ragged === 0 ? c.r : c.r * (1 + LOBES);
      if (d2 >= most * most) continue;
      const R = this.reachOf(i, dx, dz, Math.sqrt(d2));
      if (d2 >= R * R) continue;
      const h = base - DEPTH * c.r * (1 - d2 / (R * R));
      if (h < low) low = h;
    }
    return low;
  }

  /** The tallest spoil rim over this column, 0 if none: heaped higher on one side of a ragged crater, never past the 45° loose spoil holds. */
  rim(x: number, z: number): number {
    let high = 0;
    for (const i of this.near(x, z)) {
      const c = this.craters[i];
      const o = this.outlines[i];
      const dx = x - c.x;
      const dz = z - c.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      const off = d - 1.2 * this.reachOf(i, dx, dz, d);
      const half = 0.2 * c.r;
      if (Math.abs(off) >= half) continue;
      const heap = o.ragged === 0 || d === 0 ? 1 : 1 - o.ragged * (0.35 - 0.2 * (1 + (o.hx * dx + o.hz * dz) / d));
      const h = RIM * c.r * heap * 0.5 * (1 + cos((PI * off) / half));
      if (h > high) high = h;
    }
    return high;
  }

  covered(x: number, z: number): boolean {
    return this.bowl(x, z, 0) !== Infinity;
  }
}

/** The column's ground with craters applied: rims heaped on the field, then the bowls cut through. */
export function craterSurface(field: CraterField, base: number, x: number, z: number): number {
  return Math.floor(Math.min(base + field.rim(x, z), field.bowl(x, z, base)) + 0.5);
}
