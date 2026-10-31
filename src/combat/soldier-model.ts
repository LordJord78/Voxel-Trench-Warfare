/**
 * The soldier as voxels (the multiplayer spec's §3): each of the rig's parts (soldier-rig.ts) a
 * grid of its own at 3 cm, made in code as the rifle is (rifle-model.ts), over its box in the
 * part's frame. A khaki tunic and trousers under pale webbing, puttees and boots, a steel helmet
 * with a brim; and the team's tape, a band round the helmet and one round the left arm, made in
 * TAPE_RED, for the renderer to change to the soldier's own team's colour. The rifle is the
 * player's own, at its 1.5 cm.
 */

import { P } from '../world/materials';
import { rifleModel } from './rifle-model';
import { PART_BOX, PARTS, type PartName } from './soldier-rig';

export interface PartGrid {
  dims: [number, number, number];
  voxelM: number;
  /** Where the part's frame's origin sits in its grid, in voxels. */
  origin: [number, number, number];
  /** Palette ids, x fastest, then y, then z; 0 is empty. */
  voxels: Uint8Array;
}

/** The voxel the tape is made in, changed to the team's by the renderer. */
export const TAPE = P.TAPE_RED;

const VOXEL = 0.03;

type Shape = (x: number, y: number, z: number) => number;

const ellipse = (a: number, b: number, ra: number, rb: number) => (a * a) / (ra * ra) + (b * b) / (rb * rb) <= 1;
/** Every few voxels a darker fold, so a sleeve or a leg is not one flat colour. */
const fold = (v: number, every: number) => Math.abs(Math.floor(v / VOXEL)) % every === 0;

const SHAPES: Record<Exclude<PartName, 'rifle'>, Shape> = {
  pelvis: (x, y, z) => (ellipse(x, z, 0.17, 0.11) ? (y > 0.05 ? P.SOLDIER_WEBBING : P.SOLDIER_KHAKI) : 0),
  torso: (x, y, z) => {
    // A rounded chest that narrows to the shoulders and the neck.
    const half = y < 0.46 ? 0.19 : 0.19 - (y - 0.46) * 1.4;
    if (!ellipse(x, z, half, 0.13)) return 0;
    if (y > 0.53 && Math.abs(x) > 0.08) return 0;
    if (y < 0.06) return P.SOLDIER_WEBBING;
    // Braces over the shoulders, down the front and the back; pouches on the front.
    if (Math.abs(Math.abs(x) - 0.09) < 0.025 && y > 0.06) return P.SOLDIER_WEBBING;
    if (z > 0.07 && y > 0.09 && y < 0.2 && Math.abs(x) > 0.03) return P.SOLDIER_KHAKI_DARK;
    return fold(y, 5) ? P.SOLDIER_KHAKI_DARK : P.SOLDIER_KHAKI;
  },
  head: (x, y, z) => {
    // The helmet: a shallow dome over a broad brim.
    if (y >= 0.19 && y < 0.22 && ellipse(x, z, 0.165, 0.19)) return P.SOLDIER_HELMET;
    if (y >= 0.22 && y < 0.31) {
      const k = (y - 0.22) / 0.09;
      const r = Math.sqrt(Math.max(0, 1 - k * k));
      if (!ellipse(x, z, 0.12 * r + 0.01, 0.14 * r + 0.01)) return 0;
      // The team's tape round the dome.
      if (y < 0.255 && !ellipse(x, z, 0.12 * r - 0.03, 0.14 * r - 0.03)) return TAPE;
      return P.SOLDIER_HELMET;
    }
    // The head under it, the face forward; the collar below.
    if (y < 0.04) return ellipse(x, z, 0.07, 0.07) ? P.SOLDIER_KHAKI : 0;
    if (!ellipse(x, z, 0.085, 0.1)) return 0;
    return z > 0.02 ? P.SOLDIER_SKIN : P.SOLDIER_KHAKI_DARK;
  },
  upperArmL: (x, y, z) => (ellipse(x, z, 0.06, 0.06) ? (y < -0.08 && y > -0.15 ? TAPE : fold(y, 4) ? P.SOLDIER_KHAKI_DARK : P.SOLDIER_KHAKI) : 0),
  upperArmR: (x, y, z) => (ellipse(x, z, 0.06, 0.06) ? (fold(y, 4) ? P.SOLDIER_KHAKI_DARK : P.SOLDIER_KHAKI) : 0),
  forearmL: (x, y, z) => (ellipse(x, z, 0.05, 0.05) ? (y < -0.22 ? P.SOLDIER_SKIN : y < -0.19 ? P.SOLDIER_KHAKI_DARK : P.SOLDIER_KHAKI) : 0),
  forearmR: (x, y, z) => (ellipse(x, z, 0.05, 0.05) ? (y < -0.22 ? P.SOLDIER_SKIN : y < -0.19 ? P.SOLDIER_KHAKI_DARK : P.SOLDIER_KHAKI) : 0),
  thighL: (x, y, z) => (ellipse(x, z, 0.08, 0.085) ? (fold(y, 5) ? P.SOLDIER_KHAKI_DARK : P.SOLDIER_KHAKI) : 0),
  thighR: (x, y, z) => (ellipse(x, z, 0.08, 0.085) ? (fold(y, 5) ? P.SOLDIER_KHAKI_DARK : P.SOLDIER_KHAKI) : 0),
  shinL: shin,
  shinR: shin,
};

/** Puttees wound to the knee, and the boot under them, its toe forward. */
function shin(x: number, y: number, z: number): number {
  if (y < -0.385) {
    const toe = y < -0.43 ? 0.15 : 0.07;
    return Math.abs(x) <= 0.065 && z >= -0.075 && z < toe ? P.SOLDIER_BOOT : 0;
  }
  if (!ellipse(x, z, 0.065, 0.075)) return 0;
  return fold(y, 2) ? P.SOLDIER_KHAKI_DARK : P.SOLDIER_KHAKI;
}

function grid(part: Exclude<PartName, 'rifle'>): PartGrid {
  const { min, max } = PART_BOX[part];
  const dims = [0, 1, 2].map((k) => Math.ceil((max[k] - min[k]) / VOXEL - 1e-6)) as [number, number, number];
  const origin = [0, 1, 2].map((k) => -min[k] / VOXEL) as [number, number, number];
  const voxels = new Uint8Array(dims[0] * dims[1] * dims[2]);
  const shape = SHAPES[part];
  for (let k = 0; k < dims[2]; k++) {
    for (let j = 0; j < dims[1]; j++) {
      for (let i = 0; i < dims[0]; i++) {
        voxels[i + dims[0] * (j + dims[1] * k)] = shape(min[0] + (i + 0.5) * VOXEL, min[1] + (j + 0.5) * VOXEL, min[2] + (k + 0.5) * VOXEL);
      }
    }
  }
  return { dims, voxelM: VOXEL, origin, voxels };
}

/** Every part's grid, in the rig's order (PARTS). */
export function soldierModel(): Record<PartName, PartGrid> {
  const rifle = rifleModel();
  const out = {} as Record<PartName, PartGrid>;
  for (const part of PARTS) out[part] = part === 'rifle' ? { dims: rifle.dims, voxelM: rifle.voxelM, origin: rifle.origin, voxels: rifle.voxels } : grid(part);
  return out;
}
