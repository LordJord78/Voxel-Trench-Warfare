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

import { PI, cos } from '../../core/dmath';
import type { Rng } from '../../core/rng';
import { vx, type GenParams } from './params';
import { surfaceAt, type TerrainModel } from './terrain';

export interface Crater {
  x: number;
  z: number;
  /** Radius in voxels. */
  r: number;
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

  // No man's land, densest near the parapets: the ground nobody crosses twice.
  const nml = rng.derive('craters.nml');
  const zLo = p.layout.front + vx(2.0, p.voxel);
  const zHi = p.layout.enemyFront - vx(2.0, p.voxel);
  for (let i = 0; i < p.craters.nml; i++) {
    const x = nml.randint(edge, p.dims.x - edge);
    const z = zLo + nml.beta(0.7, 0.7) * (zHi - zLo);
    open.push({ x, z, r: radius(p, nml, p.craters.radiusCap) });
  }

  // Harassing fire behind both lines.
  const rear = rng.derive('craters.rear');
  for (let i = 0; i < p.craters.rear; i++) {
    const x = rear.randint(edge, p.dims.x - edge);
    let z = rear.randint(edge, p.dims.z - edge);
    while (z >= p.layout.front && z <= p.layout.enemyFront) z = rear.randint(edge, p.dims.z - edge);
    open.push({ x, z, r: radius(p, rear, p.craters.radiusCap) });
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

export class CraterField {
  private readonly craters: readonly Crater[];
  private readonly cells = new Map<number, number[]>();

  constructor(craters: readonly Crater[]) {
    this.craters = craters;
    craters.forEach((c, i) => {
      const reach = c.r * 1.4;
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

  /** The lowest bowl over this column, or Infinity where no crater covers it. */
  bowl(x: number, z: number, base: number): number {
    let low = Infinity;
    for (const i of this.near(x, z)) {
      const c = this.craters[i];
      const dx = x - c.x;
      const dz = z - c.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= c.r * c.r) continue;
      const h = base - DEPTH * c.r * (1 - d2 / (c.r * c.r));
      if (h < low) low = h;
    }
    return low;
  }

  /** The tallest spoil rim over this column, 0 if none. */
  rim(x: number, z: number): number {
    let high = 0;
    for (const i of this.near(x, z)) {
      const c = this.craters[i];
      const d = Math.sqrt((x - c.x) * (x - c.x) + (z - c.z) * (z - c.z));
      const off = d - 1.2 * c.r;
      const half = 0.2 * c.r;
      if (Math.abs(off) >= half) continue;
      const h = RIM * c.r * 0.5 * (1 + cos((PI * off) / half));
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
