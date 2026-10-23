// The effects' billboards, lit for the draw (effects.wgsl): those not emissive (brass, dust) as
// the world is lit — the key through its height map, so a mote in the trench's shadow is in it,
// and the sky's irradiance from above — and the emissive (the flash, sparks) by their own glow.
// One thread a billboard.
#include "scene.wgsl"
#include "sky.wgsl"
#include "key-shadow.wgsl"

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

@group(1) @binding(0) var<uniform> look: EffectsLight;
// Nine floats a billboard (particles.ts): centre, half its size, colour premultiplied, emissive.
@group(1) @binding(1) var<storage, read> billboards: array<f32>;
@group(1) @binding(2) var<storage, read_write> lit: array<Lit>;

const BILLBOARD_FLOATS: u32 = 9u;

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
    let light = frame.keyColour * keyLit(centre / frame.voxel) * look.dustKey + skyIrradiance(vec3f(0.0, 1.0, 0.0)) * look.dustSky;
    out = vec4f(colour.rgb * light, colour.a);
  }
  lit[i] = Lit(centre, billboards[o + 3u], out);
}
