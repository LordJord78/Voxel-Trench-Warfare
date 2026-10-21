/**
 * Blowing holes in things, and what falls in afterwards.
 *
 * Generation and runtime shelling call the same code, so a crater cut at load
 * behaves exactly like one cut at tick 40 000 — the rule the Python game's
 * `world/destruction.py` set, kept here at 10 cm.
 */

import type { Rng } from '../core/rng';
import type { BrickMap } from './bricks';
import { Region, clampBox, type Box } from './region';

export interface CarveOptions {
  /** What the cut leaves; air unless stated. */
  material?: number;
  /** Radius wobble as a fraction of the radius, so craters are not billiard balls. */
  roughness?: number;
  /** Indexed by palette id: 1 survives the cut (concrete against a light charge). */
  protect?: Uint8Array;
}

function smooth(f: number): number {
  return f * f * (3 - 2 * f);
}

/** Per-axis lattice coordinates for the wobble field, as Python's `np.linspace(0, n-1, extent)`. */
function lattice(size: number, extent: number, n: number): { i0: Int32Array; i1: Int32Array; f: Float64Array } {
  const i0 = new Int32Array(size);
  const i1 = new Int32Array(size);
  const f = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const t = (i / Math.max(1, extent - 1)) * (n - 1);
    const a = Math.floor(t);
    i0[i] = a;
    i1[i] = Math.min(a + 1, n - 1);
    f[i] = smooth(t - a);
  }
  return { i0, i1, f };
}

/**
 * Carve an irregular sphere centred on voxel-space (cx, cy, cz). Returns the
 * clamped box it touched, or null when it misses the world entirely.
 */
export function carveSphere(
  map: BrickMap,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  rng: Rng,
  opts: CarveOptions = {},
): Box | null {
  const material = opts.material ?? 0;
  const roughness = opts.roughness ?? 0.16;
  const protect = opts.protect;
  const rOut = radius * (1 + roughness) + 1;
  const box = clampBox(
    {
      x0: Math.floor(cx - rOut),
      y0: Math.floor(cy - rOut),
      z0: Math.floor(cz - rOut),
      x1: Math.ceil(cx + rOut) + 1,
      y1: Math.ceil(cy + rOut) + 1,
      z1: Math.ceil(cz + rOut) + 1,
    },
    map.dims,
  );
  if (!box) return null;

  const region = Region.extract(map, box);
  const { sx, sy, sz, data } = region;
  const extent = Math.max(sx, sy, sz);
  const n = Math.max(2, Math.floor(extent / 3));
  const grid = new Float64Array(n * n * n);
  for (let i = 0; i < grid.length; i++) grid[i] = rng.normal();
  const lx = lattice(sx, extent, n);
  const ly = lattice(sy, extent, n);
  const lz = lattice(sz, extent, n);
  const scale = roughness * radius;
  const at = (x: number, y: number, z: number) => grid[(z * n + y) * n + x];

  let i = 0;
  for (let z = 0; z < sz; z++) {
    const dz = box.z0 + z + 0.5 - cz;
    const z0 = lz.i0[z], z1 = lz.i1[z], fz = lz.f[z];
    for (let y = 0; y < sy; y++) {
      const dy = box.y0 + y + 0.5 - cy;
      const y0 = ly.i0[y], y1 = ly.i1[y], fy = ly.f[y];
      for (let x = 0; x < sx; x++, i++) {
        const dx = box.x0 + x + 0.5 - cx;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const x0 = lx.i0[x], x1 = lx.i1[x], fx = lx.f[x];
        const c00 = at(x0, y0, z0) * (1 - fx) + at(x1, y0, z0) * fx;
        const c10 = at(x0, y1, z0) * (1 - fx) + at(x1, y1, z0) * fx;
        const c01 = at(x0, y0, z1) * (1 - fx) + at(x1, y0, z1) * fx;
        const c11 = at(x0, y1, z1) * (1 - fx) + at(x1, y1, z1) * fx;
        const c0 = c00 * (1 - fy) + c10 * fy;
        const c1 = c01 * (1 - fy) + c11 * fy;
        const wobble = (c0 * (1 - fz) + c1 * fz) * scale;
        if (dist >= radius + wobble) continue;
        if (protect && protect[data[i]]) continue;
        data[i] = material;
      }
    }
  }
  region.commit(map);
  return box;
}
