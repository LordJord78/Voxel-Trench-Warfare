// The flares' shadow maps (see flare-shadows.ts): for each of the first FLARE_MAPS burning flares,
// the hemisphere below it on a paraboloid (a direction d at (d.x, d.z) / (1 − d.y) on the unit disc),
// each texel how far from the flare its ray runs before the voxel world stops it, within its reach.
// They lie in the key light's atlas below its height map, four tiles to a row. flareRay gives the
// shared dispatch (key-shadow.wgsl) a texel's ray; flareLit asks whether a flare reaches a point.
// Included by key-shadow.wgsl, whose atlas this reads and writes.

const FLARE_MAPS: u32 = 8u;
const FLARE_MAP_SIZE: u32 = 256u;
const NO_FLARE: u32 = 0xffffffffu;

struct FlareInfo {
  // Each slot's light (NO_FLARE if none), four to a vec4.
  lights: array<vec4u, 2>,
  // Each slot's flare: where it is (voxels) and how far its light reaches.
  flares: array<vec4f, 8>,
}

struct FlareBuild {
  // Each job: its slot, its step (1, every texel; 4, a sixteenth), its tile offset (x | y << 16), and
  // its first texel among the flares' this frame.
  jobs: array<vec4u, 8>,
  // How many jobs, and the flares' texels in all.
  totals: vec4u,
}

@group(2) @binding(5) var<uniform> flareInfo: FlareInfo;
// The build's own.
@group(2) @binding(7) var<uniform> flareBuild: FlareBuild;

// Where slot k's map lies in the atlas.
fn flareTile(k: u32) -> vec2u {
  return vec2u((k & 3u) * FLARE_MAP_SIZE, KEY_MAP_SIZE + (k >> 2u) * FLARE_MAP_SIZE);
}

// The m-th of the flares' texels this frame, and its ray from its flare.
fn flareRay(m: u32) -> ShadowRay {
  var ray = ShadowRay(false, false, vec2u(0u), vec3f(0.0), vec3f(0.0, -1.0, 0.0), 0.0, 0.0);
  for (var j = 0u; j < flareBuild.totals.x; j++) {
    let job = flareBuild.jobs[j];
    let size = select(FLARE_MAP_SIZE * FLARE_MAP_SIZE / 16u, FLARE_MAP_SIZE * FLARE_MAP_SIZE, job.y == 1u);
    if (m < job.w || m >= job.w + size) {
      continue;
    }
    let n = m - job.w;
    let across = FLARE_MAP_SIZE / 8u / job.y;
    let t = n / 64u;
    let tile = vec2u(t % across, t / across) * job.y + vec2u(job.z & 0xffffu, job.z >> 16u);
    let texel = tile * 8u + vec2u(n % 8u, (n / 8u) % 8u);
    let disc = (vec2f(texel) + 0.5) / f32(FLARE_MAP_SIZE) * 2.0 - 1.0;
    let r = dot(disc, disc);
    let f = flareInfo.flares[job.x];
    ray.live = true;
    // A texel off the disc stands for no direction: open.
    ray.trace = r <= 1.0;
    ray.texel = flareTile(job.x) + texel;
    ray.ro = f.xyz;
    ray.rd = vec3f(2.0 * disc.x, r - 1.0, 2.0 * disc.y) / (1.0 + r);
    ray.reach = f.w;
    break;
  }
  return ray;
}

// How much of light `light`'s glow reaches p (voxels), 0 to 1, by its flare's map: p's distance from
// the flare against its four nearest texels', weighted by nearness. A light the maps do not hold, a
// point above its flare or beyond its reach, is reached.
fn flareLit(light: u32, p: vec3f) -> f32 {
  for (var k = 0u; k < FLARE_MAPS; k++) {
    if (flareInfo.lights[k >> 2u][k & 3u] == light) {
      return flareMapLit(k, p);
    }
  }
  return 1.0;
}

fn flareMapLit(k: u32, p: vec3f) -> f32 {
  let f = flareInfo.flares[k];
  let d = p - f.xyz;
  let dist = length(d);
  if (d.y >= 0.0 || dist >= f.w || dist < 1e-3) {
    return 1.0;
  }
  let dir = d / dist;
  let st = (dir.xz / (1.0 - dir.y) * 0.5 + 0.5) * f32(FLARE_MAP_SIZE) - 0.5;
  // A voxel, and a texel's width across the light where p is (0.9° straight below).
  let bias = 1.0 + dist * (4.0 / f32(FLARE_MAP_SIZE));
  let base = floor(st);
  let w = st - base;
  let origin = vec2i(flareTile(k));
  let last = vec2i(i32(FLARE_MAP_SIZE) - 1);
  var lit = 0.0;
  for (var q = 0; q < 4; q++) {
    let o = vec2i(q & 1, q >> 1u);
    let weight = select(1.0 - w.x, w.x, o.x == 1) * select(1.0 - w.y, w.y, o.y == 1);
    let t = origin + clamp(vec2i(base) + o, vec2i(0), last);
    lit += select(0.0, weight, dist - bias <= textureLoad(keyMap, t, 0).r);
  }
  return lit;
}
