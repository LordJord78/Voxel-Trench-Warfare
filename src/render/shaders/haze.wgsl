// The haze through the froxels (see froxels.ts): a grid of 160 × 90 columns over the view, each cut
// into 64 slices out from the eye to 120 m, each deeper than the last by the same ratio (and the
// first from the eye itself). Each slice's texel holds the haze from the eye to the slice's far
// side: the light it scatters toward the eye (rgb) and what of the scene behind it shows through
// (a). hazeAt reads it at a point of the view; hazeTo carries it on past 120 m with the analytic fog.
#include "fog.wgsl"

const FROXELS: vec3u = vec3u(160u, 90u, 64u);
// Slice 1 begins FROXEL_NEAR metres out and the last ends FROXEL_FAR metres out.
const FROXEL_NEAR: f32 = 0.5;
const FROXEL_FAR: f32 = 120.0;

// The haze, for a pass that reads it (froxels.ts's `group`).
@group(3) @binding(0) var hazeVolume: texture_3d<f32>;
@group(3) @binding(1) var hazeSampler: sampler;

// How far out along its ray slice coordinate s lies, in metres: slice k spans s = k to k + 1.
fn sliceMetres(s: f32) -> f32 {
  let first = FROXEL_NEAR * pow(FROXEL_FAR / FROXEL_NEAR, 1.0 / f32(FROXELS.z));
  if (s < 1.0) {
    return first * s;
  }
  return FROXEL_NEAR * pow(FROXEL_FAR / FROXEL_NEAR, s / f32(FROXELS.z));
}

// The slice coordinate of a point `metres` out along its ray.
fn froxelSlice(metres: f32) -> f32 {
  let first = FROXEL_NEAR * pow(FROXEL_FAR / FROXEL_NEAR, 1.0 / f32(FROXELS.z));
  if (metres < first) {
    return max(metres, 0.0) / first;
  }
  return f32(FROXELS.z) * log(metres / FROXEL_NEAR) / log(FROXEL_FAR / FROXEL_NEAR);
}

// The haze from the eye to a point `metres` out along the ray through `uv` (0 to 1 across the view,
// from its top left): the light it scatters toward the eye, and what shows through it. Past
// 120 m, the haze to 120 m.
fn hazeAt(uv: vec2f, metres: f32) -> vec4f {
  let s = min(froxelSlice(metres), f32(FROXELS.z));
  // Texel k holds the haze to slice k's far side, at s = k + 1; before slice 0's, there is none.
  let far = textureSampleLevel(hazeVolume, hazeSampler, vec3f(uv, (max(s, 1.0) - 0.5) / f32(FROXELS.z)), 0.0);
  if (s < 1.0) {
    return mix(vec4f(0.0, 0.0, 0.0, 1.0), far, s);
  }
  return far;
}

// The haze between the eye and a point `metres` along rd, through `uv` of the view: the light it
// scatters toward the eye and what shows through it. The froxels' nearer than 120 m, with the
// shafts and the point lights in it; from there, the analytic fog's, over what the froxels let
// through. The sky, 2 km off, is seen through the whole volume and the fog past it.
fn hazeTo(uv: vec2f, eyeY: f32, rd: vec3f, metres: f32) -> vec4f {
  let near = hazeAt(uv, metres);
  if (metres <= FROXEL_FAR) {
    return near;
  }
  // What the fog from 120 m on lets through.
  let past = exp(-max(hazeDepth(eyeY, rd, metres) - hazeDepth(eyeY, rd, FROXEL_FAR), 0.0));
  return vec4f(near.rgb + near.a * (1.0 - past) * fogColour(rd), near.a * past);
}
