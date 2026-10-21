import { describe, expect, it } from 'vitest';
import { frameBudget, passTimes } from '../../src/render/timing';

describe('the frame budget dynamic resolution holds', () => {
  it('is the GPU budget when passes are timed', () => {
    expect(frameBudget(true, 14)).toBe(14);
  });
  it('without timestamps, reads a frame that keeps up with 60 Hz as room to grow and one that misses every other refresh as over', () => {
    const budget = frameBudget(false, 14);
    expect(1000 / 60).toBeLessThan(budget * 0.8);
    expect(2000 / 60).toBeGreaterThan(budget * 1.05);
  });
  it('never asks intervals for less than the GPU budget', () => {
    expect(frameBudget(false, 40)).toBe(40);
  });
});

const ms = 1e6;

describe('pass times', () => {
  it('are each pass from start to end, and the frame from the first start to the last end', () => {
    const t = passTimes([
      { name: 'primary', begin: 0, end: 3 * ms },
      { name: 'shade', begin: 3 * ms, end: 4 * ms },
      { name: 'present', begin: 4.5 * ms, end: 5 * ms },
    ]);
    expect(t.passes).toEqual({ primary: 3, shade: 1, present: 0.5 });
    expect(t.frameMs).toBe(5);
  });
  it('do not charge a pass the GPU began early for waiting on the passes before it', () => {
    // A tile-based GPU starts the present pass's vertex work while the compute passes still run.
    const t = passTimes([
      { name: 'primary', begin: 0, end: 3 * ms },
      { name: 'cas', begin: 3 * ms, end: 7 * ms },
      { name: 'present', begin: 1 * ms, end: 8 * ms },
    ]);
    expect(t.passes.present).toBe(1);
    expect(t.frameMs).toBe(8);
  });
  it('skip a pass whose timestamps are missing', () => {
    const t = passTimes([
      { name: 'primary', begin: 0, end: 3 * ms },
      { name: 'lighting', begin: 0, end: 0 },
      { name: 'shade', begin: 3 * ms, end: 4 * ms },
    ]);
    expect(t.passes).toEqual({ primary: 3, shade: 1 });
    expect(t.frameMs).toBe(4);
  });
  it('report no frame when nothing was timed', () => {
    expect(passTimes([]).frameMs).toBeNull();
  });
});
