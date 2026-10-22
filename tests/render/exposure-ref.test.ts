import { describe, expect, it } from 'vitest';
import { adapt, binOf, centre, histogram, meteredMean, zoneCorrection } from '../support/exposure-ref';

describe('the exposure reference', () => {
  it('counts each finite, positive pixel in its bin of log2 luminance under the base exposure, the ends held', () => {
    expect(binOf(1, 1)).toBe(96);
    expect(binOf(0.5, 2)).toBe(96);
    expect(binOf(2 ** -20, 1)).toBe(0);
    expect(binOf(2 ** 10, 1)).toBe(127);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(binOf(bad, 1)).toBeNull();
    expect(histogram([1, 1, 0.5, Number.NaN], 1).reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('meters the mean between the darkest half and the brightest 2%', () => {
    // Half the frame in one bin and half in a brighter one: the band is all the brighter bin.
    const counts = new Array(128).fill(0);
    counts[40] = 500;
    counts[90] = 500;
    expect(meteredMean(counts, 0)).toBeCloseTo(centre(90), 12);
    // A few very bright pixels (under 2%) do not move it.
    counts[127] = 15;
    expect(meteredMean(counts, 0)).toBeCloseTo(centre(90), 12);
    // Nothing counted: the given value.
    expect(meteredMean(new Array(128).fill(0), 1.5)).toBe(1.5);
  });

  it('corrects only beyond the zone, by the excess', () => {
    expect(zoneCorrection(0, 0.9, 1)).toBe(0);
    expect(zoneCorrection(0, -0.9, 1)).toBe(0);
    expect(zoneCorrection(0, 3, 1)).toBe(-2);
    expect(zoneCorrection(0, -3, 1)).toBe(2);
  });

  it('adapts at its rates: down three stops a second to a brighter scene, up one to a darker, and lands on the want', () => {
    expect(adapt(0, -4, 0.1, 1, 3)).toBeCloseTo(-0.3, 12);
    expect(adapt(0, 4, 0.1, 1, 3)).toBeCloseTo(0.1, 12);
    expect(adapt(-3.9, -4, 0.1, 1, 3)).toBe(-4);
    expect(adapt(3.95, 4, 0.1, 1, 3)).toBe(4);
  });
});
