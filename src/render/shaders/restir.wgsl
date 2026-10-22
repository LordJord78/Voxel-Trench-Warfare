// ReSTIR DI (Bitterli et al. 2020): which point light each lighting pixel shades by this frame,
// and by how much. `candidates` draws CANDIDATES lights uniformly from the pixel's light cell and
// resamples them to one by their target, the light's unshadowed brightness at the pixel (RIS);
// then it merges last frame's reservoir for the same spot (the lighting pixel that saw it, as the
// denoiser's history finds it), weighing that reservoir's light by its target now, with the light
// where it is this frame. The lighting pass traces one shadow ray to the light and scales its
// light by the reservoir's weight W. W is normalised by Z, the candidates of the reservoirs that
// could have drawn the chosen light: this frame's if it is in the cell's list, the history's if it
// reached the pixel last frame. tests/support/restir-ref.ts is the same arithmetic on the CPU.
#include "light-cells.wgsl"
#include "traverse.wgsl"
#include "camera.wgsl"
#include "lightgrid.wgsl"
#include "history.wgsl"
#include "reservoir.wgsl"

const CANDIDATES: u32 = 8u;
// The most candidates a history stands for when it is merged: 20 frames' worth.
const HISTORY_MAX: f32 = 160.0;

@group(2) @binding(0) var gDepth: texture_2d<f32>;
@group(2) @binding(1) var gHit: texture_2d<u32>;
@group(2) @binding(2) var depthBefore: texture_2d<f32>;
@group(2) @binding(3) var hitBefore: texture_2d<u32>;
// The lights as they were last frame.
@group(2) @binding(4) var<storage, read> lightsBefore: array<Light>;
// Last frame's reservoirs.
@group(2) @binding(5) var<storage, read> previous: array<Reservoir>;
@group(2) @binding(6) var<storage, read_write> chosen: array<Reservoir>;

// A lighting pixel's random numbers this frame: PCG (O'Neill 2014), seeded from the pixel and frame.
fn random(state: ptr<function, u32>) -> f32 {
  *state = *state * 747796405u + 2891336453u;
  let s = *state;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return f32(((w >> 22u) ^ w) >> 8u) * (1.0 / 16777216.0);
}

fn targetOf(l: Light, at: vec3f, n: vec3f) -> f32 {
  return luminance(unshadowed(l, at, n));
}

// Whether the cell's list (its first `count`) holds light y.
fn inList(cell: i32, count: u32, y: u32) -> bool {
  for (var k = 0u; k < count; k++) {
    if (cellLight(cell, k) == y) {
      return true;
    }
  }
  return false;
}

// Last frame's reservoir for this spot: the lighting pixel nearest where the spot was, or the next
// of the four round it, that saw it; none if none did.
fn history(q: vec2u, face: u32, plane: i32, surface: vec3f, depth: f32) -> Reservoir {
  let grid = lastGrid(q, surface);
  let base = vec2i(floor(grid));
  let nearest = vec2i(grid - floor(grid) > vec2f(0.5));
  let size = lastGridSize();
  let reach = spotReach(depth);
  for (var k = 0; k < 4; k++) {
    let t = base + (nearest ^ vec2i(k & 1, k >> 1));
    if (any(t < vec2i(0)) || any(t >= size) || !sameSpot(t, face, plane, surface, reach)) {
      continue;
    }
    return previous[reservoirAt(vec2u(t))];
  }
  return Reservoir(NO_LIGHT, 0.0, 0.0, 0.0);
}

@compute @workgroup_size(8, 8)
fn candidates(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= frame.lightRes.x || g.y >= frame.lightRes.y) {
    return;
  }
  let slot = reservoirAt(g.xy);
  // The surface the lighting pass lights this frame: its representative pixel's.
  let p = representative(g.xy);
  let depth = textureLoad(gDepth, vec2i(p), 0).r;
  let hit = textureLoad(gHit, vec2i(p), 0).xy;
  let face = hitFace(hit);
  if (face >= 6u) {
    chosen[slot] = Reservoir(NO_LIGHT, 0.0, 0.0, 0.0);
    return;
  }
  let rd = cameraRay(frame.cam, vec2f(p) + 0.5 + frameJitter(), vec2f(frame.res));
  let n = faceNormal(face);
  let surface = frame.cam.origin + rd * depth;
  // Where the lighting pass weighs its light from, just off the face.
  let at = surface + n * 0.02;
  var state = hash3(vec3i(vec2i(g.xy), i32(frame.frame)));

  var light = NO_LIGHT;
  var luma = 0.0;
  var sum = 0.0;
  var fromHistory = false;
  let cell = cellOf(at);
  var listed = 0u;
  if (cell >= 0) {
    listed = cellCount(cell);
  }
  let draws = select(0u, CANDIDATES, listed > 0u);
  for (var k = 0u; k < draws; k++) {
    let x = cellLight(cell, min(u32(random(&state) * f32(listed)), listed - 1u));
    let t = targetOf(lights[x], at, n);
    // A candidate's weight: its target over the chance it was drawn, 1 / listed.
    let w = t * f32(listed);
    let pick = random(&state);
    if (!(w > 0.0)) {
      continue;
    }
    sum += w;
    if (pick * sum < w) {
      light = x;
      luma = t;
    }
  }
  let drawn = f32(draws);

  var kept = 0.0;
  if ((frame.flags & FLAG_HISTORY_RESET) == 0u) {
    let h = history(g.xy, face, hitPlane(hit), surface, depth);
    if (h.light < min(frame.lightCount, MAX_LIGHTS)) {
      kept = min(h.count, HISTORY_MAX);
      // Weighed by its target now, with its light where it is this frame.
      let t = targetOf(lights[h.light], at, n);
      let w = t * h.weight * kept;
      let pick = random(&state);
      if (w > 0.0 && w < 3.0e38) {
        sum += w;
        if (pick * sum < w) {
          light = h.light;
          luma = t;
          fromHistory = true;
        }
      }
    }
  }

  var z = 0.0;
  if (light != NO_LIGHT) {
    if (!fromHistory || inList(cell, listed, light)) {
      z += drawn;
    }
    if (targetOf(lightsBefore[light], at, n) > 0.0) {
      z += kept;
    }
  }
  if (!(z > 0.0)) {
    chosen[slot] = Reservoir(NO_LIGHT, 0.0, drawn + kept, 0.0);
    return;
  }
  chosen[slot] = Reservoir(light, sum / (z * luma), drawn + kept, luma);
}
