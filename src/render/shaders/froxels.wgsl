// The froxels (see froxels.ts): the haze in each froxel of the view (haze.wgsl's grid), and the
// light it glows with. That is fogColour's, but with the key light's share as far as the height
// map lets it reach the froxel (keyLit; where it does not, frame.hazeShadow of it, what the lit
// haze round it scatters in), and with up to four of the froxel's cell's point lights added (by
// frame.hazeLights), drawn as ReSTIR draws its candidates: one from each of four stretches of the
// cell's list, weighed by the stretch's length; a list of four or fewer, whole. Point lights glow
// through the haze by the approved haze's phase, as the key does: a flare with a shadow map as far
// as its map lets it reach the froxel (flareLit), the rest unshadowed.
//
// `inject` samples each froxel at a depth within its slice that each frame moves through it by the
// golden ratio, from a blue-noise start across the view: how much of the key light reaches it, and
// the point lights' glow. It blends both at FROXEL_BLEND into last frame's for the same place, where
// last frame's view held it: they are what each frame samples only a little of. `integrate` runs
// down each column, front to back: it lights each slice's haze with this frame's key and sky by
// how much of the key reaches it (so the haze never lags the light), adds the point lights' glow,
// adds the shells' blasts' glow at the slice's middle (unshadowed, as the point lights', and in no
// history: they last 0.3 s), and adds the slice over what the haze before it hides. How much the
// haze hides is hazeDepth's along each column's ray, and the shells' and fires' smoke's (smoke.wgsl:
// the puffs the column's ray passes through, found once a column): with nothing to cast a shaft,
// no point lights and no smoke, the froxels' haze is the analytic fog (fog.wgsl).
#include "haze.wgsl"
#include "fog.wgsl"
#include "light-cells.wgsl"
#include "key-shadow.wgsl"
#include "camera.wgsl"
#include "smoke.wgsl"

// The point lights each froxel draws.
const FROXEL_LIGHTS: u32 = 4u;
// How much of each frame's samples a froxel keeps: the rest is last frame's for the same place.
const FROXEL_BLEND: f32 = 0.1;
// The most glow a froxel's sample holds: under half floats' largest, so its history stays finite.
const GLOW_MAX: f32 = 60000.0;
// The sine of the key's elevation (3°) by which its shafts have come in. Lower, whatever it skims
// shades nearly all the haze near the ground, and that shade comes and goes faster than the
// exposure, reckoned from the light, can follow: so the haze keeps the key's whole glow there.
const SHAFTS_FROM: f32 = 0.0523;

// inject's: last frame's samples, and this frame's: the point lights' glow (rgb) and how much of the
// key light reaches the froxel (a).
@group(3) @binding(2) var glowBefore: texture_3d<f32>;
@group(3) @binding(3) var glowOut: texture_storage_3d<rgba16float, write>;
// integrate's: this frame's samples, and the haze.
@group(3) @binding(4) var glowNow: texture_3d<f32>;
@group(3) @binding(5) var hazeOut: texture_storage_3d<rgba16float, write>;

// The ray through the middle of froxel column `column`, of `columns` across and down the view.
fn columnRay(column: vec2u, columns: vec2u) -> vec3f {
  let res = vec2f(frame.res);
  return cameraRay(frame.cam, (vec2f(column) + 0.5) / vec2f(columns) * res, res);
}

// Where in its slice a froxel of `column` finds its glow this frame, 0 to 1: blue noise across the
// view, stepped through the frames by the golden ratio, in integers so it stays exact.
fn sliceJitter(column: vec2u) -> f32 {
  let r = textureLoad(blueNoise, vec2i(column & vec2u(63u)), 0).r;
  return f32(((r << 20u) + frame.frame * 0x9E3779B9u) >> 8u) * (1.0 / 16777216.0);
}

// The point lights' glow on the haze at x (voxels), toward the eye looking along rd.
fn pointGlow(x: vec3f, rd: vec3f, seed: vec3u) -> vec3f {
  var glow = vec3f(0.0);
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
    let index = cellLight(cell, lo + min(u32(random(&state) * f32(size)), size - 1u));
    let l = lights[index];
    let d = l.pos - x;
    let toward = d / max(length(d), 1e-6);
    let add = unshadowed(l, x, toward) * (frame.hazeLights * hazePhase(dot(rd, toward)) * f32(size) * flareLit(index, x));
    // A light that is not a number, or not finite, adds nothing: in the history it would stay so.
    glow += select(vec3f(0.0), add, all(add >= vec3f(0.0)) && all(add <= vec3f(GLOW_MAX)));
  }
  return min(glow, vec3f(GLOW_MAX));
}

@compute @workgroup_size(8, 8, 1)
fn inject(@builtin(global_invocation_id) g: vec3u) {
  let grid = textureDimensions(glowOut);
  if (any(g >= grid)) {
    return;
  }
  let rd = columnRay(g.xy, grid.xy);
  let k = f32(g.z);
  let metres = sliceMetres(k + sliceJitter(g.xy));
  let x = frame.cam.origin + rd * (metres / frame.voxel);
  let sample = vec4f(pointGlow(x, rd, vec3u(g.xy, g.z + frame.frame * FROXEL_SLICES)), keyLit(x));
  // Last frame's glow for the same place: the froxel's middle, where last frame's camera saw it.
  let middle = frame.cam.origin + rd * (sliceMetres(k + 0.5) / frame.voxel);
  let res = vec2f(frame.res);
  let uv = project(frame.prev, middle, res) / res;
  let s = froxelSlice(length(middle - frame.prev.origin) * frame.voxel);
  let seen = (frame.flags & FLAG_HISTORY_RESET) == 0u && all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0)) && s <= f32(FROXEL_SLICES);
  var out = sample;
  if (seen) {
    out = mix(textureSampleLevel(glowBefore, hazeSampler, vec3f(uv, s / f32(FROXEL_SLICES)), 0.0), sample, FROXEL_BLEND);
  }
  textureStore(glowOut, g, out);
}

// The shells' blasts' glow on the haze at x (voxels), toward the eye looking along rd.
fn blastGlow(x: vec3f, rd: vec3f) -> vec3f {
  var glow = vec3f(0.0);
  for (var i = 0u; i < min(frame.blastCount, 4u); i++) {
    let b = frame.blasts[i];
    let d = b.pos - x;
    let toward = d / max(length(d), 1e-6);
    glow += unshadowed(Light(b.pos, b.radius, b.colour, b.intensity), x, toward) * (frame.hazeLights * hazePhase(dot(rd, toward)));
  }
  return min(glow, vec3f(GLOW_MAX));
}

@compute @workgroup_size(8, 8, 1)
fn integrate(@builtin(global_invocation_id) g: vec3u) {
  let grid = textureDimensions(hazeOut);
  if (any(g.xy >= grid.xy)) {
    return;
  }
  let rd = columnRay(g.xy, grid.xy);
  let eyeY = frame.cam.origin.y * frame.voxel;
  // The share of the key's glow the haze keeps in shadow, all of it with the key near the horizon.
  let shadow = mix(1.0, frame.hazeShadow, smoothstep(0.0, SHAFTS_FROM, frame.keyDir.y));
  var light = vec3f(0.0);
  // The haze's optical depth to the slice's near side.
  var depth = 0.0;
  // The distant shells' flashes' glow, the same down the whole column.
  let horizon = frame.horizonHaze * horizonGlow(rd);
  // The puffs of smoke the column passes through.
  var smoke = gatherSmoke(rd, FROXEL_FAR / frame.voxel);
  for (var k = 0u; k < FROXEL_SLICES; k++) {
    let far = sliceMetres(f32(k + 1u));
    let to = max(hazeDepth(eyeY, rd, far) + smokeTo(&smoke, far), depth);
    // The slice's glow, lit by this frame's key as far as it reaches, over what of it the haze
    // before it lets through.
    let sampled = textureLoad(glowNow, vec3u(g.xy, k), 0);
    var glow = hazeGlowBase(rd, mix(shadow, 1.0, sampled.a)) + horizon + sampled.rgb;
    if (frame.blastCount > 0u) {
      glow += blastGlow(frame.cam.origin + rd * (sliceMetres(f32(k) + 0.5) / frame.voxel), rd);
    }
    light += glow * (exp(-depth) - exp(-to));
    depth = to;
    textureStore(hazeOut, vec3u(g.xy, k), vec4f(light, exp(-depth)));
  }
}
