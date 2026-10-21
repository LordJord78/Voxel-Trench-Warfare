/**
 * Stable hashes. Nothing here may depend on the engine: these seed every random
 * stream and every noise lattice, so a different answer in Safari is a different
 * world.
 */

const M64 = (1n << 64n) - 1n;
const utf8 = new TextEncoder();

/** 64-bit FNV-1a over the UTF-8 bytes of `text`. */
export function fnv1a64(text: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (const byte of utf8.encode(text)) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & M64;
  }
  return h;
}

/** SplitMix64's output function with its increment folded in: one step from `x`. */
export function splitmix64(x: bigint): bigint {
  let z = (x + 0x9e3779b97f4a7c15n) & M64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
  return z ^ (z >> 31n);
}

/** Fast integer hash for noise lattices and per-voxel variation; returns a uint32. */
export function hash32(...ints: number[]): number {
  let h = 0x2545f491;
  for (const v of ints) {
    h = Math.imul(h ^ (v | 0), 0x45d9f3b);
    h ^= h >>> 16;
  }
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}
