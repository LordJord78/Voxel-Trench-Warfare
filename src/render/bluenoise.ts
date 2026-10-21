/**
 * Blue noise by void and cluster (Ulichney 1993): a ranking of a square's
 * pixels such that every threshold of it is evenly spread, with no clumps and
 * no gaps. The lighting pass draws its random numbers from it, so the noise
 * the denoiser starts with is fine-grained, and the present pass dithers with
 * it. Gaussian energy with σ 1.5 on a torus; deterministic.
 */

import { Rng } from '../core/rng';

export function blueNoise(size = 64): Uint16Array {
  const n = size * size;
  const sigma = 1.5;
  const reach = 6;
  const kernel: { dx: number; dy: number; w: number }[] = [];
  for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) kernel.push({ dx, dy, w: Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma)) });
  const energy = new Float64Array(n);
  const on = new Uint8Array(n);
  const splat = (p: number, sign: number) => {
    const x = p % size;
    const y = (p - x) / size;
    for (const k of kernel) energy[((y + k.dy + size) % size) * size + ((x + k.dx + size) % size)] += sign * k.w;
  };
  const extreme = (want: number, highest: boolean) => {
    let best = -1;
    let value = highest ? -Infinity : Infinity;
    for (let p = 0; p < n; p++) {
      if (on[p] !== want) continue;
      if (highest ? energy[p] > value : energy[p] < value) {
        value = energy[p];
        best = p;
      }
    }
    return best;
  };

  // A random tenth to start, relaxed until moving its tightest point to the largest gap changes nothing.
  const rng = Rng.root(1).derive('bluenoise');
  let ones = 0;
  while (ones < Math.floor(n / 10)) {
    const p = rng.randint(0, n - 1);
    if (on[p]) continue;
    on[p] = 1;
    splat(p, 1);
    ones++;
  }
  for (;;) {
    const tight = extreme(1, true);
    on[tight] = 0;
    splat(tight, -1);
    const gap = extreme(0, false);
    on[gap] = 1;
    splat(gap, 1);
    if (gap === tight) break;
  }

  const rank = new Uint16Array(n);
  const start = on.slice();
  const startEnergy = energy.slice();
  // The starting points, ranked from the last to remove down to the first.
  for (let r = ones - 1; r >= 0; r--) {
    const tight = extreme(1, true);
    on[tight] = 0;
    splat(tight, -1);
    rank[tight] = r;
  }
  // Then every other pixel, ranked as it fills the largest gap left.
  on.set(start);
  energy.set(startEnergy);
  for (let r = ones; r < n; r++) {
    const gap = extreme(0, false);
    on[gap] = 1;
    splat(gap, 1);
    rank[gap] = r;
  }
  return rank;
}
