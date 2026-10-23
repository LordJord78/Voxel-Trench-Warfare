// The rifle's depth into the G-buffer's, over its box (rifle.wgsl wrote it, 0 where the world is
// drawn): after this, everything that reads the frame's depth (the effects' test, readDepth) sees
// the rifle where it is nearer.

@group(0) @binding(0) var<uniform> rifle: Rifle;
@group(0) @binding(1) var rifleDepth: texture_2d<f32>;
@group(0) @binding(2) var gDepth: texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn merge(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= rifle.box.z || g.y >= rifle.box.w) {
    return;
  }
  let px = vec2i(rifle.box.xy + g.xy);
  let depth = textureLoad(rifleDepth, px, 0).r;
  if (depth > 0.0) {
    textureStore(gDepth, px, vec4f(depth, 0.0, 0.0, 0.0));
  }
}
