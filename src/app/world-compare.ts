/**
 * A page's world as two pages compare it (main.ts's hooks, for battle.spec.ts's sameWorlds): blood
 * spatter is per page and colour only (the shared-battle plan's note 12: each page spatters a
 * headshot or a kill from its own tick, the victim's none), so a comparison of two pages' worlds
 * masks every voxel where either holds a BLOOD_* id. Here a page finds its own blood, or any ids it is
 * asked for (a char one page made and the other did not), and hashes its world (world/fingerprint.ts)
 * with the union of both pages' set to air, only while its frames are held; and, for a comparison that
 * differs, hashes each sector of it, so the specs can say where.
 */

import { packCell, unpackCell } from '../combat/entrenching';
import { BRICK, UNIFORM, type BrickMap } from '../world/bricks';
import { fingerprint } from '../world/fingerprint';
import { P, PALETTE } from '../world/materials';

/** The blood ids: the palette's names starting BLOOD_. */
const BLOOD = PALETTE.flatMap((p, id) => (p.name.startsWith('BLOOD_') ? [id] : []));

/**
 * Every voxel of `map` that holds one of `ids`, as its packed cell (combat/entrenching.ts packCell),
 * ascending. Brick by brick: an empty brick, or a uniform one of another id, costs one look.
 */
export function cellsHolding(map: BrickMap, ids: readonly number[]): number[] {
  const want = new Uint8Array(256);
  for (const id of ids) want[id] = 1;
  const out: number[] = [];
  const { bricks, dims } = map;
  const voxels = new Uint8Array(512);
  for (let bi = 0; bi < map.table.length; bi++) {
    const e = map.table[bi];
    if (e === 0 || (e & UNIFORM && !want[e & 0xff])) continue;
    if (e & UNIFORM) voxels.fill(e & 0xff);
    else voxels.set(map.denseView(bi)!);
    if (!voxels.some((v) => want[v] === 1)) continue;
    const bx = (bi % bricks.x) * BRICK;
    const by = (Math.floor(bi / bricks.x) % bricks.y) * BRICK;
    const bz = Math.floor(bi / (bricks.x * bricks.y)) * BRICK;
    for (let i = 0; i < 512; i++) if (want[voxels[i]]) out.push(packCell(dims, bx + (i & 7), by + ((i >> 3) & 7), bz + (i >> 6)));
  }
  return out.sort((a, b) => a - b);
}

/** Every voxel of `map` that holds a BLOOD_* id, as cellsHolding gives them. */
export function bloodCells(map: BrickMap): number[] {
  return cellsHolding(map, BLOOD);
}

/** A voxel's mix with its place (an index): sectorHashes' term. */
function mix(i: number, v: number): number {
  let k = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(v + 7, 0x85ebca6b);
  k = Math.imul(k ^ (k >>> 15), 0xc2b2ae35);
  return (k ^ (k >>> 13)) | 0;
}

/** Each id's sum of mix over a brick's 512 places: a uniform brick of it. */
const UNIFORM_SUM = Int32Array.from({ length: 256 }, (_, v) => {
  let sum = 0;
  if (v !== 0) for (let i = 0; i < 512; i++) sum = (sum + mix(i, v)) | 0;
  return sum;
});

/**
 * Each 32-voxel sector's content hash, sector index x fastest: over its bricks, a mix of each non-air
 * voxel with its place, and of each brick's sum with the brick's place in the sector. A brick of air,
 * empty or dense, is nothing, and a uniform brick hashes as the same brick dense: so two worlds' sectors
 * differ only where their voxels do (but for a collision).
 */
export function sectorHashes(map: BrickMap): number[] {
  const { table, bricks, sectors } = map;
  const out = new Int32Array(sectors.x * sectors.y * sectors.z);
  for (let bi = 0; bi < table.length; bi++) {
    const e = table[bi];
    if (e === 0) continue;
    let sum = 0;
    if (e & UNIFORM) sum = UNIFORM_SUM[e & 0xff];
    else {
      const d = map.denseView(bi)!;
      for (let i = 0; i < 512; i++) if (d[i] !== 0) sum = (sum + mix(i, d[i])) | 0;
    }
    if (sum === 0) continue;
    const bx = bi % bricks.x;
    const by = Math.floor(bi / bricks.x) % bricks.y;
    const bz = Math.floor(bi / (bricks.x * bricks.y));
    const local = ((bz & 3) * 4 + (by & 3)) * 4 + (bx & 3);
    const si = ((bz >> 2) * sectors.y + (by >> 2)) * sectors.x + (bx >> 2);
    out[si] = (out[si] + mix(local, sum & 0xffff) + mix(local + 64, sum >>> 16)) | 0;
  }
  return Array.from(out);
}

/**
 * `map`'s fingerprint with each voxel of `mask` (packed cells; any not a cell of the world is none)
 * as air: each set to air with `map.set`, the world hashed, and each put back as it was, whatever
 * the hash does. Meant for a page whose frames are held (a test's freeze): a frame run between would
 * see the air.
 */
export async function maskedFingerprint(map: BrickMap, mask: readonly number[]): Promise<string> {
  const kept: [number, number, number, number][] = [];
  try {
    for (const c of mask) {
      const cell = unpackCell(map.dims, c);
      if (!cell) continue;
      const [x, y, z] = cell;
      kept.push([x, y, z, map.get(x, y, z)]);
      map.set(x, y, z, P.AIR);
    }
    return await fingerprint(map);
  } finally {
    for (let k = kept.length - 1; k >= 0; k--) {
      const [x, y, z, id] = kept[k];
      map.set(x, y, z, id);
    }
  }
}

/**
 * The page's fingerprint, as main.ts's hook gives it: the world's; with `mask`, maskedFingerprint, and
 * only while the page's frames are held (`frozen`, a test's freeze()), as a frame run while the masked
 * voxels are air would see them so, and could cut, dig or spatter there. Unheld, a mask is refused.
 */
export function pageFingerprint(map: BrickMap, mask: readonly number[] | undefined, frozen: boolean): Promise<string> {
  if (!mask) return fingerprint(map);
  if (!frozen) return Promise.reject(new Error('fingerprint(mask) sets voxels to air while it hashes: hold the frames first (freeze()), and thaw() after'));
  return maskedFingerprint(map, mask);
}
