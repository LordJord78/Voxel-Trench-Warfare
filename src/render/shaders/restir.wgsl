// ReSTIR DI (Bitterli et al. 2020): which point light each lighting pixel shades by this frame,
// and by how much. `candidates` draws CANDIDATES lights from the pixel's light cell, one from each
// of CANDIDATES equal stretches of its list (which runs nearest first, so every frame draws from
// near and far alike; a list no longer than that has each light drawn once), and resamples them
// to one by their target, the light's unshadowed brightness at the pixel (RIS);
// then it merges last frame's reservoir for the same spot (the lighting pixel that saw it, as the
// denoiser's history finds it), weighing that reservoir's light by its target now, with the light
// where it is this frame. `spatial` then shares in the reservoirs of NEIGHBOURS lighting pixels
// near it on the same face and plane. The lighting pass traces one shadow ray to the light and
// scales its light by the reservoir's weight W. In the temporal merge W is normalised by Z, the
// candidates of the reservoirs that could have drawn the chosen light (this frame's if it is in
// the cell's list, the history's if the light reached where the history was drawn, last frame). The spatial merge
// weighs each reservoir's light by the generalised balance heuristic (Lin et al. 2022): its share
// of that light among the reservoirs, by their confidence and the light's target at their pixels,
// so a light far brighter here than where a neighbour drew it does not swamp the rest. A pixel's
// own reservoir is trusted for the candidates it stands for, a neighbour's for one frame's at
// most: its history is for its own pixel. And a pixel's history next frame is its own temporal
// reservoir, not the shared one, so a neighbour's light never settles into it. (Shared reservoirs
// fed back measured three to five times the error of the temporal merge alone where the
// neighbours' lights differ much, as on a floor seen whole from 5 m with lights 2 m up.)
// A list no longer than CANDIDATES is drawn whole, every light once: its reservoir is exact for
// its target, and it merges no history and shares in no neighbours, which could only add noise.
// tests/support/restir-ref.ts is the same arithmetic on the CPU.
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
// A temporal reservoir as `candidates` leaves it, with where it was drawn: the point the light was
// weighed at (voxels, just off the face) and the face and plane it lies on, packed (surfaceOf);
// face 6 where the pixel sees the sky.
struct Drawn {
  reservoir: Reservoir,
  at: vec3f,
  surface: u32,
}

fn surfaceOf(face: u32, plane: i32) -> u32 {
  return face | (u32(plane) << 3u);
}

// The bit a Drawn's surface carries where its cell's list was drawn whole.
const WHOLE: u32 = 0x80000000u;

// Last frame's temporal reservoirs, and this frame's: `candidates` writes them, `spatial` shares
// them between neighbours.
@group(2) @binding(5) var<storage, read> previous: array<Drawn>;
@group(2) @binding(8) var<storage, read_write> drawn: array<Drawn>;
@group(2) @binding(7) var<storage, read> fresh: array<Drawn>;
// The shared reservoirs the lighting pass shades by, which `spatial` writes.
@group(2) @binding(6) var<storage, read_write> chosen: array<Reservoir>;

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

// Last frame's reservoir for this spot, with where it was drawn: the lighting pixel nearest where
// the spot was, or the next of the four round it, that saw it; none if none did. (Far off, it may
// lie on another of the rough ground's faces: see sameSpot.)
fn history(q: vec2u, face: u32, plane: i32, surface: vec3f, depth: f32) -> Drawn {
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
  return Drawn(Reservoir(NO_LIGHT, 0.0, 0.0, 0.0), vec3f(0.0), 6u);
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
    drawn[slot] = Drawn(Reservoir(NO_LIGHT, 0.0, 0.0, 0.0), vec3f(0.0), 6u);
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
  let draws = min(listed, CANDIDATES);
  let whole = listed > 0u && listed <= CANDIDATES;
  for (var k = 0u; k < draws; k++) {
    // Stretch k of the list, and a light from it.
    let lo = k * listed / draws;
    let size = (k + 1u) * listed / draws - lo;
    let x = cellLight(cell, lo + min(u32(random(&state) * f32(size)), size - 1u));
    let t = targetOf(lights[x], at, n);
    // A candidate's weight: its target over the chance it was drawn, 1 / size.
    let w = t * f32(size);
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
  // The candidates as one reservoir standing for a frame's worth of them: its weight among the
  // reservoirs merged is its sum (Σw over its target being its W) times what it stands for.
  let tried = select(0.0, f32(CANDIDATES), listed > 0u);
  sum *= tried;

  var kept = 0.0;
  // Where the history was drawn last frame, and its face's normal.
  var then = vec3f(0.0);
  var nThen = n;
  if (!whole && (frame.flags & (FLAG_HISTORY_RESET | FLAG_RESERVOIR_HISTORY_OFF)) == 0u) {
    let past = history(g.xy, face, hitPlane(hit), surface, depth);
    let h = past.reservoir;
    then = past.at;
    nThen = faceNormal(min(past.surface & 7u, 5u));
    // It stands for its candidates whether or not they drew a light (none if no spot was found).
    kept = min(h.count, HISTORY_MAX);
    if (h.light < min(frame.lightCount, MAX_LIGHTS)) {
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
      z += tried;
    }
    // The history could have drawn it if it reached where the history was drawn, last frame.
    if (targetOf(lightsBefore[light], then, nThen) > 0.0) {
      z += kept;
    }
  }
  // The face and plane it lies on, for its neighbours; and whether its list was drawn whole.
  let lies = surfaceOf(face, hitPlane(hit)) | select(0u, WHOLE, whole);
  if (!(z > 0.0)) {
    drawn[slot] = Drawn(Reservoir(NO_LIGHT, 0.0, tried + kept, 0.0), at, lies);
    return;
  }
  drawn[slot] = Drawn(Reservoir(light, sum / (z * luma), tried + kept, luma), at, lies);
}

// Lighting pixels whose reservoirs a pixel shares in, and how far off they may be, in lighting pixels.
const NEIGHBOURS: u32 = 3u;
const NEIGHBOUR_REACH: f32 = 12.0;

// Neighbour k of lighting pixel q this frame, uniform in a disc NEIGHBOUR_REACH across: its
// reservoir, trusted for one frame's candidates at most, and the point it was drawn at; or an
// empty one off the grid, at q itself, or off q's face and plane (`surface`).
struct Pooled {
  reservoir: Reservoir,
  at: vec3f,
}

fn neighbour(q: vec2u, k: u32, surface: u32, here: vec3f) -> Pooled {
  var state = hash3(vec3i(vec2i(q), i32(frame.frame * NEIGHBOURS + k) ^ 0x5bd1e995));
  let radius = NEIGHBOUR_REACH * sqrt(random(&state));
  let a = 6.2831853 * random(&state);
  let t = vec2i(q) + vec2i(round(radius * vec2f(cos(a), sin(a))));
  let none = Pooled(Reservoir(NO_LIGHT, 0.0, 0.0, 0.0), here);
  if (any(t < vec2i(0)) || any(t >= vec2i(frame.lightRes)) || all(t == vec2i(q))) {
    return none;
  }
  let d = fresh[reservoirAt(vec2u(t))];
  if ((d.surface & ~WHOLE) != (surface & ~WHOLE)) {
    return none;
  }
  var r = d.reservoir;
  r.count = min(r.count, f32(CANDIDATES));
  return Pooled(r, d.at);
}

@compute @workgroup_size(8, 8)
fn spatial(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= frame.lightRes.x || g.y >= frame.lightRes.y) {
    return;
  }
  let slot = reservoirAt(g.xy);
  let drew = fresh[slot];
  let own = drew.reservoir;
  let face = drew.surface & 7u;
  if ((frame.flags & FLAG_SPATIAL_OFF) != 0u || face >= 6u || (drew.surface & WHOLE) != 0u) {
    chosen[slot] = own;
    return;
  }
  // The reservoirs pooled: its own first, then a slot for each neighbour (empty if it is none).
  // On one face, all have its normal.
  let here = Pooled(own, drew.at);
  let n = faceNormal(face);
  var pool: array<Pooled, 4>;
  pool[0] = here;
  for (var k = 0u; k < NEIGHBOURS; k++) {
    pool[k + 1u] = neighbour(g.xy, k, drew.surface, drew.at);
  }
  var state = hash3(vec3i(vec2i(g.xy), i32(frame.frame) ^ 0x2c1b3c6d));
  var light = NO_LIGHT;
  var luma = 0.0;
  var sum = 0.0;
  var count = 0.0;
  for (var i = 0u; i < 4u; i++) {
    let r = pool[i].reservoir;
    count += r.count;
    if (r.light >= min(frame.lightCount, MAX_LIGHTS)) {
      continue;
    }
    let l = lights[r.light];
    // Its light's target here: its own reservoir's was weighed here this frame.
    var t = r.luma;
    if (i != 0u) {
      t = targetOf(l, here.at, n);
    }
    // This reservoir's share of its light among them all, by their candidates and the light's
    // target at each one's point (at its own, the target it was chosen by).
    var among = 0.0;
    for (var j = 0u; j < 4u; j++) {
      let c = pool[j].reservoir.count;
      if (!(c > 0.0)) {
        continue;
      }
      var tj = 0.0;
      if (j == i) {
        tj = r.luma;
      } else if (j == 0u) {
        tj = t;
      } else {
        tj = targetOf(l, pool[j].at, n);
      }
      among += c * tj;
    }
    let w = r.count * r.luma / among * t * r.weight;
    let pick = random(&state);
    if (!(w > 0.0) || !(w < 3.0e38)) {
      continue;
    }
    sum += w;
    if (pick * sum < w) {
      light = r.light;
      luma = t;
    }
  }
  if (light == NO_LIGHT) {
    chosen[slot] = Reservoir(NO_LIGHT, 0.0, count, 0.0);
    return;
  }
  chosen[slot] = Reservoir(light, sum / luma, count, luma);
}
