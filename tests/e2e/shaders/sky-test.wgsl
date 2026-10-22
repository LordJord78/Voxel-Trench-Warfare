// The sky along each direction, read as shading reads it: skyViewSample through the scene's bindings.
#include "../../../src/render/shaders/scene.wgsl"
#include "../../../src/render/shaders/atmosphere-model.wgsl"

@group(1) @binding(0) var<storage, read> dirs: array<vec4f>;
@group(1) @binding(1) var<storage, read_write> radiance: array<vec4f>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= arrayLength(&dirs)) {
    return;
  }
  radiance[g.x] = vec4f(skyViewSample(skyViewLut, lutSampler, frame.atmosphere, dirs[g.x].xyz), 0.0);
}
