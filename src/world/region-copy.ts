/**
 * A region of the world copied out brick by brick, for work done elsewhere
 * (the destruction worker): whole sectors across and the world's full height,
 * since a collapse follows its columns down to the first solid and up through
 * whatever rests on them. The copy keeps the map's own encoding — an empty
 * brick is 0, a uniform one `UNIFORM | id`, a dense one its 512 bytes — so a
 * brick of sky or subsoil costs four bytes, and the whole moves to a worker as
 * two transferred buffers. What comes back is the bricks the work changed.
 */

import { BRICK, BrickMap, SECTOR, UNIFORM, type Dims } from './bricks';
import { clampBox, type Box } from './region';

export interface RegionCopy {
  /** The region's low corner, and its size, in bricks. */
  origin: [number, number, number];
  size: [number, number, number];
  /** Per brick, x fastest: 0 empty, `UNIFORM | id` uniform, or k + 1 for the k-th 512 bytes of `dense`. */
  entries: Uint32Array;
  dense: Uint8Array;
}

/** A brick of the world as the work left it: `entry` 0 or `UNIFORM | id`, or `voxels`' 512 bytes. */
export interface BrickPatch {
  /** World brick coordinates. */
  at: [number, number, number];
  entry: number;
  voxels?: Uint8Array;
}

/** `box` widened outward to whole sectors across x and z, over the world's full height and clamped to it; null if nothing is left. */
export function sectorBox(dims: Dims, box: Box): Box | null {
  return clampBox(
    {
      x0: Math.floor(box.x0 / SECTOR) * SECTOR,
      y0: 0,
      z0: Math.floor(box.z0 / SECTOR) * SECTOR,
      x1: Math.ceil(box.x1 / SECTOR) * SECTOR,
      y1: dims.y,
      z1: Math.ceil(box.z1 / SECTOR) * SECTOR,
    },
    dims,
  );
}

/** Copy `box` out of the map: it must be whole sectors across, within the world, and its full height. */
export function copyRegion(map: BrickMap, box: Box): RegionCopy {
  const { dims } = map;
  const across = [box.x0, box.x1, box.z0, box.z1].every((v) => Number.isInteger(v) && v % SECTOR === 0);
  if (!across || box.y0 !== 0 || box.y1 !== dims.y || box.x0 < 0 || box.z0 < 0 || box.x1 > dims.x || box.z1 > dims.z || box.x0 >= box.x1 || box.z0 >= box.z1) {
    throw new RangeError(`a region copy is whole sectors across and the world's height; got ${JSON.stringify(box)}`);
  }
  const origin: [number, number, number] = [box.x0 / BRICK, 0, box.z0 / BRICK];
  const size: [number, number, number] = [(box.x1 - box.x0) / BRICK, map.bricks.y, (box.z1 - box.z0) / BRICK];
  const entries = new Uint32Array(size[0] * size[1] * size[2]);
  const world = (bx: number, by: number, bz: number) => map.brickIndex(origin[0] + bx, by, origin[2] + bz);
  let denseCount = 0;
  for (let bz = 0; bz < size[2]; bz++) {
    for (let by = 0; by < size[1]; by++) {
      for (let bx = 0; bx < size[0]; bx++) {
        const e = map.table[world(bx, by, bz)];
        if (e !== 0 && !(e & UNIFORM)) denseCount++;
      }
    }
  }
  const dense = new Uint8Array(denseCount * 512);
  let i = 0;
  let k = 0;
  for (let bz = 0; bz < size[2]; bz++) {
    for (let by = 0; by < size[1]; by++) {
      for (let bx = 0; bx < size[0]; bx++, i++) {
        const bi = world(bx, by, bz);
        const e = map.table[bi];
        if (e === 0 || e & UNIFORM) {
          entries[i] = e;
          continue;
        }
        map.readBrick(bi, dense.subarray(k * 512, k * 512 + 512));
        entries[i] = ++k;
      }
    }
  }
  return { origin, size, entries, dense };
}

/** The copy as a map of its own, its bricks at the region's local brick coordinates, none of them dirty. */
export function regionMap(copy: RegionCopy): BrickMap {
  const map = new BrickMap({ x: copy.size[0] * BRICK, y: copy.size[1] * BRICK, z: copy.size[2] * BRICK });
  for (let i = 0; i < copy.entries.length; i++) {
    const e = copy.entries[i];
    if (e === 0) continue;
    if (e & UNIFORM) map.loadBrick(i, e);
    else map.loadBrick(i, 0, copy.dense.subarray((e - 1) * 512, e * 512));
  }
  return map;
}

/**
 * The bricks of `map` (regionMap's, then worked on) written since it was last asked whose voxels
 * differ from the copy's, ascending z, y, x: a uniform one by its entry, any other by its bytes.
 * Bricks in `also` (local indices an earlier stage sent) are sent as they are now whatever they
 * hold, so a brick an earlier stage changed and a later one put back is put back in the world too.
 * Each brick sent is added to `sent` if given.
 */
export function changedBricks(copy: RegionCopy, map: BrickMap, also?: ReadonlySet<number>, sent?: Set<number>): BrickPatch[] {
  const out: BrickPatch[] = [];
  const was = new Uint8Array(512);
  const now = new Uint8Array(512);
  const [sx, sy] = copy.size;
  const bricks = new Set(map.takeDirty());
  for (const i of also ?? []) bricks.add(i);
  for (const i of [...bricks].sort((a, b) => a - b)) {
    const e = copy.entries[i];
    if (e === 0) was.fill(0);
    else if (e & UNIFORM) was.fill(e & 0xff);
    else was.set(copy.dense.subarray((e - 1) * 512, e * 512));
    map.readBrick(i, now);
    let same = true;
    for (let v = 0; v < 512 && same; v++) same = was[v] === now[v];
    if (same && !also?.has(i)) continue;
    sent?.add(i);
    const bx = i % sx;
    const by = ((i - bx) / sx) % sy;
    const bz = (i - bx - by * sx) / (sx * sy);
    const at: [number, number, number] = [copy.origin[0] + bx, copy.origin[1] + by, copy.origin[2] + bz];
    let uniform = true;
    for (let v = 1; v < 512 && uniform; v++) uniform = now[v] === now[0];
    out.push(uniform ? { at, entry: now[0] === 0 ? 0 : (UNIFORM | now[0]) >>> 0 } : { at, entry: 1, voxels: now.slice() });
  }
  return out;
}

/** Write a patch's brick into the world, marking it dirty. */
export function applyPatch(map: BrickMap, p: BrickPatch): void {
  const bi = map.brickIndex(p.at[0], p.at[1], p.at[2]);
  if (p.voxels) map.writeBrick(bi, p.voxels);
  else map.setUniform(bi, p.entry & 0xff);
}
