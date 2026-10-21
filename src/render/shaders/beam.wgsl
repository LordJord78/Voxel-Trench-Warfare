// The beam pre-pass: for each 8 × 8 tile of the internal image, how far the
// tile's frustum reaches before it could meet anything, as forward depth (each
// pixel divides by its own ray's forward component to get its start). The
// frustum is the tile's corners pushed out a pixel, so jitter cannot carry a
// ray outside it. The march proves space empty only with the max-height
// pyramid: a step is skipped when the frustum's lowest point across it is
// above the highest column under it. Outside the voxel volume there is
// nothing to meet (the far field is marched separately, from the volume's
// exit). A camera below the column tops around it gets 0, at once.
#include "traverse.wgsl"

@group(1) @binding(0) var beamOut: texture_storage_2d<r32float, write>;

const BEAM_STEPS: u32 = 64u;

// 1 + the highest voxel y among brick columns b0 to b1 (inclusive): from the
// pyramid level whose cells are big enough that the range spans at most two
// of them a side, or all the top level's cells it touches.
fn highest(b0: vec2i, b1: vec2i) -> f32 {
  let top = min(frame.world.levels, 7u) - 1u;
  var k = 0u;
  while (k < top && any(((b1 >> vec2u(k)) - (b0 >> vec2u(k))) > vec2i(1))) {
    k++;
  }
  var h = 0.0;
  for (var cz = b0.y >> k; cz <= b1.y >> k; cz++) {
    for (var cx = b0.x >> k; cx <= b1.x >> k; cx++) {
      h = max(h, pyramidAt(k, cx << k, cz << k));
    }
  }
  return h;
}

// The camera ray through continuous pixel coordinates `px`, scaled to unit forward depth.
fn cornerRay(px: vec2f, res: vec2f) -> vec3f {
  let c = frame.cam;
  let x = (2.0 * px.x / res.x - 1.0) * c.tanHalf;
  let y = (1.0 - 2.0 * px.y / res.y) * c.tanHalf / (res.x / res.y);
  return c.forward + c.right * x + c.up * y;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) g: vec3u) {
  let tiles = (frame.res + 7u) / 8u;
  if (g.x >= tiles.x || g.y >= tiles.y) {
    return;
  }
  if ((frame.flags & FLAG_BEAM_OFF) != 0u || frame.world.levels == 0u) {
    textureStore(beamOut, g.xy, vec4f(0.0));
    return;
  }
  let res = vec2f(frame.res);
  let lo = vec2f(g.xy * 8u) - 1.0;
  let hi = vec2f(min(g.xy * 8u + 8u, frame.res)) + 1.0;
  let dirs = array(cornerRay(lo, res), cornerRay(vec2f(hi.x, lo.y), res), cornerRay(vec2f(lo.x, hi.y), res), cornerRay(hi, res));
  let o = frame.cam.origin;
  let dims = vec3f(worldDims());
  let lastBrick = vec2i(worldDims().xz >> vec2u(3u)) - 1;
  var d = 0.0;
  var step = 8.0;
  for (var i = 0u; i < BEAM_STEPS; i++) {
    let d1 = d + step;
    var bmin = vec3f(1e30);
    var bmax = vec3f(-1e30);
    for (var c = 0; c < 4; c++) {
      let a = o + dirs[c] * d;
      let b = o + dirs[c] * d1;
      bmin = min(bmin, min(a, b));
      bmax = max(bmax, max(a, b));
    }
    if (all(bmax > vec3f(0.0)) && all(bmin < dims)) {
      let b0 = clamp(vec2i(floor((bmin.xz - 0.01) / 8.0)), vec2i(0), lastBrick);
      let b1 = clamp(vec2i(floor((bmax.xz + 0.01) / 8.0)), vec2i(0), lastBrick);
      if (bmin.y < highest(b0, b1)) {
        break;
      }
    }
    d = d1;
    step = min(step * 2.0, 128.0);
  }
  // A voxel short, so the start is plainly in the empty space the march proved.
  textureStore(beamOut, g.xy, vec4f(max(d - 1.0, 0.0), 0.0, 0.0, 0.0));
}
