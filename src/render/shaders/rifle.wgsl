// The rifle (rifle.ts): a voxel model at 1.5 cm in a grid of its own, drawn in its own pass after
// shade and lit by the world's own light (the plan's ruling: in the G-buffer, the lighting and
// denoising passes would need it as a world face of their own, and a kicking close-up would come
// out of their history smeared). `probe`, a workgroup, traces how open the sky is from points
// along the rifle and whether each light of the eye's cell is in view of it, smoothed over frames;
// `main`, over the rifle's box on screen, walks each pixel's ray through the grid and, where the
// rifle is nearer than the world, shades it — the key through its height map (the trench's shadow,
// per pixel), the sky by the probe's openness, the cell's lights by theirs, and its own flash —
// and writes its colour and motion, and its depth for rifle-merge.wgsl to put in the G-buffer's
// (no storage texture both read and written, which not every browser has), so TAA, the effects
// and bloom take it as the world.
#include "traverse.wgsl"
#include "camera.wgsl"
#include "sky.wgsl"
#include "palette.wgsl"
#include "light-cells.wgsl"
#include "key-shadow.wgsl"
#include "flash.wgsl"

@group(3) @binding(0) var<uniform> rifle: Rifle;
// Palette ids, four to a word, x fastest.
@group(3) @binding(1) var<storage, read> model: array<u32>;
// The probe's: the sky's openness at PROBE_POINTS along the rifle, then the cell's lights' visibility.
@group(3) @binding(2) var<storage, read_write> probed: array<f32>;
@group(3) @binding(3) var gDepth: texture_2d<f32>;
@group(3) @binding(4) var gMotion: texture_storage_2d<rgba16float, write>;
@group(3) @binding(5) var outColour: texture_storage_2d<rgba16float, write>;
// The rifle's depth over its whole box: voxels along the ray, or 0 where the world is drawn.
@group(3) @binding(6) var rifleDepth: texture_storage_2d<r32float, write>;

const PROBE_POINTS: u32 = 8u;
const PROBE_RAYS: u32 = 4u;
// How much of each frame's sample the probe keeps.
const PROBE_BLEND: f32 = 0.25;
// From the butt to the muzzle, model metres along the bore.
const PROBE_FROM: f32 = -0.24;
const PROBE_TO: f32 = 0.7;
// Where the rifle's lights are judged from: its middle, model metres along the bore.
const PROBE_MIDDLE: f32 = 0.3;
// Voxels short of a light its shadow ray ends, as lighting.wgsl's LIGHT_FITTING.
const PROBE_FITTING: f32 = 1.5;

// A model point (metres) in the world (metres), now and as the last frame drew it.
fn rifleToWorld(p: vec3f) -> vec3f {
  return rifle.t + rifle.x * p.x + rifle.y * p.y + rifle.z * p.z;
}

fn rifleWasWorld(p: vec3f) -> vec3f {
  return rifle.pt + rifle.px * p.x + rifle.py * p.y + rifle.pz * p.z;
}

// The k-th probe point along the bore, model metres.
fn probePoint(k: u32) -> vec3f {
  return vec3f(0.0, 0.0, mix(PROBE_FROM, PROBE_TO, (f32(k) + 0.5) / f32(PROBE_POINTS)));
}

// A hash to [0, 1): the probe's directions change every frame.
fn rifleHash(a: u32, b: u32) -> f32 {
  var h = a * 747796405u + b * 2891336453u + 2654435769u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  h = (h >> 22u) ^ h;
  return f32(h >> 8u) * (1.0 / 16777216.0);
}

@compute @workgroup_size(64)
fn probe(@builtin(local_invocation_index) i: u32) {
  if (i < PROBE_POINTS) {
    let at = rifleToWorld(probePoint(i)) / frame.voxel;
    var open = 0.0;
    for (var r = 0u; r < PROBE_RAYS; r++) {
      // Cosine-weighted about up: how much of the sky the rifle sees there.
      let u1 = rifleHash(i * PROBE_RAYS + r, frame.frame);
      let u2 = rifleHash(i * PROBE_RAYS + r + 97u, frame.frame);
      let rr = sqrt(u1);
      let phi = 6.2831853 * u2;
      let d = normalize(vec3f(rr * cos(phi), sqrt(max(0.0, 1.0 - u1)), rr * sin(phi)));
      if (!traceWorld(at, d, 0.0, frame.skyRay, false).hit) {
        open += 1.0;
      }
    }
    probed[i] = mix(probed[i], open / f32(PROBE_RAYS), PROBE_BLEND);
  } else if (i < PROBE_POINTS + CELL_LIGHTS) {
    let k = i - PROBE_POINTS;
    let middle = rifleToWorld(vec3f(0.0, 0.0, PROBE_MIDDLE)) / frame.voxel;
    let cell = cellOf(middle);
    var seen = 0.0;
    if (cell >= 0 && k < cellCount(cell)) {
      let l = lights[cellLight(cell, k)];
      let d = l.pos - middle;
      let dist = length(d);
      if (dist < l.radius && dist > PROBE_FITTING && !traceWorld(middle, d / dist, 0.0, dist - PROBE_FITTING, false).hit) {
        seen = 1.0;
      }
    }
    probed[i] = mix(probed[i], seen, PROBE_BLEND);
  }
}

struct ModelHit {
  // Metres along the ray; 0 with palette 0 for a miss.
  t: f32,
  normal: vec3f,
  palette: u32,
}

fn rifleVoxel(c: vec3i) -> u32 {
  let i = u32(c.x) + rifle.dims.x * (u32(c.y) + rifle.dims.y * u32(c.z));
  return (model[i >> 2u] >> ((i & 3u) * 8u)) & 0xffu;
}

// The first voxel a ray from `om` along unit `d` (model metres) enters: combat/rifle-model.ts's
// traceRifle, the same walk.
fn traceModel(om: vec3f, d: vec3f) -> ModelHit {
  let miss = ModelHit(0.0, vec3f(0.0), 0u);
  let dims = vec3i(rifle.dims);
  let o = om / rifle.voxelM + rifle.origin;
  let safe = select(d, vec3f(1e-12), abs(d) < vec3f(1e-12));
  let inv = 1.0 / safe;
  let ta = -o * inv;
  let tb = (vec3f(dims) - o) * inv;
  let lo = min(ta, tb);
  let hi = max(ta, tb);
  let enter = max(max(lo.x, lo.y), lo.z);
  let exit = min(min(hi.x, hi.y), hi.z);
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
  for (var n = 0u; n < 160u; n++) {
    let p = rifleVoxel(cell);
    if (p != 0u) {
      var axis = face;
      if (axis < 0) {
        let a = abs(d);
        axis = select(select(2, 1, a.y >= a.z), 0, a.x >= a.y && a.x >= a.z);
      }
      var normal = vec3f(0.0);
      normal[axis] = select(1.0, -1.0, d[axis] > 0.0);
      return ModelHit(t * rifle.voxelM, normal, p);
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

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) g: vec3u) {
  let px = rifle.box.xy + g.xy;
  if (g.x >= rifle.box.z || g.y >= rifle.box.w || px.x >= frame.res.x || px.y >= frame.res.y) {
    return;
  }
  let rd = cameraRay(frame.cam, vec2f(px) + 0.5 + frameJitter(), vec2f(frame.res));
  let eye = frame.cam.origin * frame.voxel;
  // Into the model's space: its axes are square and unit, so their transpose undoes them.
  let o = eye - rifle.t;
  let hit = traceModel(vec3f(dot(o, rifle.x), dot(o, rifle.y), dot(o, rifle.z)), vec3f(dot(rd, rifle.x), dot(rd, rifle.y), dot(rd, rifle.z)));
  let depth = hit.t / frame.voxel;
  if (hit.palette == 0u || depth >= textureLoad(gDepth, vec2i(px), 0).r) {
    textureStore(rifleDepth, vec2i(px), vec4f(0.0));
    return;
  }
  let p = eye + rd * hit.t;
  let pv = p / frame.voxel;
  let mp = vec3f(dot(p - rifle.t, rifle.x), dot(p - rifle.t, rifle.y), dot(p - rifle.t, rifle.z));
  let n = rifle.x * hit.normal.x + rifle.y * hit.normal.y + rifle.z * hit.normal.z;

  // The sky's openness where along the rifle this is, between the probe's points.
  let along = clamp((mp.z - PROBE_FROM) / (PROBE_TO - PROBE_FROM) * f32(PROBE_POINTS) - 0.5, 0.0, f32(PROBE_POINTS) - 1.0);
  let k0 = u32(floor(along));
  let sky = mix(probed[k0], probed[min(k0 + 1u, PROBE_POINTS - 1u)], fract(along));
  let keyVisible = keyLit(pv);
  var lit = frame.keyColour * keyVisible * max(dot(n, frame.keyDir), 0.0) + skyIrradiance(n) * (0.1 + 0.9 * sky) + flashLight(pv, n);
  let cell = cellOf(rifleToWorld(vec3f(0.0, 0.0, PROBE_MIDDLE)) / frame.voxel);
  if (cell >= 0) {
    for (var k = 0u; k < cellCount(cell); k++) {
      lit += unshadowed(lights[cellLight(cell, k)], pv, n) * probed[PROBE_POINTS + k];
    }
  }
  // A little of the key's light off the steel, toward the eye.
  let toward = normalize(frame.keyDir - rd);
  let shine = frame.keyColour * keyVisible * rifle.specular * (1.0 - roughnessOf(hit.palette)) * pow(max(dot(n, toward), 0.0), 48.0) * select(0.0, 1.0, dot(n, frame.keyDir) > 0.0);
  let colour = albedoOf(hit.palette) * lit + shine;

  let motion = project(frame.prev, rifleWasWorld(mp) / frame.voxel, vec2f(frame.res)) - project(frame.cam, pv, vec2f(frame.res));
  textureStore(rifleDepth, vec2i(px), vec4f(depth, 0.0, 0.0, 0.0));
  textureStore(gMotion, vec2i(px), vec4f(motion, 0.0, 0.0));
  textureStore(outColour, vec2i(px), vec4f(colour, 1.0));
}
