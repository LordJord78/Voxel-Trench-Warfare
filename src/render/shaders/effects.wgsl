// The effects drawn over the sharpened image (effects.ts): the lit billboards facing the camera,
// then the ribbons (tracers, the flash's star) turned about their length to face it, never drawn
// narrower than MIN_RIBBON_PX: a far tracer's light is spread over that width instead, so it stays
// a line rather than breaking into dashes between pixel centres (this is after TAA). Projected
// through the frame's camera without jitter (this is after TAA), each fragment is dropped where
// the G-buffer's depth along its pixel's ray is nearer, so walls hide what is behind them, and
// blended premultiplied: the emissive add their light (alpha 0), dust covers what is behind it.
// A ribbon's style is how it is lit across: a flash star's one soft term (0), or a tracer's two (1),
// a core mixed toward white in a glow of its colour. A tracer's glow is drawn no narrower than
// glowMinPx, its light kept, so far off its colour shows round its core, nor wider than glowMaxPx,
// narrowed and not brightened, so a round past the eye is not a bar or a wedge across the view; its
// core is its share of the width drawn, no narrower than MIN_RIBBON_PX (its light kept) nor wider
// than CORE_MAX_SHARE of the glow. The core is mixed toward white by all of the ribbon's whiteness
// within whiteNearM of the eye, falling to none at whiteFarM: white-hot close by, the team's colour
// far off. Seen end on, a tracer's ends within END_ON_PX of each other, it draws nothing: its head (a
// held billboard, no smaller than MIN_HEAD_PX nor wider than headMaxPx) carries it.

struct Lit {
  centre: vec3f,
  half: f32,
  colour: vec4f,
}

// Metres; the colour linear and emissive; alpha from the tail to the head. Its style (0 a star, 1 a
// tracer), and a tracer's core width and glow brightness as shares of its glow's (the width), and
// how far its core is mixed toward white.
struct Ribbon {
  tail: vec3f,
  width: f32,
  head: vec3f,
  alphaTail: f32,
  rgb: vec3f,
  alphaHead: f32,
  style: f32,
  coreShare: f32,
  glowShare: f32,
  white: f32,
}

struct EffectsDraw {
  billboards: u32,
  ribbons: u32,
  // The widest a tracer's glow is drawn, and its head, and the narrowest its glow is, in pixels.
  glowMaxPx: f32,
  headMaxPx: f32,
  glowMinPx: f32,
  // Its core's whiteness: all of it within whiteNearM of the eye, none from whiteFarM (metres).
  whiteNearM: f32,
  whiteFarM: f32,
  pad: f32,
}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> lit: array<Lit>;
@group(0) @binding(2) var<storage, read> ribbons: array<Ribbon>;
@group(0) @binding(3) var gDepth: texture_2d<f32>;
@group(0) @binding(4) var<uniform> draw: EffectsDraw;

// The nearest the camera anything is drawn, in voxels: clipped there, not at the eye.
const NEAR: f32 = 0.5;
// The narrowest a ribbon is drawn, in pixels: wide enough that every column it crosses has a pixel
// centre within half a pixel of its middle (its soft edge falls to a twentieth).
const MIN_RIBBON_PX: f32 = 2.0;
// The smallest a tracer's head (a disc) is drawn, in pixels across: from three, the light it lays on
// the pixels it covers is within 2% of the same wherever it falls among them (at two, between half
// and 1.4 times it), so a far head moving across the view does not twinkle.
const MIN_HEAD_PX: f32 = 3.0;
// A tracer whose ends fall within this many pixels of each other is seen end on (the shooter's own
// round, from the eye it left): it draws nothing, fading in over the next as many.
const END_ON_PX: f32 = 1.0;
// The widest a tracer's core is drawn, as a share of its glow: the glow's colour shows round it.
const CORE_MAX_SHARE: f32 = 0.45;

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
  // A tracer's glow, and its core's width over the width drawn; zero for the rest.
  @location(4) glow: vec4f,
}

// As camera.wgsl's project, in clip space: perspective-correct, and clipped at NEAR.
fn toClip(p: vec3f) -> vec4f {
  let c = frame.cam;
  let d = p - c.origin;
  let aspect = f32(frame.res.x) / f32(frame.res.y);
  let w = dot(d, c.forward);
  return vec4f(dot(d, c.right) / c.tanHalf, dot(d, c.up) / c.tanHalf * aspect, w - NEAR, w);
}

// A pixel's width at p (voxels), in voxels.
fn pixelAt(p: vec3f) -> f32 {
  return 2.0 * max(dot(p - frame.cam.origin, frame.cam.forward), NEAR) * frame.cam.tanHalf / f32(frame.res.x);
}

// How much of a tracer from tail to head (voxels) is shown: none seen end on, its ends within
// END_ON_PX of each other on the screen, all from twice that, and all while an end is within NEAR.
fn sideOn(tail: vec3f, head: vec3f) -> f32 {
  let a = toClip(tail);
  let b = toClip(head);
  if (a.w <= NEAR || b.w <= NEAR) {
    return 1.0;
  }
  let apart = length((a.xy / a.w - b.xy / b.w) * vec2f(frame.res) * 0.5);
  return clamp(apart / END_ON_PX - 1.0, 0.0, 1.0);
}

@vertex
fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Fragment {
  let corner = CORNERS[v];
  let toVoxels = 1.0 / frame.voxel;
  var f: Fragment;
  if (i < draw.billboards) {
    let b = lit[i];
    var half = abs(b.half);
    var colour = b.colour;
    if (b.colour.a < 0.0) {
      // A tracer's head, held as its ribbon is: no smaller than MIN_HEAD_PX, its light kept, nor wider
      // than headMaxPx, narrowed and not brightened.
      let pixel = pixelAt(b.centre * toVoxels) * frame.voxel;
      let drawn = min(max(half, 0.5 * MIN_HEAD_PX * pixel), 0.5 * draw.headMaxPx * pixel);
      colour = vec4f(b.colour.rgb * min((half / drawn) * (half / drawn), 1.0), 0.0);
      half = drawn;
    }
    let p = (b.centre + (frame.cam.right * corner.x + frame.cam.up * corner.y) * half) * toVoxels;
    f.clip = toClip(p);
    f.world = p;
    f.uv = corner;
    f.colour = colour;
    // A disc (-1), or a square (-2: its half size came negative).
    f.alphas = vec2f(select(-1.0, -2.0, b.half < 0.0));
    return f;
  }
  let r = ribbons[i - draw.billboards];
  let tail = r.tail * toVoxels;
  let head = r.head * toVoxels;
  let isTracer = r.style > 0.5;
  // A tracer seen end on draws nothing (its head carries it): not a sliver of noise across the view.
  let shown = select(1.0, sideOn(tail, head), isTracer);
  if (shown <= 0.0) {
    f.clip = vec4f(0.0, 0.0, -1.0, 1.0);
    return f;
  }
  // Across the ribbon: square to its length and to the line of sight, so it faces the camera.
  let across = cross(head - tail, (tail + head) * 0.5 - frame.cam.origin);
  let span = length(across);
  let along = corner.y * 0.5 + 0.5;
  let mid = mix(tail, head, along);
  // A pixel's width where this end is (voxels), and the width drawn there: its light kept. A star's no
  // narrower than MIN_RIBBON_PX; a tracer's glow held between glowMinPx and glowMaxPx.
  let pixel = pixelAt(mid);
  let width = r.width * toVoxels;
  let narrowest = MIN_RIBBON_PX * pixel;
  let drawn = select(max(width, narrowest), clamp(width, draw.glowMinPx * pixel, draw.glowMaxPx * pixel), isTracer);
  let side = select(frame.cam.right, across / max(span, 1e-6), span > 1e-6) * (drawn * 0.5);
  let p = mid + side * corner.x;
  f.clip = toClip(p);
  f.world = p;
  f.uv = vec2f(corner.x, along);
  f.colour = vec4f(r.rgb * (width / drawn), 0.0);
  f.alphas = vec2f(r.alphaTail, r.alphaHead);
  if (isTracer) {
    // Its core, mixed toward white at its brightest channel by its whiteness at the ribbon's middle
    // (all of it near the eye, none far off); each term's light kept where it is drawn wider than it
    // is, and none added where it is held narrower.
    let core = r.coreShare * width;
    let coreDrawn = min(max(r.coreShare * drawn, narrowest), CORE_MAX_SHARE * drawn);
    let metres = distance((tail + head) * 0.5, frame.cam.origin) * frame.voxel;
    let white = r.white * (1.0 - smoothstep(draw.whiteNearM, draw.whiteFarM, metres));
    let hot = mix(r.rgb, vec3f(max(r.rgb.r, max(r.rgb.g, r.rgb.b))), white);
    f.colour = vec4f(hot * (min(core / coreDrawn, 1.0) * shown), 0.0);
    f.glow = vec4f(r.rgb * (r.glowShare * min(width / drawn, 1.0) * shown), coreDrawn / drawn);
  }
  return f;
}

@fragment
fn fs(f: Fragment) -> @location(0) vec4f {
  let depth = textureLoad(gDepth, vec2i(f.clip.xy), 0).r;
  if (length(f.world - frame.cam.origin) > depth * 1.0001) {
    discard;
  }
  if (f.alphas.x >= 0.0) {
    if (f.glow.a > 0.0) {
      // A tracer: its core, its share of the width drawn, in its glow; both fading to the tail.
      let u2 = f.uv.x * f.uv.x;
      let core = f.colour.rgb * exp(-3.0 * u2 / (f.glow.a * f.glow.a));
      return vec4f((core + f.glow.rgb * exp(-3.0 * u2)) * mix(f.alphas.x, f.alphas.y, f.uv.y), 0.0);
    }
    // Soft across, fading from the head back to the tail.
    let a = mix(f.alphas.x, f.alphas.y, f.uv.y) * exp(-3.0 * f.uv.x * f.uv.x);
    return vec4f(f.colour.rgb * a, 0.0);
  }
  if (f.alphas.x < -1.5) {
    return f.colour;
  }
  return f.colour * (1.0 - smoothstep(0.5, 1.0, length(f.uv)));
}
