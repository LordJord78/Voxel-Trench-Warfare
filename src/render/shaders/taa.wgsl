// Temporal anti-aliasing. Each frame's image is jittered by a different
// sub-pixel offset; blending it into the history reprojected by motion
// averages those offsets into smooth edges. The history is clamped to the
// colours the current pixel's 3 × 3 neighbourhood spans (in YCoCg, where that
// box is tight), so what moved away or changed cannot linger as a trail; and
// the faster a pixel moves the more of the current frame it takes. The blend
// weights each colour by 1/(1 + luma), so a few bright pixels do not flicker.
#include "scene.wgsl"
#include "common.wgsl"
#include "catmull.wgsl"

@group(1) @binding(0) var colourNow: texture_2d<f32>;
@group(1) @binding(1) var motion: texture_2d<f32>;
@group(1) @binding(2) var historyBefore: texture_2d<f32>;
@group(1) @binding(3) var historyOut: texture_storage_2d<rgba16float, write>;
@group(1) @binding(4) var linear: sampler;

fn toYCoCg(c: vec3f) -> vec3f {
  return vec3f(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}

fn fromYCoCg(c: vec3f) -> vec3f {
  return vec3f(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
}

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= frame.res.x || g.y >= frame.res.y) {
    return;
  }
  let p = vec2i(g.xy);
  let res = vec2i(frame.res);
  let current = textureLoad(colourNow, p, 0).rgb;
  let m = textureLoad(motion, p, 0).xy;
  // Where this pixel was in the last frame's image, which dynamic resolution may have sized differently.
  let uv = (vec2f(g.xy) + 0.5 + m) * (vec2f(frame.prevRes) / vec2f(frame.res)) / vec2f(frame.alloc);
  let onScreen = all(uv >= vec2f(0.0)) && all(uv <= vec2f(frame.prevRes) / vec2f(frame.alloc));
  if (!onScreen || (frame.flags & FLAG_HISTORY_RESET) != 0u) {
    textureStore(historyOut, p, vec4f(current, 1.0));
    return;
  }
  var lo = vec3f(1e9);
  var hi = vec3f(-1e9);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let c = toYCoCg(textureLoad(colourNow, clamp(p + vec2i(dx, dy), vec2i(0), res - 1), 0).rgb);
      lo = min(lo, c);
      hi = max(hi, c);
    }
  }
  let before = catmullRom(historyBefore, linear, uv, vec2f(frame.alloc), vec2f(frame.prevRes)).rgb;
  let history = fromYCoCg(clamp(toYCoCg(before), lo, hi));
  let a = clamp(0.06 + 0.04 * length(m), 0.06, 0.25);
  let wc = a / (1.0 + luma(current));
  let wh = (1.0 - a) / (1.0 + luma(history));
  textureStore(historyOut, p, vec4f((current * wc + history * wh) / (wc + wh), 1.0));
}
