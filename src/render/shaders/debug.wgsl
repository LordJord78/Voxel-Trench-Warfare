// A plain shade from the G-buffer, until lighting exists: palette albedo with
// the probe's per-voxel variation, lit by a fixed direction, and the sky.
#include "palette.wgsl"
#include "common.wgsl"
#include "camera.wgsl"
#include "sky.wgsl"
#include "traverse.wgsl"

@group(1) @binding(0) var gDepth: texture_2d<f32>;
@group(1) @binding(1) var gHit: texture_2d<u32>;
@group(1) @binding(2) var outColour: texture_storage_2d<rgba16float, write>;

fn variation(cell: vec3i) -> f32 {
  let v = hash3(cell);
  let fine = 0.84 + 0.28 * f32(v & 255u) / 255.0;
  let blotch = 0.9 + 0.2 * f32(hash3(cell >> vec3u(2u)) & 255u) / 255.0;
  return fine * blotch;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= frame.res.x || g.y >= frame.res.y) {
    return;
  }
  let hit = textureLoad(gHit, vec2i(g.xy), 0).xy;
  let face = (hit.x >> 24u) & 7u;
  var colour: vec3f;
  if (face == 7u) {
    let rd = cameraRay(frame.cam, vec2f(g.xy) + 0.5 + frameJitter(), vec2f(frame.res));
    colour = skyColour(rd);
  } else {
    let cell = vec3i(i32(hit.x & 0xfffu), i32(hit.y & 0xffffu), i32((hit.x >> 12u) & 0xfffu));
    let mat = hit.y >> 16u;
    let n = faceNormal(face);
    let light = normalize(vec3f(0.4, 0.8, 0.45));
    colour = albedoOf(mat) * variation(cell) * (0.3 + 0.7 * max(dot(n, light), 0.0)) + emissionOf(mat);
  }
  textureStore(outColour, g.xy, vec4f(colour, 1.0));
}
