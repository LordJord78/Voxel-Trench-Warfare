// The light cells (see light-cells.ts): a grid of 8 m squares over the map's x and z, each listing
// the lights whose sphere reaches its square, at most CELL_LIGHTS, nearest its middle first (the
// lower index first between lights as near). A cell is the whole column over its square, so a
// light reaches it if its radius reaches the square across x and z, however high it hangs. `build`
// fills the grid every frame; the passes that draw their lights from it include this file and read
// it through cellOf, cellCount and cellLight.
#include "scene.wgsl"

const CELL_LIGHTS: u32 = 32u;

struct CellGrid {
  size: vec2u,
  // A cell's side, in voxels.
  side: f32,
  lightCount: u32,
}

struct Cell {
  count: u32,
  lights: array<u32, CELL_LIGHTS>,
}

@group(1) @binding(0) var<uniform> grid: CellGrid;
@group(1) @binding(1) var<storage, read_write> cells: array<Cell>;

// The cell a point (voxels) stands in, or -1 off the map (or not a number).
fn cellOf(p: vec3f) -> i32 {
  let c = floor(p.xz / grid.side);
  if (!(all(c >= vec2f(0.0)) && all(c < vec2f(grid.size)))) {
    return -1;
  }
  let i = vec2u(c);
  return i32(i.y * grid.size.x + i.x);
}

// How many lights a cell lists, and its k-th (k below that).
fn cellCount(cell: i32) -> u32 {
  return cells[cell].count;
}

fn cellLight(cell: i32, k: u32) -> u32 {
  return cells[cell].lights[k];
}

// Whether a light reaches the square from lo to hi: the square's nearest point to it, across x and
// z, within its radius (not at it, where its light is nothing). A light that is not a number
// reaches nothing.
fn reaches(p: vec2f, r: f32, lo: vec2f, hi: vec2f) -> bool {
  let e = p - clamp(p, lo, hi);
  return e.x * e.x + e.y * e.y < r * r;
}

// Whether a light at distance² `key` with index `id` comes before one at (k, i).
fn before(key: f32, id: u32, k: f32, i: u32) -> bool {
  return key < k || (key == k && id < i);
}

// A workgroup builds a block of 2 × 2 cells. First its threads weigh the lights between them: a
// light that reaches the block at all is weighed for each of its cells, and one that reaches a
// cell is gathered into that cell's share of workgroup memory with its distance from the cell's
// middle. Then 32 threads to a cell put its lights in order: each light's place is its rank among
// them by (distance, index), and the nearest CELL_LIGHTS write themselves to their places. A cell
// more lights reach than its share holds ranks them from the lights themselves, slowly but exactly.
const GATHERED: u32 = 128u;

var<workgroup> gatheredKey: array<array<f32, GATHERED>, 4>;
var<workgroup> gatheredId: array<array<u32, GATHERED>, 4>;
var<workgroup> gatheredCount: array<atomic<u32>, 4>;

@compute @workgroup_size(128)
fn build(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let blockLo = vec2f(wg.xy * 2u) * grid.side;
  let blockHi = blockLo + 2.0 * grid.side;
  let total = min(grid.lightCount, MAX_LIGHTS);
  for (var i = li; i < total; i += 128u) {
    let p = lights[i].pos.xz;
    let r = lights[i].radius;
    if (!reaches(p, r, blockLo, blockHi)) {
      continue;
    }
    for (var c = 0u; c < 4u; c++) {
      let lo = blockLo + vec2f(f32(c & 1u), f32(c >> 1u)) * grid.side;
      if (reaches(p, r, lo, lo + grid.side)) {
        let slot = atomicAdd(&gatheredCount[c], 1u);
        if (slot < GATHERED) {
          let m = p - (lo + 0.5 * grid.side);
          gatheredKey[c][slot] = m.x * m.x + m.y * m.y;
          gatheredId[c][slot] = i;
        }
      }
    }
  }
  workgroupBarrier();
  let c = li >> 5u;
  let lane = li & 31u;
  let at = wg.xy * 2u + vec2u(c & 1u, c >> 1u);
  if (any(at >= grid.size)) {
    return;
  }
  let cell = at.y * grid.size.x + at.x;
  let lo = vec2f(at) * grid.side;
  let mid = lo + 0.5 * grid.side;
  let n = atomicLoad(&gatheredCount[c]);
  if (n <= GATHERED) {
    // This lane's lights, the k-th gathered for k = lane, lane + 32, lane + 64 and lane + 96 (as
    // many as there are), weighed against the cell's others in one walk through them.
    var key: array<f32, 4>;
    var id: array<u32, 4>;
    var place = vec4u(0u);
    for (var q = 0u; q < 4u; q++) {
      key[q] = gatheredKey[c][lane + 32u * q];
      id[q] = gatheredId[c][lane + 32u * q];
    }
    for (var j = 0u; j < n; j++) {
      let kj = gatheredKey[c][j];
      let ij = gatheredId[c][j];
      place += vec4u(
        u32(before(kj, ij, key[0], id[0])),
        u32(before(kj, ij, key[1], id[1])),
        u32(before(kj, ij, key[2], id[2])),
        u32(before(kj, ij, key[3], id[3])),
      );
    }
    for (var q = 0u; q < 4u; q++) {
      if (lane + 32u * q < n && place[q] < CELL_LIGHTS) {
        cells[cell].lights[place[q]] = id[q];
      }
    }
  } else {
    for (var i = lane; i < total; i += 32u) {
      let p = lights[i].pos.xz;
      if (!reaches(p, lights[i].radius, lo, lo + grid.side)) {
        continue;
      }
      let m = p - mid;
      let key = m.x * m.x + m.y * m.y;
      var place = 0u;
      for (var j = 0u; j < total && place < CELL_LIGHTS; j++) {
        let q = lights[j].pos.xz;
        let o = q - mid;
        place += u32(reaches(q, lights[j].radius, lo, lo + grid.side) && before(o.x * o.x + o.y * o.y, j, key, i));
      }
      if (place < CELL_LIGHTS) {
        cells[cell].lights[place] = i;
      }
    }
  }
  if (lane == 0u) {
    cells[cell].count = min(n, CELL_LIGHTS);
  }
}
