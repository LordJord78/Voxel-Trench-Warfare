/**
 * A shell's crater as a job on a copy of its region (region-copy.ts), for the
 * destruction worker, or in-process in tests: generation's own `detonate`, run
 * on the copy at the centre less the region's origin, with `Rng.root(seed)`,
 * so the same request cuts the same crater wherever it runs. The region is the
 * blast's reach and DETONATION_MARGIN more (the collapse's pad and one
 * widening), in whole sectors. If the work reached a side of the copy that is
 * not the world's edge, its collapse may have been cut short there, and the job
 * asks for the region grown DETONATION_WIDEN voxels each way instead.
 */

import { Rng } from '../core/rng';
import { BRICK, type Dims } from './bricks';
import { detonate, type DetonateOptions } from './destruction';
import type { Box } from './region';
import { changedBricks, regionMap, sectorBox, type BrickPatch, type RegionCopy } from './region-copy';

/** Voxels past the blast's reach a region holds: the collapse's pad (24) and one widening (24). */
export const DETONATION_MARGIN = 48;
/** Voxels a region grows each way when its job asks for a wider one. */
export const DETONATION_WIDEN = 64;

export interface DetonationRequest {
  id: number;
  /** Voxels, world coordinates. */
  centre: [number, number, number];
  radius: number;
  seed: number;
  options: DetonateOptions;
  copy: RegionCopy;
  world: Dims;
}

export type DetonationResult = { id: number; patches: BrickPatch[]; worked: Box | null } | { id: number; wider: Box };

/** The region a shell of `radius` at `centre` (voxels) works over, in whole sectors and the world's height. */
export function detonationRegion(world: Dims, centre: readonly number[], radius: number, loosen: number, margin = DETONATION_MARGIN): Box | null {
  const reach = radius * Math.max(loosen, 1) + 2 + margin;
  return sectorBox(world, { x0: centre[0] - reach, y0: 0, z0: centre[2] - reach, x1: centre[0] + reach, y1: world.y, z1: centre[2] + reach });
}

export function runDetonation(req: DetonationRequest): DetonationResult {
  const { copy } = req;
  const map = regionMap(copy);
  const ox = copy.origin[0] * BRICK;
  const oz = copy.origin[2] * BRICK;
  const sx = copy.size[0] * BRICK;
  const sz = copy.size[2] * BRICK;
  const worked = detonate(map, req.centre[0] - ox, req.centre[1], req.centre[2] - oz, req.radius, Rng.root(req.seed), req.options);
  if (worked) {
    const cut = (worked.x0 <= 0 && ox > 0) || (worked.z0 <= 0 && oz > 0) || (worked.x1 >= sx && ox + sx < req.world.x) || (worked.z1 >= sz && oz + sz < req.world.z);
    if (cut) {
      const wider = sectorBox(req.world, { x0: ox - DETONATION_WIDEN, y0: 0, z0: oz - DETONATION_WIDEN, x1: ox + sx + DETONATION_WIDEN, y1: req.world.y, z1: oz + sz + DETONATION_WIDEN });
      if (wider) return { id: req.id, wider };
    }
  }
  return {
    id: req.id,
    patches: changedBricks(copy, map),
    worked: worked && { x0: worked.x0 + ox, y0: worked.y0, z0: worked.z0 + oz, x1: worked.x1 + ox, y1: worked.y1, z1: worked.z1 + oz },
  };
}
