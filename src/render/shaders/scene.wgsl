// Group 0, shared by every pass: the frame (its struct is generated from
// frame-uniforms.ts and prepended to each module) and the world's buffers.

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> table: array<u32>;
@group(0) @binding(2) var<storage, read> sectors: array<u32>;
@group(0) @binding(3) var<storage, read> heap: array<u32>;
// Two vec4s per palette entry: albedo (linear) and roughness, then emission and kind.
@group(0) @binding(4) var<storage, read> palette: array<vec4f>;
@group(0) @binding(5) var<storage, read> pyramid: array<u32>;
// The far field (see farfield-gpu.ts): prepared heights, their max mips, materials.
@group(0) @binding(7) var farHeights: texture_2d<f32>;
@group(0) @binding(8) var farMips: texture_2d<f32>;
@group(0) @binding(9) var farMaterials: texture_2d<u32>;

// Point lights (see lights.ts): position and radius in voxels, colour, intensity.
struct Light {
  pos: vec3f,
  radius: f32,
  colour: vec3f,
  intensity: f32,
}
@group(0) @binding(6) var<storage, read> lights: array<Light>;
// 64 × 64 blue-noise ranks (see bluenoise.ts).
@group(0) @binding(10) var blueNoise: texture_2d<u32>;
// The atmosphere's LUTs (see atmosphere.ts): transmittance, multiple scattering (read by hand) and
// the sky as this frame's camera sees it, read through atmosphere-model.wgsl with this linear sampler.
@group(0) @binding(11) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(12) var scatteringLut: texture_2d<f32>;
@group(0) @binding(13) var skyViewLut: texture_2d<f32>;
@group(0) @binding(14) var lutSampler: sampler;
