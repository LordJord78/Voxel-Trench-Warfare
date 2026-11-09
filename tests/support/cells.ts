/**
 * Scoops' cells packed in the world's own dims (net/protocol.ts WORLD_DIMS, both maps'), as the wire
 * reads and checks them: a voxel's cell, the world's last cell, and the most a scoop may carry,
 * packed as large as they come. Written out here rather than taken from combat/entrenching.ts
 * packCell, so the protocol's tests pin the packing itself.
 */
import { DIG_CELLS_MAX, WORLD_DIMS } from '../../src/net/protocol';

/** A voxel of the world packed as a scoop's cell is, (z·Y + y)·X + x. */
export const worldCell = (x: number, y: number, z: number): number => (z * WORLD_DIMS.y + y) * WORLD_DIMS.x + x;

/** The world's last cell, at its far corner. */
export const LAST_CELL = WORLD_DIMS.x * WORLD_DIMS.y * WORLD_DIMS.z - 1;

/** DIG_CELLS_MAX cells at the world's far corner, eight by eight: the most a scoop may carry, packed as large as they come. */
export const MOST_CELLS: readonly number[] = Array.from({ length: DIG_CELLS_MAX }, (_, i) => worldCell(WORLD_DIMS.x - 1 - (i % 8), WORLD_DIMS.y - 1 - Math.floor(i / 8), WORLD_DIMS.z - 1));
