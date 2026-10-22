// Constants and small helpers every pass shares.

const FLAG_JITTER_OFF: u32 = 1u;
const FLAG_PYRAMID_OFF: u32 = 2u;
const FLAG_HISTORY_RESET: u32 = 4u;
const FLAG_DEBUG_SHADE: u32 = 8u;
const FLAG_BEAM_OFF: u32 = 16u;
// ReSTIR's neighbours do not share their picks, and its reservoirs are not carried from frame to
// frame (for tests: with both, plain resampling of each pixel's candidates).
const FLAG_SPATIAL_OFF: u32 = 32u;
const FLAG_RESERVOIR_HISTORY_OFF: u32 = 64u;

// The next of a sequence of random numbers in [0, 1): PCG (O'Neill 2014), from a state a pass seeds
// (from its pixel and the frame, say) and carries.
fn random(state: ptr<function, u32>) -> f32 {
  *state = *state * 747796405u + 2891336453u;
  let s = *state;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return f32(((w >> 22u) ^ w) >> 8u) * (1.0 / 16777216.0);
}

// A well-mixed 32-bit hash of a voxel cell: the probe's, for per-voxel variation.
fn hash3(p: vec3i) -> u32 {
  var h = (u32(p.x) * 73856093u) ^ (u32(p.y) * 19349663u) ^ (u32(p.z) * 83492791u);
  h = (h ^ (h >> 16u)) * 0x45d9f3bu;
  h = (h ^ (h >> 16u)) * 0x45d9f3bu;
  return h ^ (h >> 16u);
}
