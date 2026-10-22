// Primary visibility: one jittered ray per pixel of the internal image, into
// the G-buffer. Depth is t in voxels along the unit ray (1e9 for sky); the hit
// is packed as x | z << 12 | face << 24 and y | palette << 16 (face 6 is the
// far field, 7 the sky); motion is where the hit point was last frame minus
// where it is now, both without jitter, in pixels, with the ray's traversal
// steps in its third channel for performance work. In front of the pixels, the
// dispatch's first rows trace this frame's texels of the key light's height map
// (key-shadow.wgsl's keyShare).
#include "key-shadow.wgsl"
#include "farfield.wgsl"
#include "camera.wgsl"

const FACE_FAR: u32 = 6u;
const FACE_SKY: u32 = 7u;
// How far the far field is marched: 2.2 km, in voxels.
const FAR_RANGE: f32 = 22000.0;

// Where a ray leaves the voxel volume, or 0 if it never enters it.
fn volumeExit(ro: vec3f, rd: vec3f) -> f32 {
  let dims = vec3f(frame.world.dims);
  let moving = rd != vec3f(0.0);
  let inv = select(vec3f(0.0), vec3f(1.0) / rd, moving);
  let ta = select(vec3f(-1e30), -ro * inv, moving);
  let tb = select(vec3f(1e30), (dims - ro) * inv, moving);
  let tIn = max(max(min(ta.x, tb.x), min(ta.y, tb.y)), min(ta.z, tb.z));
  let tOut = min(min(max(ta.x, tb.x), max(ta.y, tb.y)), max(ta.z, tb.z));
  if (tOut < max(tIn, 0.0) || any(!moving & ((ro < vec3f(0.0)) | (ro >= dims)))) {
    return 0.0;
  }
  return max(tOut, 0.0);
}

// The palette entry a far-field material is drawn with (see farfield.ts FAR).
fn farPalette(m: u32) -> u32 {
  switch m {
    case 2u: { return 7u; }   // ploughed: MUD_TURNED
    case 3u: { return 33u; }  // wood: BRANCH
    case 4u: { return 27u; }  // roof: BRICK_DARK
    case 5u: { return 26u; }  // wall: BRICK
    case 6u: { return 24u; }  // spire: CONCRETE
    default: { return 1u; }   // field: SOD
  }
}

@group(1) @binding(0) var gDepth: texture_storage_2d<r32float, write>;
@group(1) @binding(1) var gHit: texture_storage_2d<rg32uint, write>;
@group(1) @binding(2) var gMotion: texture_storage_2d<rgba16float, write>;
// Per 8 × 8 tile, the forward depth before which no ray in it can hit anything (beam.wgsl).
@group(1) @binding(3) var beam: texture_2d<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u, @builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) local: u32) {
  if (keyShare(group, local)) {
    return;
  }
  let g = id.xy - vec2u(0u, keyBuild.rows * 8u);
  if (g.x >= frame.res.x || g.y >= frame.res.y) {
    return;
  }
  let res = vec2f(frame.res);
  let rd = cameraRay(frame.cam, vec2f(g) + 0.5 + frameJitter(), res);
  let start = textureLoad(beam, vec2i(g >> vec2u(3u)), 0).r / dot(rd, frame.cam.forward);
  let h = traceWorld(frame.cam.origin, rd, start, 1e7, true);
  var depth = 1e9;
  var word0 = FACE_SKY << 24u;
  var word1 = 0u;
  var p = frame.cam.origin + rd * 1e5;
  if (h.hit) {
    depth = h.t;
    word0 = u32(h.cell.x) | (u32(h.cell.z) << 12u) | (h.face << 24u);
    word1 = u32(h.cell.y) | (h.mat << 16u);
    p = frame.cam.origin + rd * h.t;
  } else {
    let far = marchFar(frame.cam.origin, rd, volumeExit(frame.cam.origin, rd), FAR_RANGE);
    if (far.hit) {
      depth = far.t;
      p = frame.cam.origin + rd * far.t;
      let s = vec2u(clamp((p.xz - frame.far.xy) / frame.far.z, vec2f(0.0), vec2f(4095.0)));
      word0 = s.x | (s.y << 12u) | (FACE_FAR << 24u);
      word1 = farPalette(far.mat) << 16u;
    }
  }
  let motion = project(frame.prev, p, res) - project(frame.cam, p, res);
  textureStore(gDepth, g, vec4f(depth, 0.0, 0.0, 0.0));
  textureStore(gHit, g, vec4u(word0, word1, 0u, 0u));
  textureStore(gMotion, g, vec4f(motion, f32(h.steps), 0.0));
}
