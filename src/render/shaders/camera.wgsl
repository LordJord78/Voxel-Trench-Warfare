// Camera rays and projections, the same formulas as camera.ts: pixel (i, j)'s
// centre is (i + 0.5, j + 0.5) of a `res` image and the horizontal field of
// view is 90 degrees. Positions are voxels.

fn cameraRay(c: Camera, px: vec2f, res: vec2f) -> vec3f {
  let aspect = res.x / res.y;
  let x = (2.0 * px.x / res.x - 1.0) * c.tanHalf;
  let y = (1.0 - 2.0 * px.y / res.y) * c.tanHalf / aspect;
  return normalize(c.forward + c.right * x + c.up * y);
}

// Continuous pixel coordinates of a point (no jitter), or far off-screen behind the camera.
fn project(c: Camera, p: vec3f, res: vec2f) -> vec2f {
  let d = p - c.origin;
  let depth = dot(d, c.forward);
  if (depth <= 1e-4) {
    return vec2f(-1e6);
  }
  let aspect = res.x / res.y;
  let x = dot(d, c.right) / (depth * c.tanHalf);
  let y = dot(d, c.up) / (depth * c.tanHalf) * aspect;
  return vec2f((x + 1.0) * res.x * 0.5, (1.0 - y) * res.y * 0.5);
}

// This frame's jitter, unless the frame turned it off.
fn frameJitter() -> vec2f {
  return select(frame.cam.jitter, vec2f(0.0), (frame.flags & FLAG_JITTER_OFF) != 0u);
}
