// Contrast-adaptive sharpening (AMD FidelityFX CAS): sharpen each pixel
// against its four neighbours, less where the neighbourhood already has
// contrast, so TAA's softness is undone without ringing. It works on colours
// squashed into [0, 1) by c/(1 + max(c)), and unsquashes the result.
#include "scene.wgsl"

@group(1) @binding(0) var image: texture_2d<f32>;
@group(1) @binding(1) var sharpened: texture_storage_2d<rgba16float, write>;

fn squash(c: vec3f) -> vec3f {
  return c / (1.0 + max(c.r, max(c.g, c.b)));
}

fn unsquash(c: vec3f) -> vec3f {
  return c / max(1.0 - max(c.r, max(c.g, c.b)), 1e-3);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= frame.res.x || g.y >= frame.res.y) {
    return;
  }
  let p = vec2i(g.xy);
  let last = vec2i(frame.res) - 1;
  let raw = textureLoad(image, p, 0).rgb;
  let e = squash(raw);
  let a = squash(textureLoad(image, clamp(p + vec2i(0, -1), vec2i(0), last), 0).rgb);
  let b = squash(textureLoad(image, clamp(p + vec2i(-1, 0), vec2i(0), last), 0).rgb);
  let f = squash(textureLoad(image, clamp(p + vec2i(1, 0), vec2i(0), last), 0).rgb);
  let h = squash(textureLoad(image, clamp(p + vec2i(0, 1), vec2i(0), last), 0).rgb);
  let mn = min(e, min(min(a, b), min(f, h)));
  let mx = max(e, max(max(a, b), max(f, h)));
  let amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3f(1e-5)), vec3f(0.0), vec3f(1.0)));
  let w = amp * (-1.0 / mix(8.0, 5.0, frame.casSharpness));
  let out = (w * (a + b + f + h) + e) / (1.0 + 4.0 * w);
  // Past what the squash can hold (a texel brighter than 999: the sun's disc, the moon's), the texel
  // as it came: sharpening is nothing there, and the bloom must see all its light.
  let past = max(out.r, max(out.g, out.b)) >= 0.999;
  textureStore(sharpened, p, vec4f(select(unsquash(clamp(out, vec3f(0.0), vec3f(0.999))), raw, past), 1.0));
}
