// The haze's smoke along rays of the view: gathered once a column, as froxels.wgsl's integrate
// takes it (smoke.wgsl), and summed puff by puff at each distance over every puff the frame holds,
// as integrate took it before (its puffDepth, the reference), for the smoke's tests.
#include "../../../src/render/shaders/smoke.wgsl"
#include "../../../src/render/shaders/common.wgsl"
#include "../../../src/render/shaders/camera.wgsl"

struct Query {
  uv: vec2f,
  metres: f32,
  pad: f32,
}

struct Answer {
  // The gathered depth, the reference's, and how many puffs the column gathered.
  gathered: f32,
  reference: f32,
  count: f32,
  pad: f32,
}

@group(1) @binding(0) var<storage, read> queries: array<Query>;
@group(1) @binding(1) var<storage, read_write> answers: array<Answer>;

// The smoke's optical depth along rd to `metres` out, every puff's chord tested at once.
fn referenceDepth(rd: vec3f, metres: f32) -> f32 {
  var depth = 0.0;
  let end = metres / frame.voxel;
  for (var i = 0u; i < frame.puffCount; i++) {
    let puff = frame.puffs[i];
    let o = frame.cam.origin - puff.centre;
    let along = -dot(rd, o);
    let r2 = puff.radius * puff.radius;
    let h2 = r2 - (dot(o, o) - along * along);
    if (h2 <= 0.0) {
      continue;
    }
    let h = sqrt(h2);
    let s0 = max(-h, -along);
    let s1 = min(h, end - along);
    if (s1 <= s0) {
      continue;
    }
    let voxels = (s1 - s0) * h2 / r2 - (s1 * s1 * s1 - s0 * s0 * s0) / (3.0 * r2);
    depth += puff.density * voxels * frame.voxel;
  }
  return depth;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= arrayLength(&queries)) {
    return;
  }
  let q = queries[g.x];
  let res = vec2f(frame.res);
  let rd = cameraRay(frame.cam, q.uv * res, res);
  var smoke = gatherSmoke(rd, 120.0 / frame.voxel);
  answers[g.x] = Answer(smokeTo(&smoke, q.metres), referenceDepth(rd, q.metres), f32(smoke.count), 0.0);
}
