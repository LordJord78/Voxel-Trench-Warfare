import { describe, expect, it } from 'vitest';
import { pickPreset } from '../../src/app/tiers';

// The warm-up (the showcase spec's §4): the frames it judges, and when it moves a first visit to low.
describe('the warm-up', () => {
  const frames = (scale: number, gpuMs: number | null, n = 60) => Array.from({ length: n }, () => ({ scale, gpuMs }));

  it('the low preset when every judged frame sat at the floor and their median is over the budget, else none', () => {
    expect(pickPreset(frames(0.5, 20), 14)).toBe('low');
    // Over the budget, but dynamic resolution still has room above its floor.
    expect(pickPreset(frames(0.75, 20), 14)).toBeNull();
    // At the floor, and within the budget.
    expect(pickPreset(frames(0.5, 12), 14)).toBeNull();
    // A frame off the floor: not every frame sat at it.
    expect(pickPreset([...frames(0.5, 20, 59), { scale: 0.53125, gpuMs: 20 }], 14)).toBeNull();
    // The median, not the mean: a few slow frames do not move it.
    expect(pickPreset([...frames(0.5, 10, 50), ...frames(0.5, 100, 10)], 14)).toBeNull();
  });

  it('frames without a GPU time do not count, and under 30 that do move nothing', () => {
    expect(pickPreset([...frames(0.5, 20, 29), ...frames(0.5, null, 31)], 14)).toBeNull();
    expect(pickPreset([...frames(0.5, 20, 30), ...frames(0.5, null, 30)], 14)).toBe('low');
    expect(pickPreset([], 14)).toBeNull();
  });
});
