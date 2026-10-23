// The effects drawn over the sharpened image (effects.ts): the lit billboards facing the camera,
// then the ribbons (tracers, the flash's star) turned about their length to face it. Projected
// through the frame's camera without jitter (this is after TAA), each fragment is dropped where
// the G-buffer's depth along its pixel's ray is nearer, so walls hide what is behind them, and
// blended premultiplied: the emissive add their light (alpha 0), dust covers what is behind it.

struct Lit {
  centre: vec3f,
  half: f32,
  colour: vec4f,
}

// Metres; the colour linear and emissive; alpha from the tail to the head.
struct Ribbon {
  tail: vec3f,
  width: f32,
  head: vec3f,
  alphaTail: f32,
  rgb: vec3f,
  alphaHead: f32,
}

struct EffectsDraw {
  billboards: u32,
  ribbons: u32,
  pad0: u32,
  pad1: u32,
}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> lit: array<Lit>;
@group(0) @binding(2) var<storage, read> ribbons: array<Ribbon>;
@group(0) @binding(3) var gDepth: texture_2d<f32>;
@group(0) @binding(4) var<uniform> draw: EffectsDraw;

// The nearest the camera anything is drawn, in voxels: clipped there, not at the eye.
const NEAR: f32 = 0.5;

const CORNERS = array(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));

struct Fragment {
  @builtin(position) clip: vec4f,
  // Voxels, for the depth test.
  @location(0) world: vec3f,
  // A billboard's corner in [-1, 1]²; a ribbon's (across, along from tail 0 to head 1).
  @location(1) uv: vec2f,
  @location(2) colour: vec4f,
  // A ribbon's alpha at its tail and head; (-1, -1) for a billboard.
  @location(3) alphas: vec2f,
}

// As camera.wgsl's project, in clip space: perspective-correct, and clipped at NEAR.
fn toClip(p: vec3f) -> vec4f {
  let c = frame.cam;
  let d = p - c.origin;
  let aspect = f32(frame.res.x) / f32(frame.res.y);
  let w = dot(d, c.forward);
  return vec4f(dot(d, c.right) / c.tanHalf, dot(d, c.up) / c.tanHalf * aspect, w - NEAR, w);
}

@vertex
fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Fragment {
  let corner = CORNERS[v];
  let toVoxels = 1.0 / frame.voxel;
  var f: Fragment;
  if (i < draw.billboards) {
    let b = lit[i];
    let p = (b.centre + (frame.cam.right * corner.x + frame.cam.up * corner.y) * b.half) * toVoxels;
    f.clip = toClip(p);
    f.world = p;
    f.uv = corner;
    f.colour = b.colour;
    f.alphas = vec2f(-1.0);
    return f;
  }
  let r = ribbons[i - draw.billboards];
  let tail = r.tail * toVoxels;
  let head = r.head * toVoxels;
  // Across the ribbon: square to its length and to the line of sight, so it faces the camera.
  let across = cross(head - tail, (tail + head) * 0.5 - frame.cam.origin);
  let span = length(across);
  let side = select(frame.cam.right, across / max(span, 1e-6), span > 1e-6) * (r.width * 0.5 * toVoxels);
  let along = corner.y * 0.5 + 0.5;
  let p = mix(tail, head, along) + side * corner.x;
  f.clip = toClip(p);
  f.world = p;
  f.uv = vec2f(corner.x, along);
  f.colour = vec4f(r.rgb, 0.0);
  f.alphas = vec2f(r.alphaTail, r.alphaHead);
  return f;
}

@fragment
fn fs(f: Fragment) -> @location(0) vec4f {
  let depth = textureLoad(gDepth, vec2i(f.clip.xy), 0).r;
  if (length(f.world - frame.cam.origin) > depth * 1.0001) {
    discard;
  }
  if (f.alphas.x >= 0.0) {
    // Soft across, fading from the head back to the tail.
    let a = mix(f.alphas.x, f.alphas.y, f.uv.y) * exp(-3.0 * f.uv.x * f.uv.x);
    return vec4f(f.colour.rgb * a, 0.0);
  }
  return f.colour * (1.0 - smoothstep(0.5, 1.0, length(f.uv)));
}
