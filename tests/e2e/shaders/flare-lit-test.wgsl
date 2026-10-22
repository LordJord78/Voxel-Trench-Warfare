// flareLit at each of a list of points (xyz) for a light (w, its index), for the flares' maps' tests.
#include "../../../src/render/shaders/key-shadow.wgsl"

@group(1) @binding(0) var<storage, read> points: array<vec4f>;
@group(1) @binding(1) var<storage, read_write> lit: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= arrayLength(&points)) {
    return;
  }
  lit[g.x] = flareLit(u32(points[g.x].w), points[g.x].xyz);
}
