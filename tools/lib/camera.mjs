// The game's camera for the capture tools: src/render/camera.ts's cameraBasis and projectToPixel, here
// (a tool runs in Node, outside the game's build), so a point in the world (metres) is found on a
// screenshot by the pose the frame was drawn from. tests/tools/capture-measures.test.ts holds it to
// the game's own.

export const RAD = Math.PI / 180;
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const lerp = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const unit = (a) => {
  const n = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / n, a[1] / n, a[2] / n];
};

/** The camera's forward, right and up for a pose (degrees: yaw from +z toward +x, pitch up, roll). */
export function basis(pose) {
  const y = pose.yaw * RAD;
  const p = pose.pitch * RAD;
  const forward = [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)];
  const right = [Math.cos(y), 0, -Math.sin(y)];
  const up = [forward[1] * right[2] - forward[2] * right[1], forward[2] * right[0] - forward[0] * right[2], forward[0] * right[1] - forward[1] * right[0]];
  const roll = (pose.roll ?? 0) * RAD;
  if (roll === 0) return { forward, right, up };
  const c = Math.cos(roll);
  const s = Math.sin(roll);
  return { forward, right: [0, 1, 2].map((k) => right[k] * c + up[k] * s), up: [0, 1, 2].map((k) => up[k] * c - right[k] * s) };
}

/** Where a point (m) lands on a `res` image (pixels, continuous), by a pose whose horizontal field of view is `fov` (90 unless given); null behind the camera. */
export function project(pose, res, p) {
  const { forward, right, up } = basis(pose);
  const d = sub(p, pose.position);
  const depth = dot(d, forward);
  if (depth <= 0) return null;
  const t = pose.fov === undefined || pose.fov === 90 ? 1 : Math.tan((pose.fov * RAD) / 2);
  const x = dot(d, right) / (depth * t);
  const y = (dot(d, up) / (depth * t)) * (res[0] / res[1]);
  return [((x + 1) * res[0]) / 2, ((1 - y) * res[1]) / 2];
}
