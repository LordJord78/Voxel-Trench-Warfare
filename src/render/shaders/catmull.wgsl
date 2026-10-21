// Bicubic (Catmull-Rom) sampling from nine bilinear taps: sharper than
// bilinear, which matters for a history resampled every frame (it would
// blur away) and for upscaling the internal image to the canvas.
// `size` is the texture's size in texels; `uv` its coordinates over it.
fn catmullRom(image: texture_2d<f32>, linear: sampler, uv: vec2f, size: vec2f) -> vec4f {
  let p = uv * size;
  let centre = floor(p - 0.5) + 0.5;
  let f = p - centre;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let o12 = w2 / w12;
  let t0 = (centre - 1.0) / size;
  let t3 = (centre + 2.0) / size;
  let t12 = (centre + o12) / size;
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
