/**
 * A page's world as two pages compare it (main.ts's hooks, for battle.spec.ts's sameWorlds): blood
 * spatter is per page and colour only (the shared-battle plan's note 12: each page spatters a
 * headshot or a kill from its own tick, the victim's none), so a comparison of two pages' worlds
 * masks every voxel where either holds a BLOOD_* id. Here a page finds its own blood, and hashes its
 * world (world/fingerprint.ts) with the union of both pages' set to air.
 */

import { packCell } from '../combat/entrenching';
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
  const { x: X, y: Y, z: Z } = map.dims;
  const kept: [number, number, number, number][] = [];
  try {
    for (const c of mask) {
      if (!Number.isInteger(c) || c < 0 || c >= X * Y * Z) continue;
      const x = c % X;
      const y = Math.floor(c / X) % Y;
      const z = Math.floor(c / (X * Y));
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
