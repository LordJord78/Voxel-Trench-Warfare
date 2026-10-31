// The soldiers' depth into the G-buffer's, over each one's box (soldiers.wgsl wrote it, 0 where the
// world is drawn): after this the rifle, the effects and readDepth see a soldier where it is nearer.

@group(0) @binding(0) var<uniform> draw: SoldierDraw;
@group(0) @binding(1) var soldierDepth: texture_2d<f32>;
@group(0) @binding(2) var gDepth: texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn merge(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= draw.box.z || g.y >= draw.box.w) {
    return;
  }
  let px = vec2i(draw.box.xy + g.xy);
  let depth = textureLoad(soldierDepth, px, 0).r;
  if (depth > 0.0) {
    textureStore(gDepth, px, vec4f(depth, 0.0, 0.0, 0.0));
  }
}
