// The shells' and the fires' smoke in the haze (froxels.wgsl): the frame's puffs, nearest the eye
// first. A puff's density falls from its middle to nothing at its edge, as 1 - (r/R)^2, so along a
// chord passing p from its middle, from s0 to s1 along it, its depth is the integral of
// 1 - (p^2 + s^2)/R^2: closed form, with 1 - p^2/R^2 = h^2/R^2 for the half chord h. A froxel
// column finds the puffs its ray passes through once (gatherSmoke), then reads its depth to each
// slice from those alone (smokeTo), rather than testing every puff at every slice.
#include "scene.wgsl"

// The most puffs a frame holds (frame-uniforms.ts's MAX_PUFFS).
const FRAME_PUFFS: u32 = 64u;
// The most a column's ray takes: the first it passes through as the frame lists them, the nearest.
const COLUMN_PUFFS: u32 = 16u;

struct ColumnSmoke {
  count: u32,
  // How far along the ray (voxels) the first chord begins and the last ends, and the depth of all
  // of them: a slice short of the first has none, one past the last all of it.
  near: f32,
  far: f32,
  total: f32,
  // Each puff the ray passes through: how far along it (voxels) it passes nearest the puff's
  // middle, its half chord there, and its depth's two terms by the voxel: density × h²/R², and
  // density / 3R².
  chords: array<vec4f, COLUMN_PUFFS>,
}

// The puffs the eye's ray rd passes through between the eye and `reach` voxels out.
fn gatherSmoke(rd: vec3f, reach: f32) -> ColumnSmoke {
  var smoke: ColumnSmoke;
  smoke.count = 0u;
  smoke.near = reach;
  smoke.far = 0.0;
  smoke.total = 0.0;
  for (var i = 0u; i < min(frame.puffCount, FRAME_PUFFS); i++) {
    if (smoke.count == COLUMN_PUFFS) {
      break;
    }
    let puff = frame.puffs[i];
    let o = frame.cam.origin - puff.centre;
    let along = -dot(rd, o);
    let r2 = puff.radius * puff.radius;
    let h2 = r2 - (dot(o, o) - along * along);
    if (h2 <= 0.0) {
      continue;
    }
    let h = sqrt(h2);
    if (along + h <= 0.0 || along - h >= reach) {
      continue;
    }
    let k = puff.density * frame.voxel / r2;
    let c = vec4f(along, h, k * h2, k / 3.0);
    smoke.chords[smoke.count] = c;
    smoke.count++;
    let s0 = max(-h, -along);
    smoke.near = min(smoke.near, along + s0);
    smoke.far = max(smoke.far, along + h);
    smoke.total += c.z * (h - s0) - c.w * (h * h * h - s0 * s0 * s0);
  }
  return smoke;
}

// The smoke's optical depth along the column's ray to `metres` out.
fn smokeTo(smoke: ptr<function, ColumnSmoke>, metres: f32) -> f32 {
  let end = metres / frame.voxel;
  if (end <= (*smoke).near) {
    return 0.0;
  }
  if (end >= (*smoke).far) {
    return (*smoke).total;
  }
  var depth = 0.0;
  for (var i = 0u; i < (*smoke).count; i++) {
    let c = (*smoke).chords[i];
    let s0 = max(-c.y, -c.x);
    let s1 = min(c.y, end - c.x);
    if (s1 > s0) {
      depth += c.z * (s1 - s0) - c.w * (s1 * s1 * s1 - s0 * s0 * s0);
    }
  }
  return depth;
}
