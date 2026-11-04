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
// The tracers' light (their ribbons, heads and embers, the battle's and the ricochets' too) is lit to
// keep its hue through the present pass's per-channel tone curve (keepHue): far off and in its glow a
// tracer shows its team's colour, where the curve alone would take a bright red to white; as white as
// its core is near the eye (or by day, whiteFloor), it shows as the curve alone shows it, white-hot.
#include "tone.wgsl"

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
  // The hour's bias over the exposure (sky.exposure), and the share of the sharpened image the
  // present pass shows (the rest is its bloom's): with exposureState, the present pass's own scale.
  bias: f32,
  sharpShare: f32,
  // The least a tracer's core is as white as it is near the eye: by day it reads white-hot as before.
  whiteFloor: f32,
  pad0: f32,
  pad1: f32,
}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> lit: array<Lit>;
@group(0) @binding(2) var<storage, read> ribbons: array<Ribbon>;
@group(0) @binding(3) var gDepth: texture_2d<f32>;
@group(0) @binding(4) var<uniform> draw: EffectsDraw;
// The exposure's adaptation (auto-exposure.ts): this frame's base, the last frame's correction.
@group(0) @binding(5) var<storage, read> exposureState: array<f32, 8>;

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
// Shown this near the tone curve's top, a channel is shown as bright as it can be.
const TONE_TOP: f32 = 0.9999;

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
  // The tracers' light (1), kept at its hue; and how white it is near the eye (1 within whiteNearM).
  @location(5) tone: vec2f,
  // A tracer's across (-1 to 1), interpolated over the screen, not in perspective: its glow is held
  // between glowMinPx and glowMaxPx, so its profile is in pixels, and one reaching from beside the eye
  // far out (a shot from the hip) would draw its core off its middle, along one edge of its glow, each
  // of its quad's two triangles weighting its near corners. Where its two ends are held to different
  // widths it is within a pixel and a half of its middle. The flash's star, held in metres, keeps uv.x.
  @location(6) @interpolate(linear) across: f32,
}

// As camera.wgsl's project, in clip space: perspective-correct, and clipped at NEAR.
fn toClip(p: vec3f) -> vec4f {
  let c = frame.cam;
  let d = p - c.origin;
  let aspect = f32(frame.res.x) / f32(frame.res.y);
  let w = dot(d, c.forward);
  return vec4f(dot(d, c.right) / c.tanHalf, dot(d, c.up) / c.tanHalf * aspect, w - NEAR, w);
}

// The present pass's scale on the sharpened image: the presented exposure (histogram.wgsl's, the
// hour's bias over the base reckoned from the light and the meter's correction, the last frame's), on
// its share of the image.
fn presentedScale() -> f32 {
  return draw.bias * exposureState[0] * exp2(exposureState[1]) * draw.sharpShare;
}

// A tracer's light `c` as the present pass is to show it at its own hue: its brightest channel as it
// is, the others so that the pass's per-channel curve shows them in proportion to it; blended back
// toward the curve's own look (white-hot where it is bright) by `white` (0 to 1). Exact over black,
// near it over the scene. Where a channel shows at the curve's top, and on the brightest, the light is
// left as it was: it shows the same, and the bloom spreads it.
fn keepHue(c: vec3f, white: f32) -> vec3f {
  let e = presentedScale();
  let x = c * e;
  let m = max(x.r, max(x.g, x.b));
  if (!(e > 0.0) || !(m > 0.0)) {
    return c;
  }
  let shown = mix(aces(vec3f(m)) * x / m, aces(x), clamp(white, 0.0, 1.0));
  let keep = (shown >= vec3f(TONE_TOP)) | (x >= vec3f(m));
  return select(acesInverse(shown) / e, c, keep);
}

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
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
    var tone = vec2f(0.0);
    if (b.colour.a < -0.5) {
      // The tracers' light: a head (its alpha -1 less its whiteness), or a strike's ember (-3 less it).
      let ember = b.colour.a < -2.5;
      tone = vec2f(1.0, clamp(select(-1.0 - b.colour.a, -3.0 - b.colour.a, ember), 0.0, 1.0));
      colour = vec4f(b.colour.rgb, 0.0);
      if (!ember) {
        // A head, held as its ribbon is: no smaller than MIN_HEAD_PX, its light kept, nor wider than
        // headMaxPx, narrowed and not brightened.
        let pixel = pixelAt(b.centre * toVoxels) * frame.voxel;
        let drawn = min(max(half, 0.5 * MIN_HEAD_PX * pixel), 0.5 * draw.headMaxPx * pixel);
        colour = vec4f(b.colour.rgb * min((half / drawn) * (half / drawn), 1.0), 0.0);
        half = drawn;
      }
    }
    let p = (b.centre + (frame.cam.right * corner.x + frame.cam.up * corner.y) * half) * toVoxels;
    f.clip = toClip(p);
    f.world = p;
    f.uv = corner;
    f.colour = colour;
    f.tone = tone;
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
  f.across = corner.x;
  f.colour = vec4f(r.rgb * (width / drawn), 0.0);
  f.alphas = vec2f(r.alphaTail, r.alphaHead);
  if (isTracer) {
    // Its core, mixed toward white at its brightest channel by its whiteness at the ribbon's middle
    // (all of it near the eye, none far off); each term's light kept where it is drawn wider than it
    // is, and none added where it is held narrower.
    let core = r.coreShare * width;
    let coreDrawn = min(max(r.coreShare * drawn, narrowest), CORE_MAX_SHARE * drawn);
    let metres = distance((tail + head) * 0.5, frame.cam.origin) * frame.voxel;
    // As white as near the eye within whiteNearM, none from whiteFarM; by day, at least whiteFloor.
    let near = max(1.0 - smoothstep(draw.whiteNearM, draw.whiteFarM, metres), draw.whiteFloor);
    let hot = mix(r.rgb, vec3f(max(r.rgb.r, max(r.rgb.g, r.rgb.b))), r.white * near);
    f.colour = vec4f(hot * (min(core / coreDrawn, 1.0) * shown), 0.0);
    f.glow = vec4f(r.rgb * (r.glowShare * min(width / drawn, 1.0) * shown), coreDrawn / drawn);
    f.tone = vec2f(1.0, near);
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
      // A tracer: its core, its share of the width drawn, in its glow; both fading to the tail. As
      // white as its core's share of its light where the core is white (near the eye, or by day); its
      // glow keeps its hue.
      let u2 = f.across * f.across;
      let fade = mix(f.alphas.x, f.alphas.y, f.uv.y);
      let core = f.colour.rgb * (exp(-3.0 * u2 / (f.glow.a * f.glow.a)) * fade);
      let glow = f.glow.rgb * (exp(-3.0 * u2) * fade);
      let share = luma(core) / max(luma(core + glow), 1e-9);
      return vec4f(keepHue(core + glow, f.tone.y * share), 0.0);
    }
    // Soft across, fading from the head back to the tail.
    let a = mix(f.alphas.x, f.alphas.y, f.uv.y) * exp(-3.0 * f.uv.x * f.uv.x);
    return vec4f(f.colour.rgb * a, 0.0);
  }
  if (f.alphas.x < -1.5) {
    return f.colour;
  }
  let disc = f.colour * (1.0 - smoothstep(0.5, 1.0, length(f.uv)));
  if (f.tone.x > 0.5) {
    // A tracer's head or ember: as white as the core it burns as (near the eye, or by day).
    return vec4f(keepHue(disc.rgb, f.tone.y), 0.0);
  }
  return disc;
}
