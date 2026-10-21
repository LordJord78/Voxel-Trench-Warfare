// The global palette: two vec4s per entry (see materials.ts paletteData).
#include "scene.wgsl"

fn albedoOf(m: u32) -> vec3f {
  return palette[m * 2u].rgb;
}

fn roughnessOf(m: u32) -> f32 {
  return palette[m * 2u].a;
}

fn emissionOf(m: u32) -> vec3f {
  return palette[m * 2u + 1u].rgb;
}

fn kindOf(m: u32) -> u32 {
  return u32(palette[m * 2u + 1u].a);
}
