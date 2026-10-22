// sameSpot (history.wgsl) on crafted last-frame lighting pixels, for the denoiser's history tests:
// each query is a pixel of last frame's lighting grid and a surface this frame claims it saw.
#include "../../../src/render/shaders/common.wgsl"
#include "../../../src/render/shaders/camera.wgsl"
#include "../../../src/render/shaders/lightgrid.wgsl"

@group(1) @binding(0) var hitBefore: texture_2d<u32>;
@group(1) @binding(1) var depthBefore: texture_2d<f32>;

struct Query {
  t: vec2i,
  face: u32,
  plane: i32,
  at: vec3f,
  reach: f32,
}

@group(1) @binding(2) var<storage, read> queries: array<Query>;
@group(1) @binding(3) var<storage, read_write> answers: array<u32>;

#include "../../../src/render/shaders/history.wgsl"

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) g: vec3u) {
  let q = queries[g.x];
  answers[g.x] = u32(sameSpot(q.t, q.face, q.plane, q.at, q.reach));
}
