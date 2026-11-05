/**
 * The spatter tests' geometry (world/spatter.ts), in voxels: where a marked voxel lies about a cone's
 * axis, and the axis the falling rays spread about.
 */

/** The angle (radians) off unit `dir` of the way from `from` to the middle of voxel `cell`, and how far that middle is. */
export function offAxis(cell: readonly number[], from: readonly number[], dir: readonly number[]): { angle: number; r: number } {
  const d = [cell[0] + 0.5 - from[0], cell[1] + 0.5 - from[1], cell[2] + 0.5 - from[2]];
  const r = Math.hypot(d[0], d[1], d[2]);
  return { angle: Math.acos(Math.max(-1, Math.min(1, (d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2]) / r))), r };
}

/** Within `deg` of unit `dir` from `from`, for a voxel some ray went into: its middle is, give or take the half-diagonal it subtends. */
export function inCone(cell: readonly number[], from: readonly number[], dir: readonly number[], deg: number): boolean {
  const { angle, r } = offAxis(cell, from, dir);
  return angle <= (deg * Math.PI) / 180 + Math.asin(Math.min(1, Math.sqrt(3) / 2 / r)) + 1e-9;
}

/**
 * The falling rays' axis for a round along unit `dir`: `tiltDeg` from straight down toward the way it
 * goes across the ground, or straight down for a round within 1e-6 of straight up or down.
 */
export function fallAxis(dir: readonly number[], tiltDeg: number): [number, number, number] {
  const h = Math.hypot(dir[0], dir[2]);
  if (h <= 1e-6) return [0, -1, 0];
  const t = (tiltDeg * Math.PI) / 180;
  return [(dir[0] / h) * Math.sin(t), -Math.cos(t), (dir[2] / h) * Math.sin(t)];
}
