// The other players (soldiers.ts): each a set of rigid voxel parts (combat/soldier-model.ts), posed
// in the world (combat/soldier-rig.ts), drawn after shade as the rifle is (rifle.wgsl) and lit the
// same way: the key through its height map, the sky by a probe's openness, the eye cell's lights by
// the probe's view of them, the blasts, the flash. Unlike the rifle a soldier may stand far off, so
// it is seen through the haze as the world is (haze.wgsl).
//
// One dispatch a soldier, over its box on screen, nearest last: `clear` zeroes their depth over the
// boxes, `main` traces each pixel's ray through the soldier's parts and, where the nearest part is
// nearer than the world, shades it and writes its colour, motion and depth (soldiers-merge.wgsl
// puts the depth into the G-buffer's). A soldier drawn later is nearer, so drawing over an earlier
// one is right but where they cross.
#include "traverse.wgsl"
#include "camera.wgsl"
#include "sky.wgsl"
#include "palette.wgsl"
#include "light-cells.wgsl"
#include "key-shadow.wgsl"
#include "flash.wgsl"
#include "haze.wgsl"

@group(3) @binding(2) var<uniform> soldiers: Soldiers;
@group(3) @binding(3) var<uniform> draw: SoldierDraw;
// Every part's palette ids, four to a word, x fastest; each part from its own byte offset.
@group(3) @binding(4) var<storage, read> model: array<u32>;
// A seat's probe: the sky's openness at PROBE_HEIGHTS up the body, the cell's lights' visibility,
// the blasts'.
@group(3) @binding(5) var<storage, read_write> probed: array<f32>;
@group(3) @binding(6) var gDepth: texture_2d<f32>;
@group(3) @binding(7) var gMotion: texture_storage_2d<rgba16float, write>;
@group(3) @binding(8) var outColour: texture_storage_2d<rgba16float, write>;
@group(3) @binding(9) var soldierDepth: texture_storage_2d<r32float, write>;

const PROBE_HEIGHTS: u32 = 4u;
const PROBE_FLOATS: u32 = 40u;
const PROBE_RAYS: u32 = 4u;
const PROBE_BLEND: f32 = 0.25;
const PROBE_FITTING: f32 = 1.5;
// The tape's voxel (soldier-model.ts TAPE), changed to the soldier's team's.
const TAPE_VOXEL: u32 = 63u;

fn soldierHash(a: u32, b: u32) -> f32 {
  var h = a * 747796405u + b * 2891336453u + 2654435769u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  h = (h >> 22u) ^ h;
  return f32(h >> 8u) * (1.0 / 16777216.0);
}

// The k-th probe point up a soldier's body, world voxels: at its chest, a quarter, half, ... up.
fn probePoint(s: u32, k: u32) -> vec3f {
  let feet = soldiers.info[s].feet.xyz;
  return (feet + vec3f(0.0, 0.25 + 0.45 * f32(k), 0.0)) / frame.voxel;
}

@compute @workgroup_size(64)
fn probe(@builtin(local_invocation_index) i: u32, @builtin(workgroup_id) wg: vec3u) {
  let s = wg.x;
  if (s >= soldiers.count) {
    return;
  }
  let base = soldiers.info[s].slot * PROBE_FLOATS;
  let chest = probePoint(s, 2u);
  if (i < PROBE_HEIGHTS) {
    let at = probePoint(s, i);
    var open = 0.0;
    for (var r = 0u; r < PROBE_RAYS; r++) {
      let u1 = soldierHash(i * PROBE_RAYS + r + s * 131u, frame.frame);
      let u2 = soldierHash(i * PROBE_RAYS + r + 97u + s * 131u, frame.frame);
      let rr = sqrt(u1);
      let phi = 6.2831853 * u2;
      let d = normalize(vec3f(rr * cos(phi), sqrt(max(0.0, 1.0 - u1)), rr * sin(phi)));
      if (!traceWorld(at, d, 0.0, frame.skyRay, false).hit) {
        open += 1.0;
      }
    }
    probed[base + i] = mix(probed[base + i], open / f32(PROBE_RAYS), PROBE_BLEND);
  } else if (i < PROBE_HEIGHTS + CELL_LIGHTS) {
    let k = i - PROBE_HEIGHTS;
    let cell = cellOf(chest);
    var seen = 0.0;
    if (cell >= 0 && k < cellCount(cell)) {
      let l = lights[cellLight(cell, k)];
      let d = l.pos - chest;
      let dist = length(d);
      if (dist < l.radius && dist > PROBE_FITTING && !traceWorld(chest, d / dist, 0.0, dist - PROBE_FITTING, false).hit) {
        seen = 1.0;
      }
    }
    probed[base + i] = mix(probed[base + i], seen, PROBE_BLEND);
  } else if (i < PROBE_HEIGHTS + CELL_LIGHTS + 4u) {
    let k = i - PROBE_HEIGHTS - CELL_LIGHTS;
    var seen = 0.0;
    if (k < frame.blastCount) {
      let b = frame.blasts[k];
      let d = b.pos - chest;
      let dist = length(d);
      if (dist < b.radius && (dist <= PROBE_FITTING || !traceWorld(chest, d / dist, 0.0, dist - PROBE_FITTING, false).hit)) {
        seen = 1.0;
      }
    }
    probed[base + i] = seen;
  }
}

struct PartHit {
  // Metres along the ray; palette 0 for a miss.
  t: f32,
  normal: vec3f,
  palette: u32,
  // Where it struck, in the part's metres.
  at: vec3f,
}

fn partVoxel(p: SoldierPart, c: vec3i) -> u32 {
  let i = p.offset + u32(c.x) + p.dims.x * (u32(c.y) + p.dims.y * u32(c.z));
  return (model[i >> 2u] >> ((i & 3u) * 8u)) & 0xffu;
}

// The first voxel of part `p` a ray from `om` along unit `d` (the part's metres) enters before
// `tMax` metres: rifle.wgsl's traceModel, for any part.
fn tracePart(p: SoldierPart, om: vec3f, d: vec3f, tMax: f32) -> PartHit {
  let miss = PartHit(0.0, vec3f(0.0), 0u, vec3f(0.0));
  let dims = vec3i(p.dims);
  let o = om / p.voxelM + p.origin;
  let safe = select(d, vec3f(1e-12), abs(d) < vec3f(1e-12));
  let inv = 1.0 / safe;
  let ta = -o * inv;
  let tb = (vec3f(dims) - o) * inv;
  let lo = min(ta, tb);
  let hi = max(ta, tb);
  let enter = max(max(lo.x, lo.y), lo.z);
  let exit = min(min(min(hi.x, hi.y), hi.z), tMax / p.voxelM);
  var t = max(enter, 0.0);
  if (t >= exit) {
    return miss;
  }
  var cell = clamp(vec3i(floor(o + d * t)), vec3i(0), dims - 1);
  var face = -1;
  if (enter > 0.0) {
    face = select(select(2, 1, lo.y == enter), 0, lo.x == enter);
    cell[face] = select(dims[face] - 1, 0, d[face] > 0.0);
  }
  let up = d > vec3f(0.0);
  let stepv = select(vec3i(-1), vec3i(1), up);
  var next = (vec3f(cell) + select(vec3f(0.0), vec3f(1.0), up) - o) * inv;
  let delta = abs(inv);
  for (var n = 0u; n < 128u; n++) {
    let v = partVoxel(p, cell);
    if (v != 0u) {
      var axis = face;
      if (axis < 0) {
        let a = abs(d);
        axis = select(select(2, 1, a.y >= a.z), 0, a.x >= a.y && a.x >= a.z);
      }
      var normal = vec3f(0.0);
      normal[axis] = select(1.0, -1.0, d[axis] > 0.0);
      return PartHit(t * p.voxelM, normal, v, om + d * (t * p.voxelM));
    }
    var axis = 0;
    if (next.y < next[axis]) {
      axis = 1;
    }
    if (next.z < next[axis]) {
      axis = 2;
    }
    if (next[axis] >= exit) {
      return miss;
    }
    t = next[axis];
    cell[axis] += stepv[axis];
    if (cell[axis] < 0 || cell[axis] >= dims[axis]) {
      return miss;
    }
    next[axis] += delta[axis];
    face = axis;
  }
  return miss;
}

fn inBox(g: vec3u) -> bool {
  return g.x < draw.box.z && g.y < draw.box.w && draw.box.x + g.x < frame.res.x && draw.box.y + g.y < frame.res.y;
}

@compute @workgroup_size(8, 8)
fn clear(@builtin(global_invocation_id) g: vec3u) {
  if (inBox(g)) {
    textureStore(soldierDepth, vec2i(draw.box.xy + g.xy), vec4f(0.0));
  }
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (!inBox(g)) {
    return;
  }
  let px = draw.box.xy + g.xy;
  let s = draw.soldier;
  let rd = cameraRay(frame.cam, vec2f(px) + 0.5 + frameJitter(), vec2f(frame.res));
  let eye = frame.cam.origin * frame.voxel;
  let world = textureLoad(gDepth, vec2i(px), 0).r * frame.voxel;
  var best = PartHit(world, vec3f(0.0), 0u, vec3f(0.0));
  var bestPart = 0u;
  for (var k = 0u; k < SOLDIER_PARTS; k++) {
    let pose = soldiers.poses[s * SOLDIER_PARTS + k];
    // Into the part's space: its axes are square and unit, so their transpose undoes them.
    let o = eye - pose.t;
    let hit = tracePart(soldiers.parts[k], vec3f(dot(o, pose.x), dot(o, pose.y), dot(o, pose.z)), vec3f(dot(rd, pose.x), dot(rd, pose.y), dot(rd, pose.z)), best.t);
    if (hit.palette != 0u && hit.t < best.t) {
      best = hit;
      bestPart = k;
    }
  }
  if (best.palette == 0u) {
    return;
  }
  let pose = soldiers.poses[s * SOLDIER_PARTS + bestPart];
  let info = soldiers.info[s];
  let p = eye + rd * best.t;
  let pv = p / frame.voxel;
  let n = pose.x * best.normal.x + pose.y * best.normal.y + pose.z * best.normal.z;
  let palette = select(best.palette, info.tape, best.palette == TAPE_VOXEL);

  // The sky's openness at this height up the body, between the probe's points.
  let base = info.slot * PROBE_FLOATS;
  let along = clamp((p.y - info.feet.y - 0.25) / 0.45, 0.0, f32(PROBE_HEIGHTS) - 1.0);
  let k0 = u32(floor(along));
  let sky = mix(probed[base + k0], probed[base + min(k0 + 1u, PROBE_HEIGHTS - 1u)], fract(along));
  let keyVisible = keyLit(pv);
  var lit = frame.keyColour * keyVisible * max(dot(n, frame.keyDir), 0.0) + skyIrradiance(n) * (0.1 + 0.9 * sky) + flashLight(pv, n);
  let cell = cellOf(probePoint(s, 2u));
  if (cell >= 0) {
    for (var k = 0u; k < cellCount(cell); k++) {
      lit += unshadowed(lights[cellLight(cell, k)], pv, n) * probed[base + PROBE_HEIGHTS + k];
    }
  }
  for (var k = 0u; k < min(frame.blastCount, 4u); k++) {
    let b = frame.blasts[k];
    lit += unshadowed(Light(b.pos, b.radius, b.colour, b.intensity), pv, n) * probed[base + PROBE_HEIGHTS + CELL_LIGHTS + k];
  }
  // The helmet's steel catches a little of the key, toward the eye.
  let toward = normalize(frame.keyDir - rd);
  let shine = frame.keyColour * keyVisible * 0.3 * (1.0 - roughnessOf(palette)) * pow(max(dot(n, toward), 0.0), 32.0) * select(0.0, 1.0, dot(n, frame.keyDir) > 0.0);
  var colour = albedoOf(palette) * lit + shine + emissionOf(palette);

  // Seen through the haze, as the world behind it is.
  var haze: vec4f;
  let eyeY = frame.cam.origin.y * frame.voxel;
  if ((frame.flags & FLAG_FROXELS_OFF) != 0u) {
    let f = fog(eyeY, rd, best.t);
    haze = vec4f(f.rgb * (1.0 - f.a), f.a);
  } else {
    haze = hazeTo((vec2f(px) + 0.5 + frameJitter()) / vec2f(frame.res), eyeY, rd, best.t);
  }
  colour = colour * haze.a + haze.rgb;

  let was = pose.pt + pose.px * best.at.x + pose.py * best.at.y + pose.pz * best.at.z;
  let motion = project(frame.prev, was / frame.voxel, vec2f(frame.res)) - project(frame.cam, pv, vec2f(frame.res));
  textureStore(soldierDepth, vec2i(px), vec4f(best.t / frame.voxel, 0.0, 0.0, 0.0));
  textureStore(gMotion, vec2i(px), vec4f(motion, 0.0, 0.0));
  textureStore(outColour, vec2i(px), vec4f(colour, 1.0));
}
