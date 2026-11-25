/**
 * A page's world as two pages compare it (main.ts's hooks, for battle.spec.ts's sameWorlds): blood
 * spatter is per page and colour only (the shared-battle plan's note 12: each page spatters a
 * headshot or a kill from its own tick, the victim's none), so a comparison of two pages' worlds
 * masks every voxel where either holds a BLOOD_* id. Here a page finds its own blood, and hashes its
 * world (world/fingerprint.ts) with the union of both pages' set to air, only while its frames are
 * held; and says where a foot stands on its ground (standTop), for the specs that put a player there.
 */

import { packCell, unpackCell } from '../combat/entrenching';
import { UNIFORM, type BrickMap } from '../world/bricks';
import { fingerprint } from '../world/fingerprint';
import { P, PALETTE } from '../world/materials';

/** Whether each palette id is blood: the palette's names starting BLOOD_. */
const BLOOD = Uint8Array.from({ length: 256 }, (_, id) => (PALETTE[id]?.name.startsWith('BLOOD_') ? 1 : 0));

/**
 * Every voxel of `map` that holds a BLOOD_* id, as its packed cell (combat/entrenching.ts packCell),
 * ascending. Brick by brick: an empty brick, or a uniform one of another id, costs one look.
 */
export function bloodCells(map: BrickMap): number[] {
  const out: number[] = [];
  const { bricks, dims } = map;
  const voxels = new Uint8Array(512);
  for (let bi = 0; bi < map.table.length; bi++) {
    const e = map.table[bi];
    if (e === 0 || (e & UNIFORM && !BLOOD[e & 0xff])) continue;
    if (e & UNIFORM) voxels.fill(e & 0xff);
    else voxels.set(map.denseView(bi)!);
    if (!voxels.some((v) => BLOOD[v] === 1)) continue;
    const bx = (bi % bricks.x) * 8;
    const by = (Math.floor(bi / bricks.x) % bricks.y) * 8;
    const bz = Math.floor(bi / (bricks.x * bricks.y)) * 8;
    for (let i = 0; i < 512; i++) if (BLOOD[voxels[i]]) out.push(packCell(dims, bx + (i & 7), by + ((i >> 3) & 7), bz + (i >> 6)));
  }
  return out.sort((a, b) => a - b);
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

/**
 * The ground's top at (`x`, `z`) metres in `map` of `voxel`-metre voxels: the top (metres) of the
 * highest voxel there that is neither air nor water, where a foot stands; null with none, or off the world.
 */
export function standTop(map: BrickMap, x: number, z: number, voxel: number): number | null {
  const gx = Math.floor(x / voxel);
  const gz = Math.floor(z / voxel);
  if (!map.inBounds(gx, 0, gz)) return null;
  for (let y = map.dims.y - 1; y >= 0; y--) {
    const v = map.get(gx, y, gz);
    if (v !== P.AIR && v !== P.WATER) return (y + 1) * voxel;
  }
  return null;
}
