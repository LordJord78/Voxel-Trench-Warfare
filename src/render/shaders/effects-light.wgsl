// The effects' billboards, lit for the draw (effects.wgsl): those not emissive (brass, dust) as
// the world is lit — the key through its height map, so a mote in the trench's shadow is in it; the
// shots' flashes whole, as on a face turned to each; and the rest of the light as the faces near it
// take it (the denoised light behind it: the sky, what the trench throws back, the lamps), or, in
// the open, the sky from all round and the lights of its cell, whole and unshadowed as they light
// the haze (a flare through its map) — and the emissive (the flash, sparks) by their own glow. Then
// each is seen through the haze between it and the eye, as shade sees the world: the wall behind a
// mote has it, and a mote without it reads as soot. One thread a billboard.
#include "scene.wgsl"
#include "sky.wgsl"
#include "camera.wgsl"
#include "light-cells.wgsl"
#include "key-shadow.wgsl"
#include "haze.wgsl"

struct EffectsLight {
  count: u32,
  glow: f32,
  dustKey: f32,
  dustSky: f32,
}

struct Lit {
  centre: vec3f,
  half: f32,
  // Premultiplied; alpha 0 adds light, as the emissive do.
  colour: vec4f,
}

// Group 1 after the light cells' grid and cells (light-cells.wgsl); group 3 is the haze's.
@group(1) @binding(2) var<uniform> look: EffectsLight;
// Nine floats a billboard (particles.ts): centre, half its size, colour premultiplied, emissive.
@group(1) @binding(3) var<storage, read> billboards: array<f32>;
@group(1) @binding(4) var<storage, read_write> lit: array<Lit>;
@group(1) @binding(5) var gDepth: texture_2d<f32>;
// shade.wgsl's denoised light, at the lighting resolution: what a face takes but the key's.
@group(1) @binding(6) var worldLight: texture_2d<f32>;

const BILLBOARD_FLOATS: u32 = 9u;
// Within NEAR_FULL metres of a face a mote takes all of the face's light, past NEAR_NONE none.
const NEAR_FULL: f32 = 0.5;
const NEAR_NONE: f32 = 2.0;
// The faces near a mote are found behind it and NEAR_REACH metres round it, so one at a face's
// edge takes part of its light rather than all or none.
const NEAR_REACH: f32 = 0.2;
const NEAR_TAPS = array<vec2f, 5>(vec2f(0.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(-1.0, -1.0));

// A light's whole light at p (voxels), as on a face turned to it.
fn facing(l: Light, p: vec3f) -> vec3f {
  let d = l.pos - p;
  return unshadowed(l, p, d / max(length(d), 1e-6));
}

// The sky's light on a mote: the mean of what the six faces of a voxel there would take.
fn skyAround() -> vec3f {
  let x = skyIrradiance(vec3f(1.0, 0.0, 0.0)) + skyIrradiance(vec3f(-1.0, 0.0, 0.0));
  let y = skyIrradiance(vec3f(0.0, 1.0, 0.0)) + skyIrradiance(vec3f(0.0, -1.0, 0.0));
  let z = skyIrradiance(vec3f(0.0, 0.0, 1.0)) + skyIrradiance(vec3f(0.0, 0.0, -1.0));
  return (x + y + z) / 6.0;
}

// The shots' flashes at p (voxels).
fn flashesAt(p: vec3f) -> vec3f {
  var sum = vec3f(0.0);
  for (var i = 0u; i < min(frame.flashCount, 4u); i++) {
    let f = frame.flashes[i];
    sum += facing(Light(f.pos, f.radius, f.colour, f.intensity), p);
  }
  return sum;
}

// The lights p's cell lists, at p (voxels).
fn cellLightsAt(p: vec3f) -> vec3f {
  var sum = vec3f(0.0);
  let cell = cellOf(p);
  if (cell >= 0) {
    for (var k = 0u; k < cellCount(cell); k++) {
      let index = cellLight(cell, k);
      sum += facing(lights[index], p) * flareLit(index, p);
    }
  }
  return sum;
}

// The light the faces near p (voxels) take, but the key's, and how near they are: 1 for all of it,
// 0 in the open.
fn nearLight(p: vec3f) -> vec4f {
  let res = vec2f(frame.res);
  let reach = NEAR_REACH / frame.voxel;
  var sum = vec3f(0.0);
  var weight = 0.0;
  for (var k = 0u; k < 5u; k++) {
    let q = p + (frame.cam.right * NEAR_TAPS[k].x + frame.cam.up * NEAR_TAPS[k].y) * reach;
    let px = project(frame.cam, q, res);
    if (any(px < vec2f(0.0)) || any(px >= res)) {
      continue;
    }
    let gap = abs(textureLoad(gDepth, vec2i(px), 0).r - distance(q, frame.cam.origin)) * frame.voxel;
    let w = 1.0 - smoothstep(NEAR_FULL, NEAR_NONE, gap);
    if (w > 0.0) {
      let t = clamp(vec2i(px / f32(frame.lightScale)), vec2i(0), vec2i(frame.lightRes) - 1);
      sum += w * textureLoad(worldLight, t, 0).rgb;
      weight += w;
    }
  }
  return vec4f(sum / max(weight, 1e-6), weight / 5.0);
}

// The haze between the eye and p (voxels), as shade.wgsl takes it for the world: the light it
// scatters toward the eye, and what shows through it.
fn hazeBefore(p: vec3f) -> vec4f {
  let d = p - frame.cam.origin;
  let rd = d / max(length(d), 1e-6);
  let metres = length(d) * frame.voxel;
  let eyeY = frame.cam.origin.y * frame.voxel;
  if ((frame.flags & FLAG_FROXELS_OFF) != 0u) {
    let f = fog(eyeY, rd, metres);
    return vec4f(f.rgb * (1.0 - f.a), f.a);
  }
  let res = vec2f(frame.res);
  return hazeTo(clamp(project(frame.cam, p, res) / res, vec2f(0.0), vec2f(1.0)), eyeY, rd, metres);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= look.count) {
    return;
  }
  let o = i * BILLBOARD_FLOATS;
  let centre = vec3f(billboards[o], billboards[o + 1u], billboards[o + 2u]);
  let colour = vec4f(billboards[o + 4u], billboards[o + 5u], billboards[o + 6u], billboards[o + 7u]);
  var out = vec4f(colour.rgb * look.glow, 0.0);
  if (billboards[o + 8u] == 0.0) {
    let p = centre / frame.voxel;
    let near = nearLight(p);
    let around = skyAround() * look.dustSky + cellLightsAt(p);
    let light = frame.keyColour * keyLit(p) * look.dustKey + flashesAt(p) + mix(around, near.rgb, near.a);
    out = vec4f(colour.rgb * light, colour.a);
  }
  // Premultiplied: what covers adds the haze before it as much as it covers.
  let haze = hazeBefore(centre / frame.voxel);
  lit[i] = Lit(centre, billboards[o + 3u], vec4f(out.rgb * haze.a + haze.rgb * out.a, out.a));
}
