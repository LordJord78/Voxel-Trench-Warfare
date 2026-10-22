// Temporal accumulation: this frame's noisy lighting blended into the
// history reprojected from the last frame. A lighting pixel moves by its
// surface point's motion between frames; the four lighting pixels around
// where it was are kept only where they saw the same face of the same plane
// at (within a pixel's width) the same point, so a surface the camera has
// just uncovered starts its history afresh instead of borrowing a neighbour's. History
// is capped at `history_max` frames (an average over at most that many), and
// carries the first two moments of the sky and point light's brightness, from
// which the à-trous filter knows how noisy each pixel still is. (The key
// light's visibility is 0 or 1 per frame, so its noise follows from its mean.)
//
// The sky's ray is traced every other frame (see lighting.wgsl), so the sky's
// visibility keeps a history of its own, an average over the samples it has
// had; a frame without one uses that average, and a pixel with neither (just
// uncovered, on its band's off frame) borrows its traced neighbours'. The
// colour the filter receives is the same as ever: the point light plus the
// sky's light at that visibility.
#include "traverse.wgsl"
#include "camera.wgsl"
#include "sky.wgsl"
#include "lightgrid.wgsl"

@group(1) @binding(0) var noisy: texture_2d<f32>;
@group(1) @binding(1) var depthNow: texture_2d<f32>;
@group(1) @binding(2) var hitNow: texture_2d<u32>;
@group(1) @binding(3) var hitBefore: texture_2d<u32>;
@group(1) @binding(4) var colourBefore: texture_2d<f32>;
@group(1) @binding(5) var momentsBefore: texture_2d<f32>;
@group(1) @binding(6) var colourOut: texture_storage_2d<rgba16float, write>;
@group(1) @binding(7) var momentsOut: texture_storage_2d<rgba16float, write>;
// The sky and point light's variance, and the history length, for the filter.
@group(1) @binding(8) var varianceOut: texture_storage_2d<rg32float, write>;
@group(1) @binding(9) var depthBefore: texture_2d<f32>;
// This frame's sky sample per lighting pixel: its visibility, or -1 where it was not traced.
@group(1) @binding(10) var skyNoisy: texture_2d<f32>;

// Whether last frame's lighting pixel t saw this pixel's surface point: the
// same face of the same plane, and its own traced point within `reach`.
fn sameSpot(t: vec2i, face: u32, plane: i32, at: vec3f, reach: f32) -> bool {
  let h = textureLoad(hitBefore, t, 0).xy;
  if (hitFace(h) != face || hitPlane(h) != plane) {
    return false;
  }
  let o = select(BAYER4[(frame.frame - 1u) & 15u], BAYER2[(frame.frame - 1u) & 3u], frame.lightScale == 2u);
  let p = min(vec2u(t) * frame.lightScale + o, frame.prevRes - 1u);
  // The previous camera carries the jitter its frame applied (zero if it had none).
  let rd = cameraRay(frame.prev, vec2f(p) + 0.5 + frame.prev.jitter, vec2f(frame.prevRes));
  let there = frame.prev.origin + rd * textureLoad(depthBefore, t, 0).r;
  return distance(there, at) <= reach;
}

// What this pixel's coplanar neighbours traced this frame, in its column and the next either
// side, four rows up and down (so a band that did not trace the sky reaches the two beside it):
// their mean sky visibility, and the spread of their brightness, which a pixel with too little
// history is assumed to have.
struct Neighbours {
  sky: f32,
  variance: f32,
  count: f32,
}

fn neighbours(q: vec2i, face: u32, plane: i32, n: vec3f) -> Neighbours {
  var sky = 0.0;
  var sum = 0.0;
  var sq = 0.0;
  var count = 0.0;
  let size = vec2i(frame.lightRes);
  let light = skyIrradiance(n);
  for (var dy = -4; dy <= 4; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let t = q + vec2i(dx, dy);
      if (any(t < vec2i(0)) || any(t >= size)) {
        continue;
      }
      let h = textureLoad(hitNow, t, 0).xy;
      if (hitFace(h) != face || hitPlane(h) != plane) {
        continue;
      }
      let v = textureLoad(skyNoisy, t, 0).r;
      if (v < 0.0) {
        continue;
      }
      let l = luminance(textureLoad(noisy, t, 0).rgb + light * (0.1 + 0.9 * v));
      sky += v;
      sum += l;
      sq += l * l;
      count += 1.0;
    }
  }
  if (count == 0.0) {
    return Neighbours(1.0, 0.0, 0.0);
  }
  let mean = sum / count;
  return Neighbours(sky / count, max(sq / count - mean * mean, 0.0), count);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= frame.lightRes.x || g.y >= frame.lightRes.y) {
    return;
  }
  let q = vec2i(g.xy);
  let current = textureLoad(noisy, q, 0);
  let hit = textureLoad(hitNow, q, 0).xy;
  let face = hitFace(hit);
  if (face >= 6u) {
    textureStore(colourOut, q, vec4f(0.0));
    textureStore(momentsOut, q, vec4f(0.0));
    textureStore(varianceOut, q, vec4f(0.0));
    return;
  }
  let plane = hitPlane(hit);
  let res = vec2f(frame.res);
  let p = representative(g.xy);
  let rd = cameraRay(frame.cam, vec2f(p) + 0.5 + frameJitter(), res);
  let depth = textureLoad(depthNow, q, 0).r;
  let at = frame.cam.origin + rd * depth;
  // A lighting pixel's width at this depth, and a little more: last frame traced a
  // different pixel of the block, so the same spot can be that far off.
  let reach = max(1.5, 2.5 * depth * frame.cam.tanHalf * 2.0 / res.x * f32(frame.lightScale));

  var before = vec4f(0.0);
  var moments = vec4f(0.0);
  if ((frame.flags & FLAG_HISTORY_RESET) == 0u) {
    // Where this lighting pixel was last frame: moved by the surface point's motion, not by
    // its representative's place in the block, which changes every frame and would smear
    // the history sideways even with the camera still.
    // In the last frame's lighting grid, which dynamic resolution may have sized differently.
    let motion = project(frame.prev, at, res) - project(frame.cam, at, res);
    let scale = f32(frame.lightScale);
    let grid = ((vec2f(q) + 0.5) * scale + motion) * (vec2f(frame.prevRes) / res) / scale - 0.5;
    let base = vec2i(floor(grid));
    let f = grid - floor(grid);
    var total = 0.0;
    let size = vec2i((frame.prevRes + frame.lightScale - 1u) / frame.lightScale);
    for (var k = 0; k < 4; k++) {
      let o = vec2i(k & 1, k >> 1);
      let t = base + o;
      if (any(t < vec2i(0)) || any(t >= size)) {
        continue;
      }
      if (!sameSpot(t, face, plane, at, reach)) {
        continue;
      }
      let w = select(1.0 - f.x, f.x, o.x == 1) * select(1.0 - f.y, f.y, o.y == 1);
      if (w <= 0.0) {
        continue;
      }
      before += w * textureLoad(colourBefore, t, 0);
      moments += w * textureLoad(momentsBefore, t, 0);
      total += w;
    }
    // At a silhouette all four can miss; look one pixel further before starting over.
    if (total <= 1e-4) {
      let centre = vec2i(round(grid));
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          let t = centre + vec2i(dx, dy);
          if (any(t < vec2i(0)) || any(t >= size)) {
            continue;
          }
          if (!sameSpot(t, face, plane, at, reach)) {
            continue;
          }
          before += textureLoad(colourBefore, t, 0);
          moments += textureLoad(momentsBefore, t, 0);
          total += 1.0;
        }
      }
    }
    if (total > 1e-4) {
      before /= total;
      moments /= total;
    } else {
      moments = vec4f(0.0);
    }
  }
  let length = min(moments.z + 1.0, frame.historyMax);
  let a = 1.0 / length;
  // The sky's samples: every other frame of the history's, so half of them, rounded up.
  let samples = ceil(length * 0.5);
  let n = faceNormal(face);
  let sample = textureLoad(skyNoisy, q, 0).r;
  let traced = sample >= 0.0;
  var near = Neighbours(1.0, 0.0, 0.0);
  let fresh = moments.z == 0.0;
  if (samples < 4.0 || (fresh && !traced)) {
    near = neighbours(q, face, plane, n);
  }
  var sky = moments.w;
  if (traced) {
    sky = mix(moments.w, sample, 1.0 / samples);
  } else if (fresh) {
    sky = near.sky;
  }
  let full = vec4f(current.rgb + skyIrradiance(n) * (0.1 + 0.9 * select(sky, sample, traced)), current.a);
  let colour = mix(before, full, a);
  // The brightness's moments follow whole samples, sky and point light together: frames that traced the sky.
  var m1 = moments.x;
  var m2 = moments.y;
  if (traced) {
    let l = luminance(full.rgb);
    m1 = mix(moments.x, l, 1.0 / samples);
    m2 = mix(moments.y, l * l, 1.0 / samples);
  }
  var variance = max(m2 - m1 * m1, 0.0);
  if (samples < 4.0) {
    variance = near.variance;
  }
  textureStore(colourOut, q, colour);
  textureStore(momentsOut, q, vec4f(m1, m2, length, sky));
  textureStore(varianceOut, q, vec4f(variance, length, 0.0, 0.0));
}
