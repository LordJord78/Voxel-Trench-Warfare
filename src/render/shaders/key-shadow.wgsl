// The key light's height map (see key-shadow.ts). Seen from the light, on a plane square to it
// through the map's middle: for each texel, how far along the light a ray from past the map runs
// before the voxel world blocks it (from the plane, in voxels), or KEY_OPEN if nothing does.
// keyLit asks it whether the key light reaches a point; keyShare (in another pass's dispatch) or
// `build` (in a pass of its own) traces its texels.
#include "traverse.wgsl"

const KEY_MAP_SIZE: u32 = 1024u;
// A texel whose ray meets nothing.
const KEY_OPEN: f32 = 1e9;
// How much nearer the light than a texel's depth a point must be to count as lit, in texels: on a
// slope, a texel's ray meets the ground a little nearer or farther than a point beside it.
const KEY_BIAS: f32 = 1.0;

struct KeyShadowInfo {
  // Across the light, level; across it, square to u; and the way the light runs (away from it).
  u: vec3f,
  texel: f32,
  v: vec3f,
  // How far before the plane the rays start: past the map's farthest corner.
  reach: f32,
  along: vec3f,
  pad0: f32,
  // The map's middle: the plane through it is the map's, and depths count from it.
  origin: vec3f,
  pad1: f32,
}

// The map's texels are traced in tiles of 8 × 8, a workgroup's 64 rays a tile: neighbours run
// through the same bricks, so they share what they read.
const KEY_TILE: u32 = 8u;

struct KeyBuild {
  // The tiles traced: every `step`th each way from `offset`, `count` texels in all, a row of tiles at a time.
  offset: vec2u,
  step: u32,
  count: u32,
  // In a dispatch another pass shares (keyShare), the first `rows` rows of its workgroups, `width` across.
  rows: u32,
  width: u32,
  pad0: u32,
  pad1: u32,
}

// For a pass that asks keyLit (key-shadow.ts's `group`).
@group(2) @binding(0) var<uniform> keyShadow: KeyShadowInfo;
@group(2) @binding(1) var keyMap: texture_2d<f32>;
// The build's own.
@group(2) @binding(2) var keyMapOut: texture_storage_2d<r32float, write>;
@group(2) @binding(3) var<uniform> keyBuild: KeyBuild;

// Whether the key light reaches p (voxels), 0 to 1: p's depth along the light against its four
// nearest texels', weighted by nearness. Off the map's texels, it does.
fn keyLit(p: vec3f) -> f32 {
  let q = p - keyShadow.origin;
  let size = f32(KEY_MAP_SIZE);
  // Texel coordinates, texel (i, j)'s middle at (i, j).
  let st = vec2f(dot(q, keyShadow.u), dot(q, keyShadow.v)) / keyShadow.texel + size * 0.5 - 0.5;
  if (any(st < vec2f(-0.5)) || any(st > vec2f(size - 0.5))) {
    return 1.0;
  }
  let depth = dot(q, keyShadow.along) - KEY_BIAS * keyShadow.texel;
  let base = floor(st);
  let f = st - base;
  let last = vec2i(i32(KEY_MAP_SIZE) - 1);
  var lit = 0.0;
  for (var k = 0; k < 4; k++) {
    let o = vec2i(k & 1, k >> 1u);
    let w = select(1.0 - f.x, f.x, o.x == 1) * select(1.0 - f.y, f.y, o.y == 1);
    let t = clamp(vec2i(base) + o, vec2i(0), last);
    lit += select(0.0, w, depth <= textureLoad(keyMap, t, 0).r);
  }
  return lit;
}

// Trace the n-th of the texels this build traces: its ray runs from past the map's farthest corner
// along the light, for twice as far.
fn keyTrace(n: u32) {
  if (n >= keyBuild.count) {
    return;
  }
  let across = KEY_MAP_SIZE / KEY_TILE / keyBuild.step;
  let t = n / 64u;
  let tile = vec2u(t % across, t / across) * keyBuild.step + keyBuild.offset;
  let texel = tile * KEY_TILE + vec2u(n % KEY_TILE, (n / KEY_TILE) % KEY_TILE);
  let at = (vec2f(texel) + 0.5 - f32(KEY_MAP_SIZE) * 0.5) * keyShadow.texel;
  let ro = keyShadow.origin + keyShadow.u * at.x + keyShadow.v * at.y - keyShadow.along * keyShadow.reach;
  let h = traceWorld(ro, keyShadow.along, 0.0, 2.0 * keyShadow.reach, false);
  textureStore(keyMapOut, texel, vec4f(select(KEY_OPEN, h.t - keyShadow.reach, h.hit), 0.0, 0.0, 0.0));
}

// For a pass whose dispatch the build shares (primary.wgsl), in workgroups of 64: whether `group` is
// one of the map's, its first rows, having traced its texels if so. Few of the map's rays reach the
// world, and a ray waits on memory at every step, so in a pass of its own the longest of them would
// take the time; beside a pass of many rays, they take only their share.
fn keyShare(group: vec3u, local: u32) -> bool {
  if (group.y >= keyBuild.rows) {
    return false;
  }
  keyTrace((group.y * keyBuild.width + group.x) * 64u + local);
  return true;
}

@compute @workgroup_size(64)
fn build(@builtin(global_invocation_id) g: vec3u) {
  keyTrace(g.x);
}
