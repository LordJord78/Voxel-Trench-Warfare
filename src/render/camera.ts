/**
 * The camera, in the Python game's conventions: yaw 0 looks down +z with +x
 * to the right, yaw and pitch in degrees, a 90° horizontal field of view
 * unless the pose narrows it (the periscope, the pause menu's setting).
 * Pixel (i, j)'s centre is at (i + 0.5, j + 0.5); `rayDir` and
 * `projectToPixel` are exact inverses, and primary.wgsl builds its rays with
 * the same formula.
 */

export type Vec3 = [number, number, number];

export interface CameraPose {
  /** Metres. */
  position: Vec3;
  yaw: number;
  pitch: number;
  /** Horizontal field of view in degrees; 90 if absent. */
  fov?: number;
}

const RAD = Math.PI / 180;

/** Tangent of half the horizontal field of view: the image's half-width at unit depth. */
export function tanHalf(pose: CameraPose): number {
  return pose.fov === undefined || pose.fov === 90 ? 1 : Math.tan((pose.fov * RAD) / 2);
}

export function cameraBasis(yaw: number, pitch: number): { forward: Vec3; right: Vec3; up: Vec3 } {
  const y = yaw * RAD;
  const p = pitch * RAD;
  const forward: Vec3 = [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)];
  const right: Vec3 = [Math.cos(y), 0, -Math.sin(y)];
  const up: Vec3 = [
    forward[1] * right[2] - forward[2] * right[1],
    forward[2] * right[0] - forward[0] * right[2],
    forward[0] * right[1] - forward[1] * right[0],
  ];
  return { forward, right, up };
}

/** The radical inverse of `index` in `base`. */
export function halton(index: number, base: number): number {
  let f = 1;
  let r = 0;
  for (let i = index; i > 0; i = Math.floor(i / base)) {
    f /= base;
    r += f * (i % base);
  }
  return r;
}

/** Sub-pixel jitter for a frame, in pixels: 16 Halton (2, 3) points about the pixel centre. */
export function jitter(frame: number): [number, number] {
  const i = (frame % 16) + 1;
  return [halton(i, 2) - 0.5, halton(i, 3) - 0.5];
}

/** The unit ray through continuous pixel coordinates (px, py) of a `res` image. */
export function rayDir(pose: CameraPose, res: readonly [number, number], px: number, py: number): Vec3 {
  const { forward, right, up } = cameraBasis(pose.yaw, pose.pitch);
  const aspect = res[0] / res[1];
  const t = tanHalf(pose);
  const x = ((2 * px) / res[0] - 1) * t;
  const y = ((1 - (2 * py) / res[1]) / aspect) * t;
  const d: Vec3 = [forward[0] + right[0] * x + up[0] * y, forward[1] + right[1] * x + up[1] * y, forward[2] + right[2] * x + up[2] * y];
  const l = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / l, d[1] / l, d[2] / l];
}

/** Where a point (metres) lands on a `res` image, or null behind the camera. */
export function projectToPixel(pose: CameraPose, res: readonly [number, number], point: readonly [number, number, number]): [number, number] | null {
  const { forward, right, up } = cameraBasis(pose.yaw, pose.pitch);
  const d = [point[0] - pose.position[0], point[1] - pose.position[1], point[2] - pose.position[2]];
  const depth = d[0] * forward[0] + d[1] * forward[1] + d[2] * forward[2];
  if (depth <= 0) return null;
  const aspect = res[0] / res[1];
  const t = tanHalf(pose);
  const x = (d[0] * right[0] + d[1] * right[1] + d[2] * right[2]) / (depth * t);
  const y = ((d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) / (depth * t)) * aspect;
  return [((x + 1) * res[0]) / 2, ((1 - y) * res[1]) / 2];
}
