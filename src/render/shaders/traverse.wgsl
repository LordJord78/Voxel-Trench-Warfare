// One traversal for every ray: a hierarchical DDA through 32³ sectors, 8³
// bricks and voxels. An empty sector is crossed in one step, an empty brick in
// one step, a uniform brick is a hit, and a dense brick is walked voxel by
// voxel through its occupancy mask. Before crossing empty space or entering a
// dense brick, the ray asks the max-height pyramid whether it stays above
// everything in the column cell it is crossing; if so it jumps to that cell's
// exit, which is what makes long, low dusk shadow rays affordable.
//
// Conventions shared with the CPU reference (tests/support/trace-ref.ts):
// positions in voxels, the ray clipped to [0, dims), `t` along `rd`, and
// `face` (0-5: -x, +x, -y, +y, -z, +z) the face of the hit cell the ray came in
// through. Ties between axes go to the lowest.
#include "scene.wgsl"
#include "common.wgsl"

const MAX_STEPS: u32 = 2048u;
const UNIFORM_BIT: u32 = 0x80000000u;
const UNIT_MASK: u32 = 0x0fffffffu;

struct Hit {
  hit: bool,
  t: f32,
  cell: vec3i,
  face: u32,
  mat: u32,
  steps: u32,
}

fn worldDims() -> vec3i {
  return vec3i(frame.world.dims);
}

fn brickEntry(b: vec3i) -> u32 {
  let d = worldDims() >> vec3u(3u);
  return table[u32((b.z * d.y + b.y) * d.x + b.x)];
}

fn sectorOccupied(s: vec3i) -> bool {
  let d = worldDims() >> vec3u(5u);
  return sectors[u32((s.z * d.y + s.y) * d.x + s.x)] != 0u;
}

fn voxelOccupied(entry: u32, li: u32) -> bool {
  let base = (entry & UNIT_MASK) * 4u;
  return ((heap[base + 4u + (li >> 5u)] >> (li & 31u)) & 1u) != 0u;
}

// The palette id of voxel `li` of a dense brick's record (see encode.ts).
fn decodeMaterial(entry: u32, li: u32) -> u32 {
  let format = (entry >> 28u) & 7u;
  let base = (entry & UNIT_MASK) * 4u;
  if (format == 4u) {
    return (heap[base + 20u + (li >> 2u)] >> ((li & 3u) * 8u)) & 0xffu;
  }
  var local = 0u;
  if (format > 0u) {
    let bits = select(select(4u, 2u, format == 2u), 1u, format == 1u);
    let bit = li * bits;
    local = (heap[base + 20u + (bit >> 5u)] >> (bit & 31u)) & ((1u << bits) - 1u);
  }
  return (heap[base + (local >> 2u)] >> ((local & 3u) * 8u)) & 0xffu;
}

fn faceNormal(face: u32) -> vec3f {
  var n = vec3f(0.0);
  n[face >> 1u] = select(-1.0, 1.0, (face & 1u) == 1u);
  return n;
}

// Height of pyramid level k over brick column (bx, bz).
fn pyramidAt(k: u32, bx: i32, bz: i32) -> f32 {
  let l = frame.world.pyramid[k];
  return f32(pyramid[l.z + (u32(bz) >> k) * l.x + (u32(bx) >> k)]);
}

fn traceWorld(ro: vec3f, rd: vec3f, tMax: f32, wantMaterial: bool) -> Hit {
  var h = Hit(false, 0.0, vec3i(0), 0u, 0u, 0u);
  let dims = worldDims();
  let dimsF = vec3f(dims);
  let moving = rd != vec3f(0.0);
  let inv = select(vec3f(0.0), vec3f(1.0) / rd, moving);
  if (any(!moving & ((ro < vec3f(0.0)) | (ro >= dimsF)))) {
    return h;
  }
  let ta = select(vec3f(-1e30), -ro * inv, moving);
  let tb = select(vec3f(1e30), (dimsF - ro) * inv, moving);
  let tlo = min(ta, tb);
  let thi = max(ta, tb);
  let tEntry = max(tlo.x, max(tlo.y, tlo.z));
  let tEnd = min(min(thi.x, min(thi.y, thi.z)), tMax);
  var t = max(tEntry, 0.0);
  if (t >= tEnd) {
    return h;
  }
  let up = rd > vec3f(0.0);
  var cell = clamp(vec3i(floor(ro + rd * t)), vec3i(0), dims - 1);
  var face = 0u;
  if (tEntry > 0.0) {
    var ax = 2;
    if (tlo.x >= tlo.y && tlo.x >= tlo.z) {
      ax = 0;
    } else if (tlo.y >= tlo.z) {
      ax = 1;
    }
    cell[ax] = select(dims[ax] - 1, 0, up[ax]);
    face = u32(ax) * 2u + select(1u, 0u, up[ax]);
  }
  let pyramidOn = (frame.flags & FLAG_PYRAMID_OFF) == 0u && frame.world.levels > 0u;
  let topLevel = min(frame.world.levels, 7u) - 1u;
  var askedBrick = vec3i(-1);
  // The sector and brick the last step was in: a ray walking voxels through a
  // dense brick reads only the mask, not the sector and table again.
  var sector = vec3i(-1);
  var sectorFull = false;
  var brick = vec3i(-1);
  var e = 0u;

  for (var i = 0u; i < MAX_STEPS; i++) {
    h.steps = i + 1u;
    // The empty cell to step out of: a voxel, a brick (8) or a sector (32), as a shift.
    var shift = 0u;
    var ask = false;
    let s = cell >> vec3u(5u);
    if (any(s != sector)) {
      sector = s;
      sectorFull = sectorOccupied(s);
    }
    if (!sectorFull) {
      shift = 5u;
      ask = true;
    } else {
      let b = cell >> vec3u(3u);
      if (any(b != brick)) {
        brick = b;
        e = brickEntry(b);
      }
      if (e == 0u) {
        shift = 3u;
        ask = true;
      } else if ((e & UNIFORM_BIT) != 0u) {
        h.hit = true;
        h.t = t;
        h.cell = cell;
        h.face = face;
        h.mat = e & 0xffu;
        return h;
      } else {
        let li = u32((cell.x & 7) | ((cell.y & 7) << 3u) | ((cell.z & 7) << 6u));
        if (voxelOccupied(e, li)) {
          h.hit = true;
          h.t = t;
          h.cell = cell;
          h.face = face;
          h.mat = select(0u, decodeMaterial(e, li), wantMaterial);
          return h;
        }
        // Ask once per dense brick, on the way in.
        if (any(brick != askedBrick)) {
          askedBrick = brick;
          ask = true;
        }
      }
    }

    if (pyramidOn && ask) {
      // The largest pyramid cell the ray stays above all the way across. If
      // it is below level 0's top here, every coarser level fails too.
      let yNow = ro.y + rd.y * t;
      var found = false;
      var skipT = 0.0;
      var skipAxis = 0;
      var cx = 0;
      var cz = 0;
      var span = 0;
      for (var k = 0u; k <= topLevel; k++) {
        let s = 8 << k;
        let px = (cell.x >> (k + 3u)) << (k + 3u);
        let pz = (cell.z >> (k + 3u)) << (k + 3u);
        let top = pyramidAt(k, cell.x >> 3u, cell.z >> 3u);
        if (yNow < top) {
          break;
        }
        let tx = select(1e30, (f32(select(px, px + s, up.x)) - ro.x) * inv.x, moving.x);
        let tz = select(1e30, (f32(select(pz, pz + s, up.z)) - ro.z) * inv.z, moving.z);
        let out = min(min(tx, tz), tEnd);
        if (ro.y + rd.y * out < top) {
          break;
        }
        found = true;
        skipT = out;
        skipAxis = select(2, 0, tx <= tz);
        cx = px;
        cz = pz;
        span = s;
      }
      if (found) {
        if (skipT >= tEnd) {
          return h;
        }
        t = skipT;
        var nc = vec3i(floor(ro + rd * t));
        nc.x = clamp(nc.x, cx, cx + span - 1);
        nc.z = clamp(nc.z, cz, cz + span - 1);
        nc.y = clamp(nc.y, 0, dims.y - 1);
        if (skipAxis == 0) {
          nc.x = select(cx - 1, cx + span, up.x);
        } else {
          nc.z = select(cz - 1, cz + span, up.z);
        }
        if (nc[skipAxis] < 0 || nc[skipAxis] >= dims[skipAxis]) {
          return h;
        }
        cell = nc;
        face = u32(skipAxis) * 2u + select(1u, 0u, up[skipAxis]);
        continue;
      }
    }

    // Step out of the current empty cell.
    let size = 1 << shift;
    let cmin = (cell >> vec3u(shift)) << vec3u(shift);
    let bound = vec3f(select(cmin, cmin + size, up));
    let te = select(vec3f(1e30), (bound - ro) * inv, moving);
    var ax = 2;
    if (te.x <= te.y && te.x <= te.z) {
      ax = 0;
    } else if (te.y <= te.z) {
      ax = 1;
    }
    let tExit = te[ax];
    if (tExit >= tEnd) {
      return h;
    }
    t = tExit;
    var nc = clamp(vec3i(floor(ro + rd * t)), cmin, cmin + size - 1);
    nc[ax] = select(cmin[ax] - 1, cmin[ax] + size, up[ax]);
    if (nc[ax] < 0 || nc[ax] >= dims[ax]) {
      return h;
    }
    cell = nc;
    face = u32(ax) * 2u + select(1u, 0u, up[ax]);
  }
  return h;
}
