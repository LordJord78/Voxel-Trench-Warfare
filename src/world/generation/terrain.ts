/**
 * The field: a pure function of (x, z).
 *
 * Python built the field as one array: fBm relief normalised over the map,
 * plus the swale, then drainage ditches cut into it. Here each part is a
 * function, so the trench planner, every band's fill and the far field ask the
 * same question and get the same answer. Only the relief's normalisation needs
 * the whole map, and it is sampled once, coarsely, into the plan.
 */

import { PI, cos } from '../../core/dmath';
import type { Rng } from '../../core/rng';
import { fbm } from './noise';
import { vx, type GenParams } from './params';

export interface Ditch {
  z: number;
  drift: number;
}

export interface TerrainModel {
  salt: number;
  reliefMin: number;
  reliefMax: number;
  ditches: Ditch[];
}

export function buildTerrain(p: GenParams, rng: Rng): TerrainModel {
  const salt = rng.derive('field.relief').nextU32();
  let reliefMin = Infinity;
  let reliefMax = -Infinity;
  for (let z = 0; z < p.dims.z; z += 16) {
    for (let x = 0; x < p.dims.x; x += 16) {
      const r = fbm(x, z, p.field.baseCell, p.field.octaves, p.field.persistence, salt);
      if (r < reliefMin) reliefMin = r;
      if (r > reliefMax) reliefMax = r;
    }
  }
  const drains = rng.derive('field.ditches');
  const ditches: Ditch[] = [];
  for (let i = 0; i < p.field.ditches; i++) {
    const z = drains.randint(vx(4.0, p.voxel), p.dims.z - vx(4.0, p.voxel));
    const drift = drains.uniform(-0.03, 0.03);
    ditches.push({ z, drift });
  }
  return { salt, reliefMin, reliefMax, ditches };
}

/**
 * The dip between the lines that the map is named for (Sukhyi Yar): a cosine
 * hump centred between the two front lines, zero outside it. Voxels, never -0.
 */
export function swale(p: GenParams, z: number): number {
  const dip = p.field.swaleDepth;
  if (dip <= 0) return 0;
  const centre = 0.5 * (p.layout.front + p.layout.enemyFront);
  const half = Math.max(1, 0.5 * (p.layout.enemyFront - p.layout.front) + p.field.swaleMargin);
  const t = Math.min(1, Math.abs(z - centre) / half);
  const hump = 0.5 * (1 + cos(PI * t));
  return 0 - Math.round(dip * hump);
}

/** Height of the undisturbed field, in voxels: relief about the ground level, plus the swale. */
export function fieldHeight(t: TerrainModel, p: GenParams, x: number, z: number): number {
  const r = fbm(x, z, p.field.baseCell, p.field.octaves, p.field.persistence, t.salt);
  const span = t.reliefMax - t.reliefMin;
  const relief = span > 1e-12 ? (r - t.reliefMin) / span : 0.5;
  return p.ground + (relief - 0.5) * 2 * p.field.amplitude + swale(p, z);
}

function ditchHalf(p: GenParams): number {
  return Math.max(1, vx(0.5, p.voxel));
}

/**
 * How deep a drainage ditch cuts this column, in voxels: 1.5 m, running out
 * to nothing over the last 8 m before the map edge, so the ditch meets the
 * far field (which has none) at the field's own height. 0 off the ditches.
 */
export function ditchDepth(t: TerrainModel, p: GenParams, x: number, z: number): number {
  if (x < 0 || x >= p.dims.x || z < 0 || z >= p.dims.z) return 0;
  const half = ditchHalf(p);
  for (const d of t.ditches) {
    const zc = Math.trunc(d.z + d.drift * (x - p.dims.x / 2));
    if (Math.abs(z - zc) > half) continue;
    const edge = Math.min(x, p.dims.x - 1 - x, z, p.dims.z - 1 - z);
    return Math.round(vx(1.5, p.voxel) * Math.min(1, edge / vx(8.0, p.voxel)));
  }
  return 0;
}

export function ditchAt(t: TerrainModel, p: GenParams, x: number, z: number): boolean {
  return ditchDepth(t, p, x, z) > 0;
}

/** First air voxel above the field: integer, clamped as Python clamped it, lowered in a ditch. */
export function surfaceAt(t: TerrainModel, p: GenParams, x: number, z: number): number {
  let h = Math.floor(fieldHeight(t, p, x, z) + 0.5);
  h = Math.max(p.waterTable + 2, Math.min(p.dims.y - 80, h));
  return h - ditchDepth(t, p, x, z);
}
