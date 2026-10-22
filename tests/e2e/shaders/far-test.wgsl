// One marchFar call per ray, for the far-field tests.
#include "../../../src/render/shaders/farfield.wgsl"

struct Ray {
  o: vec3f,
  tMin: f32,
  d: vec3f,
  tMax: f32,
}

struct Result {
  n: vec3f,
  t: f32,
  hit: u32,
  mat: u32,
  pad0: u32,
  pad1: u32,
}

@group(1) @binding(0) var<storage, read> rays: array<Ray>;
@group(1) @binding(1) var<storage, read_write> results: array<Result>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= arrayLength(&rays)) { return; }
  let r = rays[g.x];
  let h = marchFar(r.o, r.d, r.tMin, r.tMax);
  results[g.x] = Result(h.n, h.t, select(0u, 1u, h.hit), h.mat, 0u, 0u);
}

// The far field's shading normal at each ray's origin (only its x and z matter).
@compute @workgroup_size(64)
fn normals(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= arrayLength(&rays)) { return; }
  results[g.x] = Result(farNormalAt(rays[g.x].o), 0.0, 0u, 0u, 0u, 0u);
}
