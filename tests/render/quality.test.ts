import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../src/core/tunables';
import { FROXEL_COLUMNS, LIGHT_SCALE, rendererTunables, scaledSize, SKY_VIEW_SIZE } from '../../src/render/quality';

describe('quality', () => {
  it('lights a quarter of the pixels on high and a sixteenth on low', () => {
    expect(LIGHT_SCALE.high).toBe(2);
    expect(LIGHT_SCALE.low).toBe(4);
  });
  it('scales the internal image per axis, never below a pixel', () => {
    expect(scaledSize([1633, 919], 1)).toEqual([1633, 919]);
    expect(scaledSize([1633, 919], 0.5)).toEqual([817, 460]);
    expect(scaledSize([1633, 919], 0.75)).toEqual([1225, 689]);
    expect(scaledSize([1, 1], 0.5)).toEqual([1, 1]);
  });
  it('reads the renderer settings from the tunables', () => {
    expect(rendererTunables(loadTunables())).toEqual({
      megapixels: 1.5,
      uploadBudget: 1024 * 1024,
      budgetMs: 14,
      denoise: { historyMax: 32, sigmaLuma: 4, sigmaPlane: 1 },
      sharpness: 0.4,
      bloomWeight: 0.04,
      bloomMax: 30000,
      // The exposure's adaptation: the approved views' norm and zone, and the eye's rates.
      exposureTarget: -2.92,
      exposureZone: 1.88,
      adaptToDarker: 1,
      adaptToBrighter: 3,
      // Earth's atmosphere as Hillaire (2020) gives it, with a ground albedo of 0.3.
      atmosphere: {
        bottom: 6360,
        top: 6460,
        rayleigh: [5.802e-3, 13.558e-3, 33.1e-3],
        rayleighHeight: 8,
        mieScattering: 3.996e-3,
        mieExtinction: 4.44e-3,
        mieHeight: 1.2,
        mieG: 0.8,
        ozone: [0.65e-3, 1.881e-3, 0.085e-3],
        ozoneCentre: 25,
        ozoneHalfWidth: 15,
        albedo: 0.3,
      },
    });
  });
});

describe('the presets beyond the lighting scale', () => {
  it('give the low preset half the froxel grid across and down, and a sky view of 96 × 54', () => {
    expect(FROXEL_COLUMNS).toEqual({ high: [160, 90], low: [80, 45] });
    expect(SKY_VIEW_SIZE).toEqual({ high: [192, 108], low: [96, 54] });
  });
});
