// Point lights (see lights.ts): position and radius in voxels, colour, intensity; as many as
// MAX_LIGHTS a frame. A light's contribution reads the frame's voxel size, so a module that
// includes this declares `frame` (scene.wgsl does).

const MAX_LIGHTS: u32 = 1024u;

struct Light {
  pos: vec3f,
  radius: f32,
  colour: vec3f,
  intensity: f32,
}

// A light's contribution to a face, as if nothing were in the way (distances in metres).
fn unshadowed(l: Light, p: vec3f, n: vec3f) -> vec3f {
  let d = l.pos - p;
  let dist = length(d);
  if (dist >= l.radius || dist < 1e-3) {
    return vec3f(0.0);
  }
  let ndl = max(dot(n, d / dist), 0.0);
  let x = dist / l.radius;
  let win = clamp(1.0 - x * x * x * x, 0.0, 1.0);
  let m = dist * frame.voxel;
  return l.colour * (l.intensity * ndl * win * win / (m * m + 1.0));
}
