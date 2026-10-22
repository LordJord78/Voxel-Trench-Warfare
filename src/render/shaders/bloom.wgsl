// Bloom (see bloom.ts): one level of the pyramid down, or one back up. Every tap is bilinear in its
// level, its position held within the level's rendered texels (dynamic resolution renders part of
// each texture), so an edge texel's neighbour is itself.

struct Level {
  // The source level's rendered texels, and the size its texture was allocated at.
  valid: vec2f,
  alloc: vec2f,
  // The texels this pass writes.
  out: vec2u,
  // Going up: how many levels the coarser image is the mean of.
  count: f32,
  pad: f32,
}

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var fine: texture_2d<f32>;
@group(0) @binding(2) var linear: sampler;
@group(0) @binding(3) var dest: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var<uniform> level: Level;

fn tap(p: vec2f) -> vec3f {
  let q = clamp(p, vec2f(0.5), level.valid - 0.5);
  return textureSampleLevel(source, linear, q / level.alloc, 0.0).rgb;
}

// Half the size: Jimenez's 13 taps round each texel's 2 × 2 block of the finer level, five 4 × 4
// boxes (the middle one weighted 1/2, the four overlapping it 1/8 each), which keeps the energy.
@compute @workgroup_size(8, 8)
fn down(@builtin(global_invocation_id) g: vec3u) {
  if (any(g.xy >= level.out)) {
    return;
  }
  let c = vec2f(g.xy) * 2.0 + 1.0;
  let inner = tap(c + vec2f(-1.0, -1.0)) + tap(c + vec2f(1.0, -1.0)) + tap(c + vec2f(-1.0, 1.0)) + tap(c + vec2f(1.0, 1.0));
  let m = tap(c);
  let n = tap(c + vec2f(0.0, -2.0));
  let s = tap(c + vec2f(0.0, 2.0));
  let w = tap(c + vec2f(-2.0, 0.0));
  let e = tap(c + vec2f(2.0, 0.0));
  let corners = tap(c + vec2f(-2.0, -2.0)) + tap(c + vec2f(2.0, -2.0)) + tap(c + vec2f(-2.0, 2.0)) + tap(c + vec2f(2.0, 2.0));
  // Each corner box holds one corner tap, two edge taps and the middle; each edge tap is in two boxes.
  let boxes = (corners + 2.0 * (n + s + w + e) + 4.0 * m) * 0.25;
  textureStore(dest, g.xy, vec4f(0.125 * inner + 0.125 * boxes, 1.0));
}

// Back up: the mean of this level's own image and the `count` levels the coarser one is the mean of,
// that brought up through a 3 × 3 tent of bilinear taps a coarse texel apart. A mean, not a sum:
// summed, six levels of the sun's disc (30,000) would pass half floats' 65,504.
@compute @workgroup_size(8, 8)
fn up(@builtin(global_invocation_id) g: vec3u) {
  if (any(g.xy >= level.out)) {
    return;
  }
  let x = (vec2f(g.xy) + 0.5) * 0.5;
  var sum = vec3f(0.0);
  for (var b = -1; b <= 1; b++) {
    for (var a = -1; a <= 1; a++) {
      let w = f32((2 - abs(a)) * (2 - abs(b)));
      sum += w * tap(x + vec2f(f32(a), f32(b)));
    }
  }
  let own = textureLoad(fine, vec2i(g.xy), 0).rgb;
  textureStore(dest, g.xy, vec4f((own + level.count * sum / 16.0) / (level.count + 1.0), 1.0));
}
