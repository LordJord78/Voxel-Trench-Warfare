import { describe, expect, it } from 'vitest';
import { PEAK_RADIUS_M, PEAK_RANGE_M, percentile, shellPoint, shellRadius } from '../../src/app/peak-combat';

// Peak combat (the combat spec's done table, row 6): shells landing 20–50 m off at one a second,
// each 2.2–3.4 m, on the map whatever the player's place; and the statistics a peak is judged by.
describe('peak combat', () => {
  it("shells fall 20–50 m off, turning off the map's edge onto it, or are skipped", () => {
    const from = [100, 5, 100];
    const seen = new Set<string>();
    for (let k = 0; k < 20; k++) {
      const p = shellPoint(k, from, () => true)!;
      const d = Math.hypot(p[0] - from[0], p[1] - from[2]);
      expect(d, `shell ${k}`).toBeGreaterThanOrEqual(PEAK_RANGE_M[0] - 1e-9);
      expect(d, `shell ${k}`).toBeLessThanOrEqual(PEAK_RANGE_M[1] + 1e-9);
      expect(shellRadius(k)).toBeGreaterThanOrEqual(PEAK_RADIUS_M[0]);
      expect(shellRadius(k)).toBeLessThanOrEqual(PEAK_RADIUS_M[1]);
      seen.add(p.map((v) => v.toFixed(1)).join(','));
    }
    expect(seen.size).toBe(20);
    // Ten metres from the map's edge (z < 0 is off it): every shell still lands on the map.
    const edge = [100, 5, 10];
    for (let k = 0; k < 20; k++) {
      const p = shellPoint(k, edge, (_x, z) => z >= 0);
      expect(p, `shell ${k}`).not.toBeNull();
      expect(p![1]).toBeGreaterThanOrEqual(0);
    }
    // Nowhere to land: skipped, never thrown.
    expect(shellPoint(3, from, () => false)).toBeNull();
  });

  it('percentiles', () => {
    const ten = [7, 2, 9, 1, 10, 4, 3, 8, 6, 5];
    expect(percentile([5, 1, 4, 2, 3], 0.5)).toBe(3);
    expect(percentile(ten, 0.5)).toBe(6);
    expect(percentile(ten, 0.95)).toBe(10);
    expect(percentile(ten, 0)).toBe(1);
    expect(percentile(ten, 1)).toBe(10);
    expect(percentile([], 0.5)).toBeNaN();
  });
});
