// The exposure that adapts (see auto-exposure.ts). `count` meters the frame: each rendered pixel's
// log2 luminance under the exposure reckoned from the light, in 128 bins over [-12, +4) stops.
// `adapt` takes the mean of the counts between the darkest 50% and the brightest 2%; corrects a
// view metered beyond a zone round the norm by the excess, moving toward it at its rates; and
// presents the frame at the hour's bias × the reckoned exposure × 2^correction.

struct Params {
  // The rendered part of the image.
  res: vec2u,
  // Seconds since the last frame; the hour's bias.
  dt: f32,
  bias: f32,
  // The norm the approved views meter round, and the zone round it left alone, in stops.
  norm: f32,
  zone: f32,
  // Stops a second the correction may rise (a darker scene) and fall (a brighter one).
  rise: f32,
  fall: f32,
  // Nonzero to land on the correction at once (the image started afresh).
  reset: u32,
}

const BINS: u32 = 128u;
const LOW: f32 = -12.0;
const PER_STOP: f32 = 8.0;
const LUMA: vec3f = vec3f(0.2126, 0.7152, 0.0722);

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var frame: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> counts: array<atomic<u32>, 128>;
// The base exposure (written by exposure.wgsl), the correction, its want, the metered mean.
@group(0) @binding(3) var<storage, read_write> state: array<f32, 8>;
// The present pass's uniform: the exposure goes at 6.
@group(0) @binding(4) var<storage, read_write> present: array<f32, 12>;

var<workgroup> local: array<atomic<u32>, 128>;

// A finite number, by its bits: WGSL lets a compiler assume x != x is never true.
fn finite(x: f32) -> bool {
  return (bitcast<u32>(x) & 0x7f800000u) != 0x7f800000u;
}

// A workgroup of 16 × 16 meters a 64 × 64 tile, each thread every 16th pixel of it in each axis.
@compute @workgroup_size(16, 16)
fn count(@builtin(workgroup_id) w: vec3u, @builtin(local_invocation_id) l: vec3u, @builtin(local_invocation_index) i: u32) {
  if (i < BINS) {
    atomicStore(&local[i], 0u);
  }
  workgroupBarrier();
  let base = state[0];
  for (var dy = 0u; dy < 4u; dy++) {
    for (var dx = 0u; dx < 4u; dx++) {
      let p = w.xy * 64u + vec2u(dx, dy) * 16u + l.xy;
      if (all(p < params.res)) {
        let v = dot(textureLoad(frame, vec2i(p), 0).rgb, LUMA) * base;
        if (finite(v) && v > 0.0) {
          let bin = u32(clamp(floor((log2(v) - LOW) * PER_STOP), 0.0, f32(BINS - 1u)));
          atomicAdd(&local[bin], 1u);
        }
      }
    }
  }
  workgroupBarrier();
  if (i < BINS) {
    let n = atomicLoad(&local[i]);
    if (n > 0u) {
      atomicAdd(&counts[i], n);
    }
  }
}

@compute @workgroup_size(1)
fn adapt() {
  var n = 0.0;
  for (var b = 0u; b < BINS; b++) {
    n += f32(atomicLoad(&counts[b]));
  }
  // The mean of the counts between the darkest half and the brightest 2%, each bin at its middle.
  var metered = params.norm;
  if (n > 0.0) {
    let lo = 0.5 * n;
    let hi = 0.98 * n;
    var below = 0.0;
    var sum = 0.0;
    var weight = 0.0;
    for (var b = 0u; b < BINS; b++) {
      let c = f32(atomicLoad(&counts[b]));
      let w = max(0.0, min(below + c, hi) - max(below, lo));
      sum += w * (LOW + (f32(b) + 0.5) / PER_STOP);
      weight += w;
      below += c;
    }
    if (weight > 0.0) {
      metered = sum / weight;
    }
  }
  // Beyond the zone, by the excess.
  let d = params.norm - metered;
  let excess = abs(d) - params.zone;
  let want = select(0.0, sign(d) * excess, excess > 0.0);
  var c = state[1];
  if (params.reset != 0u || !finite(c)) {
    c = want;
  } else {
    c += clamp(want - c, -params.fall * params.dt, params.rise * params.dt);
  }
  state[1] = c;
  state[2] = want;
  state[3] = metered;
  present[6] = params.bias * state[0] * exp2(c);
}
