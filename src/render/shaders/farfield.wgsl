// The far field: 2 km of ground past the map's edge, marched through its max
// mips. Heights are samples at cell centres and the ground between four of
// them is their bilinear patch (see farfield-mips.ts). The march climbs to a
// coarse cell while the ray stays above everything in it, and descends where
// it might not; at a single patch it solves the ray against the bilinear
// surface exactly, as a quadratic in the distance from where it entered.
// Positions are voxels; frame.far is (origin x, origin z, cell, cell count).
// Where there is no ground (inside the map) heights and mips hold -1e30.
#include "scene.wgsl"

struct FarHit {
  hit: bool,
  t: f32,
  n: vec3f,
  mat: u32,
}

const FAR_STEPS: u32 = 512u;

fn farSample(i: i32, j: i32) -> f32 {
  let n = i32(frame.far.w);
  return textureLoad(farHeights, vec2i(clamp(i, 0, n - 1), clamp(j, 0, n - 1)), 0).r;
}

// The bilinear patch's normal at local (fu, fv) in patch (i, j).
fn farPatchNormal(i: i32, j: i32, fu: f32, fv: f32) -> vec3f {
  let a = farSample(i, j);
  let b = farSample(i + 1, j);
  let c = farSample(i, j + 1);
  let d = farSample(i + 1, j + 1);
  let k = a - b - c + d;
  let dx = ((b - a) + k * fv) / frame.far.z;
  let dz = ((c - a) + k * fu) / frame.far.z;
  return normalize(vec3f(-dx, 1.0, -dz));
}

// The far field's normal and material under a point on it.
fn farNormalAt(p: vec3f) -> vec3f {
  let s = (p.xz - frame.far.xy) / frame.far.z - 0.5;
  let c = floor(s);
  return farPatchNormal(i32(c.x), i32(c.y), s.x - c.x, s.y - c.y);
}

fn farMaterialAt(p: vec3f) -> u32 {
  let n = i32(frame.far.w);
  let s = vec2i(round((p.xz - frame.far.xy) / frame.far.z - 0.5));
  return textureLoad(farMaterials, clamp(s, vec2i(0), vec2i(n - 1)), 0).r;
}

fn marchFar(ro: vec3f, rd: vec3f, tMin: f32, tMax: f32) -> FarHit {
  var out = FarHit(false, 0.0, vec3f(0.0, 1.0, 0.0), 0u);
  let size = i32(frame.far.w);
  if (size < 2) {
    return out;
  }
  let cell = frame.far.z;
  let top = i32(firstTrailingBit(u32(size)));
  let s0 = (ro.xz - frame.far.xy) / cell - 0.5;
  let ds = rd.xz / cell;
  // Patches cover sample space [0, size - 1) on both axes.
  let moving = ds != vec2f(0.0);
  let inv = select(vec2f(0.0), 1.0 / ds, moving);
  let limit = f32(size - 1);
  if (any(!moving & ((s0 < vec2f(0.0)) | (s0 >= vec2f(limit))))) {
    return out;
  }
  let ta = select(vec2f(-1e30), -s0 * inv, moving);
  let tb = select(vec2f(1e30), (vec2f(limit) - s0) * inv, moving);
  var t = max(tMin, max(min(ta.x, tb.x), min(ta.y, tb.y)));
  let tEnd = min(tMax, min(max(ta.x, tb.x), max(ta.y, tb.y)));
  let nudge = select(vec2f(-2e-3), vec2f(2e-3), ds > vec2f(0.0)) * select(vec2f(0.0), vec2f(1.0), moving);
  var level = min(top, 5);

  for (var it = 0u; it < FAR_STEPS; it++) {
    if (t >= tEnd) {
      break;
    }
    let span = f32(1 << u32(level));
    let p = s0 + ds * t + nudge;
    let c = clamp(floor(p / span), vec2f(0.0), vec2f(f32((size >> u32(level)) - 1)));
    let highest = textureLoad(farMips, vec2i(c), level).r;
    let lo = c * span;
    let bound = select(lo, lo + span, ds > vec2f(0.0));
    let te = select(vec2f(1e30), (bound - s0) * inv, moving);
    let tOut = min(min(te.x, te.y), tEnd);
    let yIn = ro.y + rd.y * t;
    let yOut = ro.y + rd.y * tOut;
    // Empty cells (inside the map) hold -1e30, not -inf: shader compilers may assume no infinities.
    if (highest < -1e29 || min(yIn, yOut) > highest) {
      t = tOut;
      level = min(level + 1, top);
      continue;
    }
    if (level > 0) {
      level -= 1;
      continue;
    }
    // One patch: solve height(t) = ground(t) on [t, tOut], measured from t.
    let i = i32(c.x);
    let j = i32(c.y);
    let a = farSample(i, j);
    let b = farSample(i + 1, j);
    let cc = farSample(i, j + 1);
    let d = farSample(i + 1, j + 1);
    let k = a - b - cc + d;
    let e = s0 + ds * t - vec2f(f32(i), f32(j));
    let yE = ro.y + rd.y * t;
    let qa = -(k * ds.x * ds.y);
    let qb = rd.y - ((b - a) * ds.x + (cc - a) * ds.y + k * (e.x * ds.y + e.y * ds.x));
    let qc = yE - (a + (b - a) * e.x + (cc - a) * e.y + k * e.x * e.y);
    let span0 = tOut - t;
    var tau = -1.0;
    if (qc <= 0.0) {
      tau = 0.0;
    } else if (abs(qa) < 1e-9) {
      if (qb < 0.0) {
        tau = -qc / qb;
      }
    } else {
      let disc = qb * qb - 4.0 * qa * qc;
      if (disc >= 0.0) {
        let r = sqrt(disc);
        let r1 = (-qb - r) / (2.0 * qa);
        let r2 = (-qb + r) / (2.0 * qa);
        let first = min(r1, r2);
        let second = max(r1, r2);
        tau = select(second, first, first >= 0.0);
      }
    }
    if (tau >= 0.0 && tau <= span0) {
      out.hit = true;
      out.t = t + tau;
      let f = e + ds * tau;
      out.n = farPatchNormal(i, j, f.x, f.y);
      out.mat = farMaterialAt(ro + rd * out.t);
      return out;
    }
    t = tOut;
    level = min(level + 1, top);
  }
  return out;
}
