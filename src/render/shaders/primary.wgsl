// Primary visibility: one jittered ray per pixel of the internal image, into
// the G-buffer. Depth is t in voxels along the unit ray (1e9 for sky); the hit
// is packed as x | z << 12 | face << 24 and y | palette << 16 (face 6 is the
// far field, 7 the sky); motion is where the hit point was last frame minus
// where it is now, both without jitter, in pixels, with the ray's traversal
// steps in its third channel for performance work.
#include "traverse.wgsl"
#include "camera.wgsl"

const FACE_SKY: u32 = 7u;

@group(1) @binding(0) var gDepth: texture_storage_2d<r32float, write>;
@group(1) @binding(1) var gHit: texture_storage_2d<rg32uint, write>;
@group(1) @binding(2) var gMotion: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= frame.res.x || g.y >= frame.res.y) {
    return;
  }
  let res = vec2f(frame.res);
  let rd = cameraRay(frame.cam, vec2f(g.xy) + 0.5 + frameJitter(), res);
  let h = traceWorld(frame.cam.origin, rd, 1e7, true);
  var depth = 1e9;
  var word0 = FACE_SKY << 24u;
  var word1 = 0u;
  var p = frame.cam.origin + rd * 1e5;
  if (h.hit) {
    depth = h.t;
    word0 = u32(h.cell.x) | (u32(h.cell.z) << 12u) | (h.face << 24u);
    word1 = u32(h.cell.y) | (h.mat << 16u);
    p = frame.cam.origin + rd * h.t;
  }
  let motion = project(frame.prev, p, res) - project(frame.cam, p, res);
  textureStore(gDepth, g.xy, vec4f(depth, 0.0, 0.0, 0.0));
  textureStore(gHit, g.xy, vec4u(word0, word1, 0u, 0u));
  textureStore(gMotion, g.xy, vec4f(motion, f32(h.steps), 0.0));
}
