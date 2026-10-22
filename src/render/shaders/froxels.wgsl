// The froxels (see froxels.ts): the haze in each froxel of the view (haze.wgsl's grid), and the
// light it glows with. That is fogColour's, but with the key light's share as far as the height
// map lets it reach the froxel (keyLit), and with up to four of the froxel's cell's point lights
// added, drawn as ReSTIR draws its candidates: one from each of four stretches of the cell's list,
// weighed by the stretch's length; a list of four or fewer, whole. Point lights glow through the
// haze unshadowed, by the approved haze's phase, as the key does.
//
// `inject` finds each froxel's glow at a depth within its slice that each frame moves through it by
// the golden ratio, from a blue-noise start across the view, and blends it at FROXEL_BLEND into last
// frame's glow for the same place, where last frame's view held it. `integrate` runs down each
// column, front to back, adding each slice's glow over what the haze before it hides. How much the
// haze hides is fogDepth's, along each column's ray: with nothing to cast a shaft and no point
// lights, the froxels' haze is the analytic fog (fog.wgsl).
#include "haze.wgsl"
#include "fog.wgsl"
#include "light-cells.wgsl"
#include "key-shadow.wgsl"
#include "camera.wgsl"

// The point lights each froxel draws.
const FROXEL_LIGHTS: u32 = 4u;
// How much of each frame's glow a froxel keeps: the rest is last frame's for the same place.
const FROXEL_BLEND: f32 = 0.1;

// inject's: last frame's glow, and this frame's.
@group(3) @binding(2) var glowBefore: texture_3d<f32>;
@group(3) @binding(3) var glowOut: texture_storage_3d<rgba16float, write>;
// integrate's: this frame's glow, and the haze.
@group(3) @binding(4) var glowNow: texture_3d<f32>;
@group(3) @binding(5) var hazeOut: texture_storage_3d<rgba16float, write>;

// The ray through the middle of froxel column `column`.
fn columnRay(column: vec2u) -> vec3f {
  let res = vec2f(frame.res);
  return cameraRay(frame.cam, (vec2f(column) + 0.5) / vec2f(FROXELS.xy) * res, res);
}

// Where in its slice a froxel of `column` finds its glow this frame, 0 to 1: blue noise across the
// view, stepped through the frames by the golden ratio, in integers so it stays exact.
fn sliceJitter(column: vec2u) -> f32 {
  let r = textureLoad(blueNoise, vec2i(column & vec2u(63u)), 0).r;
  return f32(((r << 20u) + frame.frame * 0x9E3779B9u) >> 8u) * (1.0 / 16777216.0);
}

// The light the haze at x (voxels) glows with toward the eye looking along rd.
fn glowAt(x: vec3f, rd: vec3f, seed: vec3u) -> vec3f {
  var glow = hazeGlow(rd, keyLit(x));
  let cell = cellOf(x);
  if (cell < 0) {
    return glow;
  }
  let listed = cellCount(cell);
  let draws = min(listed, FROXEL_LIGHTS);
  var state = hash3(vec3i(seed));
  for (var k = 0u; k < draws; k++) {
    // Stretch k of the list, a light from it, and its light over the chance it was drawn, 1 / size.
    let lo = k * listed / draws;
    let size = (k + 1u) * listed / draws - lo;
    let l = lights[cellLight(cell, lo + min(u32(random(&state) * f32(size)), size - 1u))];
    let d = l.pos - x;
    let toward = d / max(length(d), 1e-6);
    let add = unshadowed(l, x, toward) * (hazePhase(dot(rd, toward)) * f32(size));
    // A light that is not a number adds nothing.
    glow += select(vec3f(0.0), add, all(add >= vec3f(0.0)));
  }
  return glow;
}

@compute @workgroup_size(8, 8, 1)
fn inject(@builtin(global_invocation_id) g: vec3u) {
  if (any(g >= FROXELS)) {
    return;
  }
  let rd = columnRay(g.xy);
  let k = f32(g.z);
  let metres = sliceMetres(k + sliceJitter(g.xy));
  let glow = glowAt(frame.cam.origin + rd * (metres / frame.voxel), rd, vec3u(g.xy, g.z + frame.frame * FROXELS.z));
  // Last frame's glow for the same place: the froxel's middle, where last frame's camera saw it.
  let middle = frame.cam.origin + rd * (sliceMetres(k + 0.5) / frame.voxel);
  let res = vec2f(frame.res);
  let uv = project(frame.prev, middle, res) / res;
  let s = froxelSlice(length(middle - frame.prev.origin) * frame.voxel);
  let seen = (frame.flags & FLAG_HISTORY_RESET) == 0u && all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0)) && s <= f32(FROXELS.z);
  var out = glow;
  if (seen) {
    let then = textureSampleLevel(glowBefore, hazeSampler, vec3f(uv, s / f32(FROXELS.z)), 0.0).rgb;
    out = mix(then, glow, FROXEL_BLEND);
  }
  textureStore(glowOut, g, vec4f(out, 1.0));
}

@compute @workgroup_size(8, 8, 1)
fn integrate(@builtin(global_invocation_id) g: vec3u) {
  if (any(g.xy >= FROXELS.xy)) {
    return;
  }
  let rd = columnRay(g.xy);
  let eyeY = frame.cam.origin.y * frame.voxel;
  var light = vec3f(0.0);
  // The haze's optical depth to the slice's near side.
  var depth = 0.0;
  for (var k = 0u; k < FROXELS.z; k++) {
    let far = sliceMetres(f32(k + 1u));
    let to = max(fogDepth(frame.fogDensity, frame.fogHeight, eyeY, rd, far) + fogDepth(frame.smokeDensity, frame.smokeHeight, eyeY, rd, far), depth);
    // The slice's glow, over what of it the haze before it lets through.
    light += textureLoad(glowNow, vec3u(g.xy, k), 0).rgb * (exp(-depth) - exp(-to));
    depth = to;
    textureStore(hazeOut, vec3u(g.xy, k), vec4f(light, exp(-depth)));
  }
}
