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
