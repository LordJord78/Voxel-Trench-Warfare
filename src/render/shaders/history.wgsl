// The last frame's lighting pixels, for the passes that carry something from frame to frame (the
// denoiser's history, ReSTIR's reservoirs): where a surface point was in the last frame's lighting
// grid, and whether a lighting pixel there saw the same spot. A module that includes this declares
// hitBefore and depthBefore, the last frame's lighting pixels' hits and depths.

// A lighting pixel's width at `depth`, and a little more: last frame traced a different pixel of
// the block, so the same spot can be that far off.
fn spotReach(depth: f32) -> f32 {
  return max(1.5, 2.5 * footprint(depth));
}

// Where lighting pixel q's surface point `at` was last frame, in the last frame's lighting grid
// (which dynamic resolution may have sized differently), pixel centres at whole numbers: moved by
// the point's motion, not by its representative's place in the block, which changes every frame
// and would smear a history sideways even with the camera still.
fn lastGrid(q: vec2u, at: vec3f) -> vec2f {
  let res = vec2f(frame.res);
  let motion = project(frame.prev, at, res) - project(frame.cam, at, res);
  let scale = f32(frame.lightScale);
  return ((vec2f(q) + 0.5) * scale + motion) * (vec2f(frame.prevRes) / res) / scale - 0.5;
}

// The last frame's lighting grid's size.
fn lastGridSize() -> vec2i {
  return vec2i((frame.prevRes + frame.lightScale - 1u) / frame.lightScale);
}

// Whether last frame's lighting pixel t saw this pixel's surface point: the
// same face of the same plane, and its own traced point within `reach`. Where a
// lighting pixel spans more than a voxel (far off), each frame's representative
// lands on a different voxel's face of rough ground, and an exact face and plane
// would start every history afresh: there, planes within its span count as the
// same, and where it spans DETAIL_SPAN voxels or more, so do the other faces.
fn sameSpot(t: vec2i, face: u32, plane: i32, at: vec3f, reach: f32) -> bool {
  let h = textureLoad(hitBefore, t, 0).xy;
  let span = reach / 2.5;
  if (hitFace(h) == face) {
    if (f32(abs(hitPlane(h) - plane)) > max(0.5, span)) {
      return false;
    }
  } else if (span < DETAIL_SPAN) {
    return false;
  }
  let o = select(BAYER4[(frame.frame - 1u) & 15u], BAYER2[(frame.frame - 1u) & 3u], frame.lightScale == 2u);
  let p = min(vec2u(t) * frame.lightScale + o, frame.prevRes - 1u);
  // The previous camera carries the jitter its frame applied (zero if it had none).
  let rd = cameraRay(frame.prev, vec2f(p) + 0.5 + frame.prev.jitter, vec2f(frame.prevRes));
  let there = frame.prev.origin + rd * textureLoad(depthBefore, t, 0).r;
  return distance(there, at) <= reach;
}
