import { describe, expect, it } from 'vitest';
import { bloom, level } from '../support/bloom-ref';

/** A `w` × `h` image of `base` with one texel of `point` at (x, y). */
function image(w: number, h: number, base: number, point = 0, x = 0, y = 0) {
  const v = new Float64Array(w * h).fill(base);
  v[y * w + x] += point;
  return level(w, h, v);
}
const sum = (v: Float64Array) => v.reduce((a, b) => a + b, 0);

describe('the bloom reference', () => {
  it("keeps a point's energy and a flat field's, each half-size texel standing for four of the image's", () => {
    const point = bloom(image(1024, 768, 0, 30000, 512, 384));
    expect(Math.abs((4 * sum(point.v)) / 30000 - 1)).toBeLessThan(1e-9);
    const flat = bloom(image(1024, 768, 0.25));
    for (const v of flat.v) expect(Math.abs(v - 0.25)).toBeLessThan(1e-12);
  });

  it('spreads a point into a halo that falls with distance and reaches far: a fifth of its light beyond 32 pixels', () => {
    const b = bloom(image(1024, 768, 0, 30000, 512, 384));
    // Along the row through the point, at half resolution: never rising outward, never negative.
    const row = Array.from({ length: 128 }, (_, i) => b.v[192 * b.w + 256 + i]);
    for (let i = 1; i < row.length; i++) expect(row[i]).toBeLessThanOrEqual(row[i - 1] + 1e-12);
    expect(b.v.reduce((a, v) => Math.min(a, v), Infinity)).toBeGreaterThanOrEqual(0);
    // Beyond 32 image pixels (16 at half resolution).
    let far = 0;
    for (let j = 0; j < b.h; j++) for (let i = 0; i < b.w; i++) if (Math.hypot(i + 0.5 - 256, j + 0.5 - 192) > 16) far += b.v[j * b.w + i];
    expect(far / sum(b.v)).toBeGreaterThan(0.2);
  });
});
