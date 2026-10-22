// Constants and small helpers every pass shares.

const FLAG_JITTER_OFF: u32 = 1u;
const FLAG_PYRAMID_OFF: u32 = 2u;
const FLAG_HISTORY_RESET: u32 = 4u;
const FLAG_DEBUG_SHADE: u32 = 8u;
const FLAG_BEAM_OFF: u32 = 16u;
// ReSTIR's neighbours do not share their picks (for tests).
const FLAG_SPATIAL_OFF: u32 = 32u;

// A well-mixed 32-bit hash of a voxel cell: the probe's, for per-voxel variation.
fn hash3(p: vec3i) -> u32 {
  var h = (u32(p.x) * 73856093u) ^ (u32(p.y) * 19349663u) ^ (u32(p.z) * 83492791u);
  h = (h ^ (h >> 16u)) * 0x45d9f3bu;
  h = (h ^ (h >> 16u)) * 0x45d9f3bu;
  return h ^ (h >> 16u);
}
