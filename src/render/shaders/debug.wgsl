// A plain shade from the G-buffer and the raw lighting, until the denoiser and
// the real shading pass arrive: palette albedo with the probe's per-voxel
// variation, the key light times its visibility, sky and point light, the sky.
#include "palette.wgsl"
#include "common.wgsl"
#include "camera.wgsl"
#include "sky.wgsl"
#include "traverse.wgsl"
#include "farfield.wgsl"

@group(1) @binding(0) var gDepth: texture_2d<f32>;
@group(1) @binding(1) var gHit: texture_2d<u32>;
@group(1) @binding(2) var outColour: texture_storage_2d<rgba16float, write>;
@group(1) @binding(3) var lNoisy: texture_2d<f32>;

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
  let rd = cameraRay(frame.cam, vec2f(g.xy) + 0.5 + frameJitter(), vec2f(frame.res));
  if (face == 7u) {
    colour = skyColour(rd);
  } else if (face == 6u) {
    let p = frame.cam.origin + rd * textureLoad(gDepth, vec2i(g.xy), 0).r;
    let n = farNormalAt(p);
    colour = albedoOf(hit.y >> 16u) * (frame.keyColour * max(dot(n, frame.keyDir), 0.0) + skyIrradiance(n));
  } else {
    // The nearest lighting pixel's raw light, until the denoiser and upsampling arrive.
    let cell = vec3i(i32(hit.x & 0xfffu), i32(hit.y & 0xffffu), i32((hit.x >> 12u) & 0xfffu));
    let mat = hit.y >> 16u;
    let n = faceNormal(face);
    let l = textureLoad(lNoisy, vec2i(g.xy / frame.lightScale), 0);
    colour = albedoOf(mat) * variation(cell) * (frame.keyColour * l.a * max(dot(n, frame.keyDir), 0.0) + l.rgb) + emissionOf(mat);
  }
  textureStore(outColour, g.xy, vec4f(colour, 1.0));
}
