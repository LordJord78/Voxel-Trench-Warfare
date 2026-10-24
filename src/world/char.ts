/**
 * Char (the battle spec's §5): what a fire burned. Once a fire is at full burn, the timber, cloth,
 * duckboards and hull within `char_m` of it turn to their burnt shades (materials.ts), each of the
 * kind it was, so nothing but its colour changes; and they stay so. The app chars about a fire once
 * no crater's region about it is out (sim/destruction.ts), so a crater's bricks coming back cannot
 * undo it.
 */

import type { BrickMap } from './bricks';
import { K, P, PALETTE_KIND } from './materials';
import { clampBox, Region, type Box } from './region';

/** Each palette shade's burnt shade, or itself for what does not burn (and what has burnt). */
const BURNT = new Uint8Array(256).map((_, p) => {
  switch (PALETTE_KIND[p]) {
    case K.TIMBER:
      return P.CHAR_TIMBER;
    case K.DUCKBOARD:
      return P.CHAR_DUCKBOARD;
    case K.CLOTH:
      return P.CHAR_CLOTH;
    case K.HULL:
      return P.CHAR_HULL;
    default:
      return p;
  }
});

/** Whether a shade burns: timber, cloth, duckboards and hull, burnt or not. */
const BURNING_KINDS: readonly number[] = [K.TIMBER, K.DUCKBOARD, K.CLOTH, K.HULL];
const BURNS = new Uint8Array(256).map((_, p) => (BURNING_KINDS.includes(PALETTE_KIND[p]) ? 1 : 0));

/** The voxels (half-open) a char of `radiusM` about `centre` (metres) may touch. */
export function charBox(centre: readonly number[], radiusM: number, voxel: number): Box {
  return {
    x0: Math.floor((centre[0] - radiusM) / voxel),
    y0: Math.floor((centre[1] - radiusM) / voxel),
    z0: Math.floor((centre[2] - radiusM) / voxel),
    x1: Math.floor((centre[0] + radiusM) / voxel) + 1,
    y1: Math.floor((centre[1] + radiusM) / voxel) + 1,
    z1: Math.floor((centre[2] + radiusM) / voxel) + 1,
  };
}

/**
 * Where a fire a shell started stands, once its crater is in (metres): on the top of the nearest
 * voxel of timber, cloth, duckboard or hull within `reachM` of where it struck, open to the air
 * above; null if the crater left nothing to burn. A shell cuts away what it struck (2.2–3.4 m), so
 * its fire burns at the crater's rim, on what is left.
 */
export function fuelNear(map: BrickMap, centre: readonly number[], reachM: number, voxel: number): [number, number, number] | null {
  const want = clampBox(charBox(centre, reachM, voxel), map.dims);
  if (!want) return null;
  // Copied out once (a lookup a voxel through the brick table is slow), a row higher: the air over the top.
  const r = Region.extract(map, { ...want, y1: Math.min(map.dims.y, want.y1 + 1) });
  const b = r.box;
  let best: [number, number, number] | null = null;
  let bestD2 = reachM * reachM;
  for (let z = want.z0; z < want.z1; z++) {
    const dz = (z + 0.5) * voxel - centre[2];
    for (let y = want.y0; y < want.y1; y++) {
      // Its top, where the fire stands.
      const dy = (y + 1) * voxel - centre[1];
      const row = ((z - b.z0) * r.sy + (y - b.y0)) * r.sx - b.x0;
      for (let x = want.x0; x < want.x1; x++) {
        if (!BURNS[r.data[row + x]]) continue;
        // Open to the air above (the world's top is open).
        if (y + 1 < b.y1 && r.data[row + x + r.sx] !== P.AIR) continue;
        const dx = (x + 0.5) * voxel - centre[0];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > bestD2) continue;
        bestD2 = d2;
        best = [(x + 0.5) * voxel, (y + 1) * voxel, (z + 0.5) * voxel];
      }
    }
  }
  return best;
}

/** Char every voxel whose middle lies within `radiusM` of `centre` (metres): how many it turned. */
export function charAround(map: BrickMap, centre: readonly number[], radiusM: number, voxel: number): number {
  const box = clampBox(charBox(centre, radiusM, voxel), map.dims);
  if (!box) return 0;
  const r2 = radiusM * radiusM;
  let charred = 0;
  for (let x = box.x0; x < box.x1; x++) {
    const dx = (x + 0.5) * voxel - centre[0];
    for (let y = box.y0; y < box.y1; y++) {
      const dy = (y + 0.5) * voxel - centre[1];
      for (let z = box.z0; z < box.z1; z++) {
        const dz = (z + 0.5) * voxel - centre[2];
        if (dx * dx + dy * dy + dz * dz > r2) continue;
        const p = map.get(x, y, z);
        const burnt = BURNT[p];
        if (burnt === p) continue;
        map.set(x, y, z, burnt);
        charred++;
      }
    }
  }
  return charred;
}

/**
 * Chars waiting for no crater's region about them to be out (sim/destruction.ts's overlapsOut):
 * the region's bricks coming back would undo a char made while it is out. Tried each frame.
 */
export class CharQueue {
  private waiting: (readonly number[])[] = [];

  constructor(
    private readonly radiusM: number,
    private readonly voxel: number,
  ) {}

  /** A fire at its full burn at `at` (metres). */
  add(at: readonly number[]): void {
    this.waiting.push(at);
  }

  /** Chars still waiting. */
  get pending(): number {
    return this.waiting.length;
  }

  /** Make the chars whose box no region out reaches (`out`): the voxels charred. */
  make(map: BrickMap, out: (box: Box) => boolean): number {
    let charred = 0;
    this.waiting = this.waiting.filter((at) => {
      if (out(charBox(at, this.radiusM, this.voxel))) return true;
      charred += charAround(map, at, this.radiusM, this.voxel);
      return false;
    });
    return charred;
  }
}
