// One traceWorld call per ray, for the traversal tests.
#include "../../../src/render/shaders/traverse.wgsl"

struct Ray {
  o: vec3f,
  tMax: f32,
  d: vec3f,
  wantMaterial: u32,
}

struct Result {
  t: f32,
  face: u32,
  mat: u32,
  steps: u32,
  cell: vec3i,
  hit: u32,
}

@group(1) @binding(0) var<storage, read> rays: array<Ray>;
@group(1) @binding(1) var<storage, read_write> results: array<Result>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= arrayLength(&rays)) { return; }
  let r = rays[g.x];
  let h = traceWorld(r.o, r.d, r.tMax, r.wantMaterial != 0u);
  results[g.x] = Result(h.t, h.face, h.mat, h.steps, h.cell, select(0u, 1u, h.hit));
}
