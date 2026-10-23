/**
 * The rifle as a voxel model at 1.5 cm, made in code: an AK-74's silhouette in
 * the proportions of the reference's viewmodel mesh (render/viewmodel.py), the
 * butt at z −0.26 m and the muzzle at 0.72 m, the receiver's rear on the bore
 * at the origin. Model metres: x right, y up, z forward.
 *
 * Receiver and dust cover, the rear sight, the gas tube and the barrel, the
 * front sight and the brake in steel; the curved magazine in its orange-brown;
 * the handguard and the stock in the AK-74's plum furniture; the pistol grip.
 * The renderer traces it in its own pass (rifle.wgsl, the same walk as
 * `traceRifle`); the simulation takes its muzzle and ejection port.
 */

import { P } from '../world/materials';

export interface RifleModel {
  dims: [number, number, number];
  voxelM: number;
  /** Where the model's origin (the receiver's rear, on the bore) sits in its grid, in voxels. */
  origin: [number, number, number];
  /** Palette ids, x fastest, then y, then z; 0 is empty. */
  voxels: Uint8Array;
  /** The brake's front face, on the bore (model metres). */
  muzzle: [number, number, number];
  /** The ejection port, on the receiver's right face over the magazine (model metres). */
  port: [number, number, number];
}

const VOXEL = 0.015;
// An odd width, so the bore runs down the middle column; tall enough for the magazine and the
// front sight's post; long enough for the butt and the brake.
const DIMS: [number, number, number] = [5, 20, 66];
const ORIGIN: [number, number, number] = [2.5, 15.5, 18];

export const RIFLE_MUZZLE: [number, number, number] = [0, 0, (DIMS[2] - ORIGIN[2]) * VOXEL];
export const RIFLE_PORT: [number, number, number] = [(DIMS[0] - 1 - ORIGIN[0]) * VOXEL, 0.012, 0.17];

type Part = [(x: number, y: number, z: number) => boolean, number];

/** Each part's test on a voxel's centre, and its material; later parts paint over earlier ones. */
const PARTS: Part[] = [
  // The stock, deepening toward the butt, and its butt plate.
  [(x, y, z) => z >= -0.26 && z < 0 && Math.abs(x) <= 0.0225 && y <= 0.015 && y >= -0.03 - 0.07 * (-z / 0.26), P.RIFLE_FURNITURE],
  [(x, y, z) => z >= -0.26 && z < -0.245 && Math.abs(x) <= 0.0225 && y <= 0.015 && y >= -0.1, P.RIFLE_STEEL],
  // The receiver, its dust cover, and the rear sight at its front.
  [(x, y, z) => z >= 0 && z < 0.34 && Math.abs(x) <= 0.0225 && Math.abs(y) <= 0.03, P.RIFLE_STEEL],
  [(x, y, z) => z >= 0.02 && z < 0.32 && Math.abs(x) <= 0.015 && y > 0.03 && y <= 0.045, P.RIFLE_STEEL],
  [(x, y, z) => z >= 0.3 && z < 0.34 && Math.abs(x) <= 0.0075 && y > 0.03 && y <= 0.06, P.RIFLE_STEEL],
  // The pistol grip, raked back, and the trigger guard.
  [(x, y, z) => y < -0.03 && y >= -0.13 && Math.abs(x) <= 0.0225 && z >= 0.02 - 0.35 * (-0.03 - y) && z < 0.06 - 0.35 * (-0.03 - y), P.RIFLE_GRIP],
  [(x, y, z) => Math.abs(x) <= 0.0075 && y >= -0.06 && ((y < -0.045 && z >= 0.06 && z < 0.1) || (y < -0.03 && z >= 0.09 && z < 0.1)), P.RIFLE_STEEL],
  // The magazine, curving forward as it hangs.
  [
    (x, y, z) => {
      if (y >= -0.03 || y < -0.21 || Math.abs(x) > 0.0225) return false;
      const hang = (-0.03 - y) / 0.18;
      const curve = 0.07 * hang * hang;
      return z >= 0.1 + curve && z < 0.19 + curve;
    },
    P.RIFLE_MAG,
  ],
  // The barrel and the gas tube over it, then the handguard around both.
  [(x, y, z) => z >= 0.34 && z < 0.66 && Math.abs(x) <= 0.0075 && Math.abs(y) <= 0.0075, P.RIFLE_STEEL],
  [(x, y, z) => z >= 0.34 && z < 0.52 && Math.abs(x) <= 0.0075 && y > 0.0075 && y <= 0.03, P.RIFLE_STEEL],
  [(x, y, z) => z >= 0.34 && z < 0.52 && Math.abs(x) <= 0.0225 && y >= -0.03 && y <= 0.0075, P.RIFLE_FURNITURE],
  [(x, y, z) => z >= 0.36 && z < 0.5 && Math.abs(x) <= 0.0225 && y > 0.0075 && y <= 0.0375, P.RIFLE_FURNITURE],
  // The front sight's block and post, and the brake.
  [(x, y, z) => z >= 0.6 && z < 0.63 && Math.abs(x) <= 0.015 && Math.abs(y) <= 0.015, P.RIFLE_STEEL_WORN],
  [(x, y, z) => z >= 0.6 && z < 0.63 && Math.abs(x) <= 0.0075 && y > 0.015 && y <= 0.06, P.RIFLE_STEEL_WORN],
  [(x, y, z) => z >= 0.66 && z < 0.72 && Math.abs(x) <= 0.015 && Math.abs(y) <= 0.015, P.RIFLE_STEEL_WORN],
];

export function rifleModel(): RifleModel {
  const [nx, ny, nz] = DIMS;
  const voxels = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = (i + 0.5 - ORIGIN[0]) * VOXEL;
        const y = (j + 0.5 - ORIGIN[1]) * VOXEL;
        const z = (k + 0.5 - ORIGIN[2]) * VOXEL;
        for (const [inside, palette] of PARTS) if (inside(x, y, z)) voxels[i + nx * (j + ny * k)] = palette;
      }
    }
  }
  return { dims: [...DIMS], voxelM: VOXEL, origin: [...ORIGIN], voxels, muzzle: [...RIFLE_MUZZLE], port: [...RIFLE_PORT] };
}

/**
 * The first voxel a ray from `origin` along unit `dir` (model metres) enters: how far (m), the
 * face it came in by (outward, unit), and its palette; null if it misses. An Amanatides–Woo walk
 * of the grid, as world/raycast.ts walks the world; a ray that starts inside a voxel hits it at
 * 0, facing back along the ray's largest axis.
 */
export function traceRifle(m: RifleModel, origin: readonly number[], dir: readonly number[]): { t: number; normal: [number, number, number]; palette: number } | null {
  const o = [origin[0] / m.voxelM + m.origin[0], origin[1] / m.voxelM + m.origin[1], origin[2] / m.voxelM + m.origin[2]];
  let tEnd = Infinity;
  let entry = -1;
  let entryT = -Infinity;
  for (let k = 0; k < 3; k++) {
    if (dir[k] === 0) {
      if (o[k] < 0 || o[k] >= m.dims[k]) return null;
      continue;
    }
    const a = (0 - o[k]) / dir[k];
    const b = (m.dims[k] - o[k]) / dir[k];
    const lo = Math.min(a, b);
    if (lo > entryT) {
      entryT = lo;
      entry = k;
    }
    tEnd = Math.min(tEnd, Math.max(a, b));
  }
  let t = Math.max(entryT, 0);
  if (t >= tEnd) return null;
  const cell = [0, 0, 0];
  for (let k = 0; k < 3; k++) cell[k] = Math.min(m.dims[k] - 1, Math.max(0, Math.floor(o[k] + dir[k] * t)));
  let face = -1;
  if (entryT > 0) {
    cell[entry] = dir[entry] > 0 ? 0 : m.dims[entry] - 1;
    face = entry;
  }
  for (;;) {
    const palette = m.voxels[cell[0] + m.dims[0] * (cell[1] + m.dims[1] * cell[2])];
    if (palette !== 0) {
      const normal: [number, number, number] = [0, 0, 0];
      let axis = face;
      if (axis < 0) {
        axis = 0;
        for (let k = 1; k < 3; k++) if (Math.abs(dir[k]) > Math.abs(dir[axis])) axis = k;
      }
      normal[axis] = dir[axis] > 0 ? -1 : 1;
      return { t: t * m.voxelM, normal, palette };
    }
    let axis = -1;
    let next = Infinity;
    for (let k = 0; k < 3; k++) {
      if (dir[k] === 0) continue;
      const bound = dir[k] > 0 ? cell[k] + 1 : cell[k];
      const tk = (bound - o[k]) / dir[k];
      if (tk < next) {
        next = tk;
        axis = k;
      }
    }
    if (axis < 0 || next >= tEnd) return null;
    t = next;
    cell[axis] += dir[axis] > 0 ? 1 : -1;
    if (cell[axis] < 0 || cell[axis] >= m.dims[axis]) return null;
    face = axis;
  }
}
