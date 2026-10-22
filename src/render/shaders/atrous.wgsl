// One pass of the à-trous filter: a 5 × 5 B3 kernel with holes `step` lighting
// pixels apart (1, 2, then 4), so three passes cover a wide footprint for the
// price of 75 taps. A neighbour counts only on the same face, less the
// farther its plane (by a voxel, or far off by the ground it spans: rough
// ground's planes differ that much between pixels there, and where a pixel
// spans DETAIL_SPAN voxels its other faces count too), and less the more it differs than this pixel's noise
// explains — judged separately for the sky and point light (by their
// brightness and its tracked variance) and for the key light (by visibility:
// samples are each 0 or 1, so a mean a over n frames has variance a(1 - a)/n).
// So the sky's noise never blurs a shadow edge, and a converged edge stays put.
// A pixel with under four frames of history has no mean of its own (its few
// samples are each 0 or 1, which would say it has no noise at all), so its
// key light's noise is judged from its coplanar neighbours' average instead.
// The filter only makes the image shown; the history keeps the plain average.
#include "lightgrid.wgsl"

const KERNEL = array(1.0 / 16.0, 1.0 / 4.0, 3.0 / 8.0, 1.0 / 4.0, 1.0 / 16.0);
// The key light's edge stopping, in standard deviations of its mean: tighter
// than the sky's, because its noise estimate is exact and a converged shadow
// edge should not move.
const SIGMA_KEY: f32 = 1.0;

struct Atrous {
  step: i32,
  pad0: i32,
  pad1: i32,
  pad2: i32,
}

@group(1) @binding(0) var colourIn: texture_2d<f32>;
@group(1) @binding(1) var varianceIn: texture_2d<f32>;
@group(1) @binding(2) var hits: texture_2d<u32>;
@group(1) @binding(3) var colourOut: texture_storage_2d<rgba16float, write>;
@group(1) @binding(4) var varianceOut: texture_storage_2d<rg32float, write>;
@group(1) @binding(5) var<uniform> atrous: Atrous;
@group(1) @binding(6) var depths: texture_2d<f32>;

// The variance around q, blurred 3 × 3: one pixel's own estimate is too noisy to steer by.
fn blurredVariance(q: vec2i) -> f32 {
  let size = vec2i(frame.lightRes);
  var sum = 0.0;
  var total = 0.0;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let t = clamp(q + vec2i(dx, dy), vec2i(0), size - 1);
      let w = select(0.5, 1.0, dx == 0) * select(0.5, 1.0, dy == 0);
      sum += w * textureLoad(varianceIn, t, 0).r;
      total += w;
    }
  }
  return sum / total;
}

// The key light's visibility averaged over q's coplanar 3 × 3 neighbours, or q's own if it has none.
fn neighbourKey(q: vec2i, face: u32, plane: i32, own: f32) -> f32 {
  let size = vec2i(frame.lightRes);
  var sum = 0.0;
  var count = 0.0;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let t = q + vec2i(dx, dy);
      if (any(t < vec2i(0)) || any(t >= size)) {
        continue;
      }
      let h = textureLoad(hits, t, 0).xy;
      if (hitFace(h) != face || hitPlane(h) != plane) {
        continue;
      }
      sum += textureLoad(colourIn, t, 0).a;
      count += 1.0;
    }
  }
  return select(own, sum / count, count > 0.0);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= frame.lightRes.x || g.y >= frame.lightRes.y) {
    return;
  }
  let q = vec2i(g.xy);
  let centre = textureLoad(colourIn, q, 0);
  let hit = textureLoad(hits, q, 0).xy;
  let face = hitFace(hit);
  if (face >= 6u) {
    textureStore(colourOut, q, centre);
    textureStore(varianceOut, q, vec4f(0.0));
    return;
  }
  let plane = hitPlane(hit);
  let l = luminance(centre.rgb);
  let length = max(textureLoad(varianceIn, q, 0).g, 1.0);
  let spread = frame.sigmaLuma * sqrt(blurredVariance(q)) + 1e-4;
  // An if, not select: select evaluates both sides, and the neighbours are read only for a short history.
  var a = centre.a;
  if (length < 4.0) {
    a = neighbourKey(q, face, plane, centre.a);
  }
  let spreadKey = SIGMA_KEY * sqrt(a * (1.0 - a) / length) + 1e-3;
  let size = vec2i(frame.lightRes);
  let span = footprint(textureLoad(depths, q, 0).r);
  var rgb = vec3f(0.0);
  var key = 0.0;
  var variance = 0.0;
  var total = 0.0;
  var totalKey = 0.0;
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -2; dx <= 2; dx++) {
      let t = q + vec2i(dx, dy) * atrous.step;
      if (any(t < vec2i(0)) || any(t >= size)) {
        continue;
      }
      let h = textureLoad(hits, t, 0).xy;
      if (hitFace(h) != face && span < DETAIL_SPAN) {
        continue;
      }
      let c = textureLoad(colourIn, t, 0);
      // How far its plane may be: a voxel, or the ground between them where that is more.
      let apart = max(frame.sigmaPlane, span * f32(max(abs(dx), abs(dy)) * atrous.step));
      let near = KERNEL[dx + 2] * KERNEL[dy + 2] * exp(-f32(abs(hitPlane(h) - plane)) / apart);
      let w = near * exp(-abs(luminance(c.rgb) - l) / spread);
      let wk = near * exp(-abs(c.a - centre.a) / spreadKey);
      rgb += w * c.rgb;
      key += wk * c.a;
      variance += w * w * textureLoad(varianceIn, t, 0).r;
      total += w;
      totalKey += wk;
    }
  }
  textureStore(colourOut, q, vec4f(rgb / total, key / totalKey));
  textureStore(varianceOut, q, vec4f(variance / (total * total), length, 0.0, 0.0));
}
