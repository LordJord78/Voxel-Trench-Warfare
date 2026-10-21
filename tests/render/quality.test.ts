import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../src/core/tunables';
import { LIGHT_SCALE, rendererTunables, scaledSize } from '../../src/render/quality';

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
    });
  });
});
