// To the canvas: the internal image stretched over it, exposure, the ACES fit
// and a gamma-2.2 encode, as the probe did. Milestone 4's last task adds the
// bicubic upscale, sharpening and dither.

struct Present {
  // Internal image size, and the size its texture was allocated at.
  res: vec2f,
  alloc: vec2f,
  canvas: vec2f,
  exposure: f32,
  pad: f32,
}

@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var<uniform> present: Present;

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
  let c = textureSampleLevel(image, linearSampler, uv, 0.0).rgb * present.exposure;
  return vec4f(pow(aces(c), vec3f(1.0 / 2.2)), 1.0);
}
