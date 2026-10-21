/**
 * Value noise on an infinite hashed lattice.
 *
 * The Python game drew a finite random grid per map. Here every lattice value
 * is a hash of its coordinates, so the field is a pure function of (x, z): any
 * worker can evaluate any column, and the far field keeps rolling past the
 * map's edge without a seam.
 */

import { hash32x4 } from '../../core/hash';

const INV_2_32 = 1 / 4294967296;

export function lattice01(ix: number, iz: number, octave: number, salt: number): number {
  return hash32x4(ix, iz, octave, salt) * INV_2_32;
}

function smooth(f: number): number {
  return f * f * (3 - 2 * f);
}

/** Smoothstep-bilinear value noise in [0, 1), with lattice points every `cell` voxels. */
export function valueNoise(x: number, z: number, cell: number, octave: number, salt: number): number {
  const gx = x / cell;
  const gz = z / cell;
  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  const fx = smooth(gx - ix);
  const fz = smooth(gz - iz);
  const a = lattice01(ix, iz, octave, salt);
  const b = lattice01(ix + 1, iz, octave, salt);
  const c = lattice01(ix, iz + 1, octave, salt);
  const d = lattice01(ix + 1, iz + 1, octave, salt);
  const top = a + (b - a) * fx;
  const bottom = c + (d - c) * fx;
  return top + (bottom - top) * fz;
}

/** Fractal value noise: octave o has cell baseCell/2^o and weight persistence^o; the weighted mean. */
export function fbm(x: number, z: number, baseCell: number, octaves: number, persistence: number, salt: number): number {
  let total = 0;
  let norm = 0;
  let amplitude = 1;
  for (let o = 0; o < octaves; o++) {
    total += valueNoise(x, z, baseCell / (1 << o), o, salt) * amplitude;
    norm += amplitude;
    amplitude *= persistence;
  }
  return total / norm;
}
