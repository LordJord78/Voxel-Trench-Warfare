// The sky along each direction, read as shading reads it: skyViewSample through the scene's bindings.
#include "../../../src/render/shaders/scene.wgsl"
#include "../../../src/render/shaders/atmosphere-model.wgsl"
#include "../../../src/render/shaders/sky.wgsl"

@group(1) @binding(0) var<storage, read> dirs: array<vec4f>;
@group(1) @binding(1) var<storage, read_write> radiance: array<vec4f>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= arrayLength(&dirs)) {
    return;
  }
  radiance[g.x] = vec4f(skyViewSample(skyViewLut, lutSampler, frame.atmosphere, dirs[g.x].xyz, frame.atmosphere.sunDir, 0), 0.0);
}

// The colour height fog takes along each direction.
@compute @workgroup_size(64)
fn fog(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= arrayLength(&dirs)) {
    return;
  }
  radiance[g.x] = vec4f(fogColour(dirs[g.x].xyz), 0.0);
}

// The far field's light from distant shells' flashes: at each point (voxels, the even entries) facing
// its normal (the odd entries).
@compute @workgroup_size(64)
fn farLight(@builtin(global_invocation_id) g: vec3u) {
  let n = arrayLength(&dirs) / 2u;
  if (g.x >= n) {
    return;
  }
  radiance[g.x] = vec4f(horizonLight(dirs[2u * g.x].xyz, dirs[2u * g.x + 1u].xyz), 0.0);
}

// The sky with the sun's and moon's discs and the stars, along each direction.
@compute @workgroup_size(64)
fn bodies(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= arrayLength(&dirs)) {
    return;
  }
  radiance[g.x] = vec4f(skyWithBodies(dirs[g.x].xyz), 0.0);
}
