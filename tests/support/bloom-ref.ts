/**
 * The bloom pyramid (bloom.wgsl) in f64, sampled as the GPU samples it: each tap bilinear in its
 * level, its position held within the level's rendered texels, so an edge texel's neighbour is
 * itself. One channel; the GPU filters each alike.
 */

export interface Level {
  w: number;
  h: number;
  v: Float64Array;
}

/** A level `w` × `h` from row-major values. */
export function level(w: number, h: number, v: ArrayLike<number>): Level {
  return { w, h, v: Float64Array.from(v) };
}

/** The level bilinear at (x, y) in its texel units (a texel's centre at i + 0.5), the position held within its texels' centres. */
function bilinear(l: Level, x: number, y: number): number {
  const fx = Math.min(Math.max(x, 0.5), l.w - 0.5) - 0.5;
  const fy = Math.min(Math.max(y, 0.5), l.h - 0.5) - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const [tx, ty] = [fx - x0, fy - y0];
  const at = (i: number, j: number) => l.v[Math.min(j, l.h - 1) * l.w + Math.min(i, l.w - 1)];
  const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
  const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
  return top * (1 - ty) + bottom * ty;
}

/**
 * Half the size (rounded up): Jimenez's 13 taps round each texel's 2 × 2 block, five 4 × 4 boxes
 * weighted 1/2 and 1/8 each, no tap brighter than `cap`.
 */
export function down(src: Level, cap = Infinity): Level {
  const w = Math.ceil(src.w / 2);
  const h = Math.ceil(src.h / 2);
  const v = new Float64Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const [cx, cy] = [2 * i + 1, 2 * j + 1];
      const s = (dx: number, dy: number) => Math.min(bilinear(src, cx + dx, cy + dy), cap);
      const inner = (s(-1, -1) + s(1, -1) + s(-1, 1) + s(1, 1)) / 4;
      const g = s(0, 0);
      const corners =
        (s(-2, -2) + s(0, -2) + s(-2, 0) + g) / 4 +
        (s(0, -2) + s(2, -2) + g + s(2, 0)) / 4 +
        (s(-2, 0) + g + s(-2, 2) + s(0, 2)) / 4 +
        (g + s(2, 0) + s(0, 2) + s(2, 2)) / 4;
      v[j * w + i] = 0.5 * inner + 0.125 * corners;
    }
  }
  return { w, h, v };
}

/**
 * The mean of `fine` and the `count` levels `coarse` (half its size) is the mean of, brought up to it
 * through a 3 × 3 tent of bilinear taps a coarse texel apart. A mean, not a sum: summed, six levels
 * of the sun's disc (30,000) pass half floats' 65,504.
 */
export function up(coarse: Level, fine: Level, count: number): Level {
  const v = new Float64Array(fine.w * fine.h);
  const weights = [1, 2, 1];
  for (let j = 0; j < fine.h; j++) {
    for (let i = 0; i < fine.w; i++) {
      const [x, y] = [(i + 0.5) / 2, (j + 0.5) / 2];
      let sum = 0;
      for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) sum += (weights[a + 1] * weights[b + 1] * bilinear(coarse, x + a, y + b)) / 16;
      v[j * fine.w + i] = (fine.v[j * fine.w + i] + count * sum) / (count + 1);
    }
  }
  return { w: fine.w, h: fine.h, v };
}

/** The pyramid's top: `levels` levels down from `image` (the first's taps no brighter than `cap`), and back up to the first (half the image): their mean. */
export function bloom(image: Level, levels = 6, cap = Infinity): Level {
  const downs: Level[] = [];
  let at = image;
  for (let k = 0; k < levels; k++) downs.push((at = down(at, k === 0 ? cap : Infinity)));
  let acc = downs[levels - 1];
  for (let k = levels - 2; k >= 0; k--) acc = up(acc, downs[k], levels - 1 - k);
  return acc;
}
