// The froxels' haze at points of the view (uv, metres along its ray), beside the analytic fog's
// there, for the froxels' tests.
#include "../../../src/render/shaders/haze.wgsl"
#include "../../../src/render/shaders/fog.wgsl"
#include "../../../src/render/shaders/camera.wgsl"

struct Query {
  uv: vec2f,
  metres: f32,
  pad: f32,
}

struct Answer {
  // In-scattered light and transmittance from the froxels; and the analytic fog's, its colour
  // times what it hides.
  haze: vec4f,
  fog: vec4f,
}

@group(1) @binding(0) var<storage, read> queries: array<Query>;
@group(1) @binding(1) var<storage, read_write> answers: array<Answer>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= arrayLength(&queries)) {
    return;
  }
  let q = queries[g.x];
  let res = vec2f(frame.res);
  let rd = cameraRay(frame.cam, q.uv * res, res);
  let f = fog(frame.cam.origin.y * frame.voxel, rd, q.metres);
  answers[g.x] = Answer(hazeAt(q.uv, q.metres), vec4f(f.rgb * (1.0 - f.a), f.a));
}
