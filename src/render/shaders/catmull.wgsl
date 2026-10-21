// Bicubic (Catmull-Rom) sampling from nine bilinear taps: sharper than
// bilinear, which matters for a history resampled every frame (it would
// blur away) and for upscaling the internal image to the canvas.
// `size` is the texture's size in texels; `uv` its coordinates over it.
// `valid` is the part of the texture, from its origin, that holds the image
// (dynamic resolution renders into less than all of it): every tap stays
// inside, so texels left over from a larger image are never read.
fn catmullRom(image: texture_2d<f32>, linear: sampler, uv: vec2f, size: vec2f, valid: vec2f) -> vec4f {
  let p = uv * size;
  let centre = floor(p - 0.5) + 0.5;
  let f = p - centre;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let o12 = w2 / w12;
  let lo = vec2f(0.5);
  let hi = valid - 0.5;
  let t0 = clamp(centre - 1.0, lo, hi) / size;
  let t3 = clamp(centre + 2.0, lo, hi) / size;
  let t12 = clamp(centre + o12, lo, hi) / size;
  var c = vec4f(0.0);
  c += textureSampleLevel(image, linear, vec2f(t0.x, t0.y), 0.0) * w0.x * w0.y;
  c += textureSampleLevel(image, linear, vec2f(t12.x, t0.y), 0.0) * w12.x * w0.y;
  c += textureSampleLevel(image, linear, vec2f(t3.x, t0.y), 0.0) * w3.x * w0.y;
  c += textureSampleLevel(image, linear, vec2f(t0.x, t12.y), 0.0) * w0.x * w12.y;
  c += textureSampleLevel(image, linear, vec2f(t12.x, t12.y), 0.0) * w12.x * w12.y;
  c += textureSampleLevel(image, linear, vec2f(t3.x, t12.y), 0.0) * w3.x * w12.y;
  c += textureSampleLevel(image, linear, vec2f(t0.x, t3.y), 0.0) * w0.x * w3.y;
  c += textureSampleLevel(image, linear, vec2f(t12.x, t3.y), 0.0) * w12.x * w3.y;
  c += textureSampleLevel(image, linear, vec2f(t3.x, t3.y), 0.0) * w3.x * w3.y;
  return max(c, vec4f(0.0));
}
