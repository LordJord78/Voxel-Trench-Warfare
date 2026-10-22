/**
 * The light cells (light-cells.wgsl) on the CPU: for each square of the grid over the map's x and z,
 * the lights whose sphere reaches it (strictly within their radius, across x and z: a cell is the
 * whole column over its square), at most `max`, nearest its middle first and the lower index first
 * between lights as near. Positions, radii and the cell's side in voxels, as the GPU has them; cells
 * in rows of x, as the GPU lays them out.
 */

export interface RefLight {
  pos: readonly [number, number, number];
  radius: number;
}

export function cellLists(lights: readonly RefLight[], grid: readonly [number, number], cellVoxels: number, max: number): number[][] {
  const out: number[][] = [];
  for (let cz = 0; cz < grid[1]; cz++) {
    for (let cx = 0; cx < grid[0]; cx++) {
      const lo = [cx * cellVoxels, cz * cellVoxels];
      const hi = [lo[0] + cellVoxels, lo[1] + cellVoxels];
      const mid = [lo[0] + cellVoxels / 2, lo[1] + cellVoxels / 2];
      const near: { i: number; key: number }[] = [];
      lights.forEach((l, i) => {
        const ex = l.pos[0] - Math.min(Math.max(l.pos[0], lo[0]), hi[0]);
        const ez = l.pos[2] - Math.min(Math.max(l.pos[2], lo[1]), hi[1]);
        if (!(ex * ex + ez * ez < l.radius * l.radius)) return;
        const mx = l.pos[0] - mid[0];
        const mz = l.pos[2] - mid[1];
        near.push({ i, key: mx * mx + mz * mz });
      });
      near.sort((a, b) => a.key - b.key || a.i - b.i);
      out.push(near.slice(0, max).map((n) => n.i));
    }
  }
  return out;
}
