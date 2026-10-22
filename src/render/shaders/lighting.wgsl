// Lighting, at a quarter of the pixels (a sixteenth on "low"): each L × L
// block of the internal image is represented by one of its pixels, a
// different one each frame, and that pixel traces what light reaches it:
//   - the key light (sun or moon): one shadow ray, jittered within a narrow
//     cone, so penumbrae soften as frames accumulate;
//   - the sky: one cosine-weighted ray, a few metres long;
//   - one point light, picked by how much it would add if nothing were in
//     the way, with one shadow ray, weighted back by how likely the pick was.
// It writes the sky and point light as irradiance (rgb) and the key light's
// visibility (a); shading multiplies the key light back in. The
// representative's depth and hit go alongside, for the denoiser.
#include "traverse.wgsl"
#include "camera.wgsl"
#include "sky.wgsl"
#include "lightgrid.wgsl"

@group(1) @binding(0) var gDepth: texture_2d<f32>;
@group(1) @binding(1) var gHit: texture_2d<u32>;
@group(1) @binding(2) var lNoisy: texture_storage_2d<rgba16float, write>;
@group(1) @binding(3) var hDepth: texture_storage_2d<r32float, write>;
@group(1) @binding(4) var hHit: texture_storage_2d<rg32uint, write>;

const NOISE_OFFSETS = array(vec2u(0u, 0u), vec2u(17u, 39u), vec2u(41u, 7u), vec2u(29u, 53u), vec2u(5u, 23u));

// The k-th random number of lighting pixel q this frame: blue noise in space,
// stepped through time by the golden ratio, in integers so it stays exact.
fn noise(q: vec2u, k: u32) -> f32 {
  let r = textureLoad(blueNoise, vec2i((q + NOISE_OFFSETS[k]) & vec2u(63u)), 0).r;
  let u = (r << 20u) + frame.frame * 0x9E3779B9u;
  return f32(u >> 8u) * (1.0 / 16777216.0);
}

fn basis(n: vec3f) -> mat3x3f {
  let a = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(n.x) > 0.5);
  let t = normalize(cross(n, a));
  return mat3x3f(t, cross(n, t), n);
}

// Uniform within the cone of half-angle whose cosine is cosMax about `axis`.
fn coneDir(axis: vec3f, cosMax: f32, u1: f32, u2: f32) -> vec3f {
  let c = 1.0 - u1 * (1.0 - cosMax);
  let s = sqrt(max(0.0, 1.0 - c * c));
  let phi = 6.2831853 * u2;
  return normalize(basis(axis) * vec3f(s * cos(phi), s * sin(phi), c));
}

fn cosineDir(n: vec3f, u1: f32, u2: f32) -> vec3f {
  let r = sqrt(u1);
  let phi = 6.2831853 * u2;
  return normalize(basis(n) * vec3f(r * cos(phi), r * sin(phi), sqrt(max(0.0, 1.0 - u1))));
}

// A light's contribution to a face, as if nothing were in the way (distances in metres).
fn unshadowed(l: Light, p: vec3f, n: vec3f) -> vec3f {
  let d = l.pos - p;
  let dist = length(d);
  if (dist >= l.radius || dist < 1e-3) {
    return vec3f(0.0);
  }
  let ndl = max(dot(n, d / dist), 0.0);
  let x = dist / l.radius;
  let win = clamp(1.0 - x * x * x * x, 0.0, 1.0);
  let m = dist * frame.voxel;
  return l.colour * (l.intensity * ndl * win * win / (m * m + 1.0));
}

// Pick one light by its unshadowed contribution; its weighted contribution
// and the direction and length of its shadow ray, or zero if none reaches.
struct Pick {
  light: vec3f,
  dir: vec3f,
  len: f32,
}

// One pass over the lights, as a weighted reservoir: light i replaces the pick
// with probability w_i over the weight seen so far, which leaves each light
// picked in proportion to its weight. The one random number is rescaled at
// each step to serve the next, so no light is weighed twice.
fn pickLight(p: vec3f, n: vec3f, u0: f32) -> Pick {
  var out = Pick(vec3f(0.0), vec3f(0.0, 1.0, 0.0), 0.0);
  let count = min(frame.lightCount, 64u);
  var total = 0.0;
  var picked = -1;
  var u = u0;
  for (var i = 0u; i < count; i++) {
    let w = luminance(unshadowed(lights[i], p, n));
    if (w <= 0.0) {
      continue;
    }
    total += w;
    let keep = w / total;
    if (u < keep) {
      picked = i32(i);
      u = u / keep;
    } else {
      u = (u - keep) / (1.0 - keep);
    }
  }
  if (picked < 0) {
    return out;
  }
  let l = lights[picked];
  let c = unshadowed(l, p, n);
  let d = l.pos - p;
  let dist = length(d);
  out.light = c * (total / luminance(c));
  out.dir = d / dist;
  out.len = dist - 1.0;
  return out;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= frame.lightRes.x || g.y >= frame.lightRes.y) {
    return;
  }
  let p = representative(g.xy);
  let depth = textureLoad(gDepth, vec2i(p), 0).r;
  let hit = textureLoad(gHit, vec2i(p), 0).xy;
  textureStore(hDepth, g.xy, vec4f(depth, 0.0, 0.0, 0.0));
  textureStore(hHit, g.xy, vec4u(hit, 0u, 0u));
  let face = (hit.x >> 24u) & 7u;
  if (face >= 6u) {
    textureStore(lNoisy, g.xy, vec4f(0.0));
    return;
  }
  let rd = cameraRay(frame.cam, vec2f(p) + 0.5 + frameJitter(), vec2f(frame.res));
  let n = faceNormal(face);
  let at = frame.cam.origin + rd * depth + n * 0.02;

  // The three rays this pixel traces: the key light's, the sky's and the picked light's.
  let wantKey = dot(n, frame.keyDir) > 0.0 && luminance(frame.keyColour) > 0.0;
  let keyDir = coneDir(frame.keyDir, cos(frame.keyCone), noise(g.xy, 0u), noise(g.xy, 1u));
  let skyDir = cosineDir(n, noise(g.xy, 2u), noise(g.xy, 3u));
  let pick = pickLight(at, n, noise(g.xy, 4u));
  // One call site for all three: inlined three times, the traversal crowds the
  // GPU's registers and fewer pixels run at once. The count comes from the
  // frame so the compiler cannot unroll the loop back into three.
  var open = vec3f(0.0);
  for (var k = 0u; k < frame.lightRays; k++) {
    var d = skyDir;
    var len = frame.skyRay;
    var want = true;
    if (k == 0u) {
      d = keyDir;
      len = 1e7;
      want = wantKey && dot(keyDir, n) > 0.0;
    } else if (k == 2u) {
      d = pick.dir;
      len = pick.len;
      want = pick.len > 0.0;
    }
    if (want && !traceWorld(at, d, 0.0, len, false).hit) {
      open[k] = 1.0;
    }
  }
  let rgb = skyIrradiance(n) * (0.1 + 0.9 * open.y) + pick.light * open.z;
  textureStore(lNoisy, g.xy, vec4f(rgb, open.x));
}
