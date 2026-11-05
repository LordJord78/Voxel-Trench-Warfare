import { describe, expect, it } from 'vitest';
import { loadTunables, Tunables } from '../../src/core/tunables';
import { desaturateKneeOf } from '../../src/render/renderer';

// Suppression's grey spares light shown near the tone curve's top ([suppression] desaturate_knee): the
// present pass greys a pixel by 1 − smoothstep(kneeLo, kneeHi, its brightest channel). WGSL's smoothstep
// is undefined where its ends meet, so the renderer holds the knee's top a thousandth over its foot.

/** The tunables with the knee set to `knee`. */
function withKnee(knee: [number, number]): Tunables {
  const raw = loadTunables().raw() as { suppression: Record<string, unknown> };
  raw.suppression.desaturate_knee = knee;
  return new Tunables(raw);
}

describe("suppression's grey: the knee where it spares light", () => {
  it('a knee whose ends are apart is read as it is', () => {
    expect(desaturateKneeOf(withKnee([1, 4]))).toEqual([1, 4]);
    expect(desaturateKneeOf(withKnee([0.5, 0.502]))).toEqual([0.5, 0.502]);
  });

  it('an equal-ended knee, or one closer than a thousandth, has its top held a thousandth over its foot', () => {
    const [lo, hi] = desaturateKneeOf(withKnee([2, 2]));
    expect(lo).toBe(2);
    expect(hi).toBeCloseTo(2.001, 12);
    const [lo2, hi2] = desaturateKneeOf(withKnee([1, 1.0004]));
    expect(lo2).toBe(1);
    expect(hi2).toBeCloseTo(1.001, 12);
  });
});
