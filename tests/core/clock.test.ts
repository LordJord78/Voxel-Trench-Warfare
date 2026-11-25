import { describe, expect, it } from 'vitest';
import { FixedClock, FrameStats } from '../../src/core/clock';

describe('FixedClock', () => {
  it('turns wall time into whole ticks with an interpolation fraction', () => {
    const c = new FixedClock();
    expect(c.advance(1 / 60)).toBe(1);
    expect(c.advance(0.5 / 60)).toBe(0);
    expect(c.alpha).toBeCloseTo(0.5, 9);
    expect(c.advance(0.5 / 60)).toBe(1);
    expect(c.tick).toBe(2);
    expect(c.simTime).toBeCloseTo(2 / 60, 12);
  });
  it('caps catch-up at maxSubsteps and counts the dropped ticks', () => {
    const c = new FixedClock(60, 5);
    expect(c.advance(0.2)).toBe(5);
    expect(c.droppedTicks).toBe(7);
  });
  it('clamps stalls to 0.25 s', () => {
    const c = new FixedClock(60, 100);
    expect(c.advance(10)).toBe(15);
  });
  it("settle() puts the leftover at a share of a tick (half, unless given): a tick's frames then run one tick each, never 0 and 2", () => {
    // A frozen test page's frames (main.ts freeze()) are a tick apart: from whatever leftover the clock
    // had, the sum's rounding could split them 0 and 2 ticks. Settled at half, each runs one, at alpha 0.5.
    for (const leftover of [0, 1e-12, 0.5 / 60 - 1e-15, 1 / 60 - 1e-15]) {
      const c = new FixedClock();
      c.advance(1 / 60 + leftover);
      c.settle();
      expect(c.alpha).toBe(0.5);
      const ticks = c.tick;
      for (let f = 1; f <= 600; f++) {
        expect(c.advance(1 / 60), `frame ${f}`).toBe(1);
        expect(c.alpha, `frame ${f}`).toBeCloseTo(0.5, 9);
      }
      expect(c.tick).toBe(ticks + 600);
    }
    // At a 240 Hz display's quarter tick a frame: a tick every fourth frame, the alphas 0.75, 0, 0.25, 0.5.
    const fast = new FixedClock();
    fast.advance(0.3 / 60);
    fast.settle();
    const steps = Array.from({ length: 8 }, () => [fast.advance(1 / 240), +fast.alpha.toFixed(9)]);
    expect(steps).toEqual([[0, 0.75], [1, 0], [0, 0.25], [0, 0.5], [0, 0.75], [1, 0], [0, 0.25], [0, 0.5]]);
    // Another share, as asked.
    const quarter = new FixedClock();
    quarter.settle(0.25);
    expect(quarter.alpha).toBe(0.25);
    expect([quarter.advance(0.75 / 60), quarter.alpha]).toEqual([1, 0]);
  });
  it('runs nothing for negative or NaN deltas', () => {
    const c = new FixedClock();
    expect(c.advance(-1)).toBe(0);
    expect(c.advance(NaN)).toBe(0);
    expect(c.alpha).toBe(0);
    expect(c.advance(1 / 60)).toBe(1);
  });
});

describe('FrameStats', () => {
  it('summarises a rolling window in milliseconds', () => {
    const s = new FrameStats(4);
    for (const t of [0.010, 0.020, 0.030, 0.040, 0.050]) s.record(t);
    const r = s.summary();
    expect(r.mean).toBeCloseTo(35, 9);
    expect(r.max).toBeCloseTo(50, 9);
    expect(r.p50).toBeCloseTo(40, 9);
    expect(new FrameStats().summary().fps).toBe(0);
  });
});
