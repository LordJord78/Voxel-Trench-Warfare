// To the canvas: the sharpened internal image upscaled bicubically (kept within
// the texels round each sample, so it does not ring), exposed,
// through the ACES fit, gamma-2.2 encoded (the probe's look), and dithered
// with blue noise below a single 8-bit step, so night skies do not band.
#include "catmull.wgsl"

struct Present {
  // Internal image size, and the size its texture was allocated at.
  res: vec2f,
  alloc: vec2f,
  canvas: vec2f,
  exposure: f32,
  pad: f32,
}

@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var linear: sampler;
@group(0) @binding(2) var<uniform> present: Present;
@group(0) @binding(3) var dither: texture_2d<u32>;

struct VOut {
  @builtin(position) pos: vec4f,
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VOut {
  var corners = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VOut;
  o.pos = vec4f(corners[i], 0.0, 1.0);
  return o;
}

fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

@fragment
fn fs(v: VOut) -> @location(0) vec4f {
  let uv = v.pos.xy / present.canvas * present.res / present.alloc;
  // The bicubic rings round a point far brighter than its neighbours (the sun's disc), its negative
  // lobes pulling the pixels round it below zero: keep it within the four texels it lies between.
  let at = vec2i(floor(uv * present.alloc - 0.5));
  let last = vec2i(present.res) - 1;
  let t00 = textureLoad(image, clamp(at, vec2i(0), last), 0).rgb;
  let t10 = textureLoad(image, clamp(at + vec2i(1, 0), vec2i(0), last), 0).rgb;
  let t01 = textureLoad(image, clamp(at + vec2i(0, 1), vec2i(0), last), 0).rgb;
  let t11 = textureLoad(image, clamp(at + vec2i(1, 1), vec2i(0), last), 0).rgb;
  let lo = min(min(t00, t10), min(t01, t11));
  let hi = max(max(t00, t10), max(t01, t11));
  let c = clamp(catmullRom(image, linear, uv, present.alloc, present.res).rgb, lo, hi) * present.exposure;
  let encoded = pow(aces(c), vec3f(1.0 / 2.2));
  let rank = textureLoad(dither, vec2i(v.pos.xy) & vec2i(63), 0).r;
  let noise = (f32(rank) + 0.5) / 4096.0 - 0.5;
  return vec4f(encoded + noise / 255.0, 1.0);
}
