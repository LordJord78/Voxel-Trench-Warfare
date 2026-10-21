/**
 * The far field as the GPU marches it. Heights are samples at cell centres;
 * the ground between four neighbouring samples is their bilinear patch. Inside
 * the map the samples are -Infinity (the voxel world is there instead), and a
 * patch exists only where all four corners are ground.
 *
 * The max mips bound every patch from above: level 0 holds each patch's
 * highest corner (the bilinear surface never rises above its corners), each
 * level up the max of the four cells below, down to a single cell.
 */

/**
 * The heights with ground carried one ring of samples into the map, so the
 * last full patch reaches under the voxel world's edge instead of stopping a
 * metre short of it and leaving a crack.
 */
export function prepareFarHeights(heights: Float32Array, size: number): Float32Array {
  const out = heights.slice();
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      if (heights[j * size + i] !== -Infinity) continue;
      let sum = 0;
      let n = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const x = i + di;
          const z = j + dj;
          if (x < 0 || z < 0 || x >= size || z >= size) continue;
          const h = heights[z * size + x];
          if (h === -Infinity) continue;
          sum += h;
          n++;
        }
      }
      if (n > 0) out[j * size + i] = sum / n;
    }
  }
  return out;
}

/** Level 0 to 1 × 1, as `size >> k` square grids, from prepared heights. */
export function farFieldMips(heights: Float32Array, size: number): Float32Array[] {
  const at = (i: number, j: number) => heights[Math.min(j, size - 1) * size + Math.min(i, size - 1)];
  const base = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i, j + 1);
      const d = at(i + 1, j + 1);
      base[j * size + i] = Math.min(a, b, c, d) === -Infinity ? -Infinity : Math.max(a, b, c, d);
    }
  }
  const levels = [base];
  for (let n = size >> 1; n >= 1; n >>= 1) {
    const below = levels[levels.length - 1];
    const level = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const r = 2 * j * 2 * n + 2 * i;
        level[j * n + i] = Math.max(below[r], below[r + 1], below[r + 2 * n], below[r + 2 * n + 1]);
      }
    }
    levels.push(level);
  }
  return levels;
}
