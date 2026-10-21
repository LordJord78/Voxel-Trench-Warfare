// The lighting grid: lighting, denoising and upsampling all work on the
// internal image's pixels in L × L blocks, each block represented by one of
// its pixels, a different one each frame. Shared helpers for them.
#include "scene.wgsl"

const BAYER2 = array(vec2u(0u, 0u), vec2u(1u, 1u), vec2u(1u, 0u), vec2u(0u, 1u));
const BAYER4 = array(
  vec2u(0u, 0u), vec2u(2u, 2u), vec2u(2u, 0u), vec2u(0u, 2u),
  vec2u(1u, 1u), vec2u(3u, 3u), vec2u(3u, 1u), vec2u(1u, 3u),
  vec2u(1u, 0u), vec2u(3u, 2u), vec2u(3u, 0u), vec2u(1u, 2u),
  vec2u(0u, 1u), vec2u(2u, 3u), vec2u(2u, 1u), vec2u(0u, 3u),
);

// Which pixel of lighting pixel q's block is traced on frame `f`.
fn representativeOn(q: vec2u, f: u32) -> vec2u {
  let o = select(BAYER4[f & 15u], BAYER2[f & 3u], frame.lightScale == 2u);
  return min(q * frame.lightScale + o, frame.res - 1u);
}

// Which pixel of lighting pixel q's block is traced this frame.
fn representative(q: vec2u) -> vec2u {
  return representativeOn(q, frame.frame);
}

fn hitFace(hit: vec2u) -> u32 {
  return (hit.x >> 24u) & 7u;
}

// The plane a voxel face lies on, as its coordinate along the face's axis:
// two faces are coplanar exactly when their faces and planes are equal.
fn hitPlane(hit: vec2u) -> i32 {
  let face = hitFace(hit);
  let cell = vec3i(i32(hit.x & 0xfffu), i32(hit.y & 0xffffu), i32((hit.x >> 12u) & 0xfffu));
  return cell[face >> 1u] + i32(face & 1u);
}

fn luminance(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

// How bright a lighting value is once the key light is multiplied back in:
// what the denoiser measures noise and edges by.
fn lightLuminance(l: vec4f, n: vec3f) -> f32 {
  return luminance(l.rgb) + l.a * luminance(frame.keyColour) * max(dot(n, frame.keyDir), 0.0);
}
