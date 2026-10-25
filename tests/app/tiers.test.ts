import { describe, expect, it } from 'vitest';
import { pickPreset, Warmup, WARMUP_FRAMES } from '../../src/app/tiers';
import { DynamicResolution } from '../../src/render/dynres';

// The warm-up (the showcase spec's §4): the frames it judges, and when it moves a first visit to low.
describe('the warm-up', () => {
  const frames = (scale: number, gpuMs: number | null, n = 60) => Array.from({ length: n }, () => ({ scale, gpuMs }));

  it("low when the floor could not hold the budget: each measured frame's time scaled to the floor's pixels, their median over it", () => {
    expect(pickPreset(frames(0.5, 20), 14)).toBe('low');
    // At the floor, and within the budget.
    expect(pickPreset(frames(0.5, 12), 14)).toBeNull();
    // Above the floor, its pixels counted down to the floor's: 20 ms at 0.75 is 8.9 ms there.
    expect(pickPreset(frames(0.75, 20), 14)).toBeNull();
    // Too slow at any scale: 300 ms at full size is 75 ms at the floor (dynamic resolution ignores such frames, as a hidden tab's).
    expect(pickPreset(frames(1, 300), 14)).toBe('low');
    // The median, not the mean: a few slow frames do not move it.
    expect(pickPreset([...frames(0.5, 10, 50), ...frames(0.5, 100, 10)], 14)).toBeNull();
  });

  it('frames without a GPU time do not count, and under 30 that do move nothing', () => {
    expect(pickPreset([...frames(0.5, 20, 29), ...frames(0.5, null, 31)], 14)).toBeNull();
    expect(pickPreset([...frames(0.5, 20, 30), ...frames(0.5, null, 30)], 14)).toBe('low');
    expect(pickPreset([], 14)).toBeNull();
  });

  /**
   * The warm-up as the page runs it: dynamic resolution taking each frame's GPU time `lag` frames late
   * (the timestamps' readback), a GPU whose frame costs `fixed` + `variable` × scale², and the warm-up
   * judging what it was given.
   */
  function warmUp(fixed: number, variable: number, lag: number, budget = 14) {
    const dynres = new DynamicResolution(budget);
    const warmup = new Warmup();
    const cost: number[] = [];
    for (let n = 0; n < WARMUP_FRAMES; n++) {
      const measured = n >= lag ? cost[n - lag] : null;
      if (measured !== null) dynres.update(measured);
      const scale = dynres.scale;
      cost.push(fixed + variable * scale * scale);
      warmup.frame(scale, measured);
    }
    expect(warmup.done).toBe(true);
    return warmup.pick(budget);
  }

  it('moves a machine the floor cannot hold, whatever the timestamps lag, and never one it can', () => {
    for (const lag of [1, 2, 3]) {
      // 40 and 48 ms at full size: 20.5 and 18 ms at the floor.
      expect(warmUp(14, 26, lag), `40 ms, lag ${lag}`).toBe('low');
      expect(warmUp(8, 40, lag), `48 ms, lag ${lag}`).toBe('low');
      // Slower than dynamic resolution heeds (250 ms).
      expect(warmUp(20, 300, lag), `320 ms, lag ${lag}`).toBe('low');
      // 24 ms at full size, 10.5 at the floor: dynamic resolution holds it.
      expect(warmUp(6, 18, lag), `24 ms, lag ${lag}`).toBeNull();
      // A fast machine.
      expect(warmUp(3, 7, lag), `10 ms, lag ${lag}`).toBeNull();
    }
  });
});
