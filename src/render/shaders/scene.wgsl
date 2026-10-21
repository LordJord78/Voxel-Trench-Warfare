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
