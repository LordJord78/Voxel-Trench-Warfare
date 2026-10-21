import { describe, expect, it } from 'vitest';
import { DynamicResolution } from '../../src/render/dynres';

/** A GPU whose frame costs 20 ms at full resolution, falling with pixel count. */
const costAt = (full: number) => (scale: number) => full * scale * scale;

describe('dynamic resolution', () => {
  it('settles where the frame fits the budget without wasting it', () => {
    const d = new DynamicResolution(14);
    const cost = costAt(20);
    for (let f = 0; f < 300; f++) d.update(cost(d.scale));
    expect(cost(d.scale)).toBeLessThanOrEqual(14);
    expect(cost(d.scale)).toBeGreaterThan(14 * 0.8);
  });
  it('never leaves 50–100% per axis', () => {
    const slow = new DynamicResolution(14);
    for (let f = 0; f < 600; f++) slow.update(200);
    expect(slow.scale).toBe(0.5);
    const fast = new DynamicResolution(14);
    for (let f = 0; f < 600; f++) fast.update(1);
    expect(fast.scale).toBe(1);
  });
  it('ignores a frame that took a second: a hidden tab, not a slow GPU', () => {
    const d = new DynamicResolution(14);
    for (let f = 0; f < 300; f++) d.update(f % 10 === 0 ? 1000 : 5);
    expect(d.scale).toBe(1);
  });
  it('stays at full resolution when there is room', () => {
    const d = new DynamicResolution(14);
    const cost = costAt(5);
    for (let f = 0; f < 300; f++) d.update(cost(d.scale));
    expect(d.scale).toBe(1);
  });
});
