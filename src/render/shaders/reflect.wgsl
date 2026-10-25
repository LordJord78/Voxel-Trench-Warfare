// The water's reflection (renderer.ts's `reflect` pass, before shade): for each pixel of the
// internal image whose G-buffer hit is a water voxel's top, what its surface reflects toward the
// eye. The reflected ray leaves a sixteenth of a voxel over the surface and is traced through the
// world (the shared traversal) to frame.reflectReach; what it meets is shaded cheaply, as it has no
// denoised light of its own: its albedo, the key light through the key's height map, the sky's
// ambient, the nearest four lights of its light cell unshadowed, and its emission, seen through the
// analytic fog over the reflected path. Where it meets nothing, the sky. The low preset
// (FLAG_REFLECT_SKY) traces nothing: the sky alone. Along the ray, the flares' and fires' glints:
// where it passes through a glint's disc, short of anything it meets, that light. Shade weighs the
// result against the water's own colour by Fresnel.
#include "traverse.wgsl"
#include "camera.wgsl"
#include "fog.wgsl"
#include "palette.wgsl"
#include "lightgrid.wgsl"
#include "light-cells.wgsl"
#include "key-shadow.wgsl"

const KIND_WATER_REFLECT: u32 = 14u;
// The sky's reflection, as the shade pass sees the sky: through this much fog.
const REFLECT_SKY_METRES: f32 = 2000.0;
// The most of a light cell's list a reflection's hit is lit by.
const REFLECT_LIGHTS: u32 = 4u;

@group(3) @binding(0) var gDepth: texture_2d<f32>;
@group(3) @binding(1) var gHit: texture_2d<u32>;
@group(3) @binding(2) var reflectOut: texture_storage_2d<rgba16float, write>;

// What a reflected ray meets at q (voxels), on its face with normal n, of material mat: lit cheaply.
fn reflectedLight(q: vec3f, n: vec3f, mat: u32) -> vec3f {
  var lit = frame.keyColour * keyLit(q + n * 0.5) * max(dot(n, frame.keyDir), 0.0) + skyIrradiance(n);
  let cell = cellOf(q);
  if (cell >= 0) {
    let count = min(cellCount(cell), REFLECT_LIGHTS);
    for (var k = 0u; k < count; k++) {
      lit += unshadowed(lights[cellLight(cell, k)], q, n);
    }
  }
  return albedoOf(mat) * lit + emissionOf(mat);
}

// The flares' and fires' glints the reflected ray from ro along r passes through, short of `until` voxels.
fn glintsAlong(ro: vec3f, r: vec3f, until: f32) -> vec3f {
  var light = vec3f(0.0);
  for (var k = 0u; k < min(frame.glintCount, 32u); k++) {
    let g = frame.glints[2u * k];
    let toward = g.xyz - ro;
    let along = dot(toward, r);
    if (along <= 0.0 || along >= until) {
      continue;
    }
    let off2 = max(dot(toward, toward) - along * along, 0.0);
    let radius = g.w;
    if (off2 >= radius * radius) {
      continue;
    }
    // A soft edge over the disc's outer quarter; as bright as its light is near.
    let edge = 1.0 - smoothstep(0.75, 1.0, sqrt(off2) / radius);
    let metres = along * frame.voxel;
    light += frame.glints[2u * k + 1u].rgb * (edge / (metres * metres + 1.0));
  }
  return light;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= frame.res.x || g.y >= frame.res.y) {
    return;
  }
  let hit = textureLoad(gHit, vec2i(g.xy), 0).xy;
  let mat = hit.y >> 16u;
  if (hitFace(hit) != 3u || kindOf(mat) != KIND_WATER_REFLECT) {
    return;
  }
  let rd = cameraRay(frame.cam, vec2f(g.xy) + 0.5 + frameJitter(), vec2f(frame.res));
  let depth = textureLoad(gDepth, vec2i(g.xy), 0).r;
  let p = frame.cam.origin + rd * depth;
  let n = vec3f(0.0, 1.0, 0.0);
  var r = reflect(rd, n);
  // Never under the surface it leaves.
  r = normalize(vec3f(r.x, max(r.y, 0.02), r.z));
  let ro = p + vec3f(0.0, 1.0 / 16.0, 0.0);
  let waterY = p.y * frame.voxel;
  var colour: vec3f;
  var until = 1e9;
  var seen = false;
  if ((frame.flags & FLAG_REFLECT_SKY) == 0u) {
    let h = traceWorld(ro, r, 0.0, frame.reflectReach, true);
    if (h.hit) {
      seen = true;
      until = h.t;
      let q = ro + r * h.t;
      let f = fog(waterY, r, h.t * frame.voxel);
      colour = reflectedLight(q, faceNormal(h.face), h.mat) * f.a + f.rgb * (1.0 - f.a);
    }
  }
  if (!seen) {
    let f = fog(waterY, r, REFLECT_SKY_METRES);
    colour = skyWithBodies(r) * f.a + f.rgb * (1.0 - f.a);
  }
  colour += glintsAlong(ro, r, until);
  textureStore(reflectOut, g.xy, vec4f(colour, 1.0));
}
