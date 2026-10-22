import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { HISTORY_MAX, NONE, resample, type Pixel, type Reservoir } from '../support/restir-ref';

// Six lights a pixel's cell lists, each lighting it by its target (a light's estimate is f(y) × W,
// with f its target here), and two more that light it but are not in its list.
const LIGHT: Record<number, number> = { 0: 3, 1: 0.5, 2: 0.05, 3: 1.2, 4: 0, 5: 7, 6: 2, 7: 4 };
const still: Pixel = { list: [0, 1, 2, 3, 4, 5], target: (l) => LIGHT[l], targetBefore: (l) => LIGHT[l] };
const sum = (p: Pixel) => p.list.reduce((s, l) => s + p.target(l), 0);
const estimate = (p: Pixel, r: Reservoir) => (r.light === NONE ? 0 : p.target(r.light) * r.weight);

function mean(trials: number, frames: (random: () => number) => number): number {
  const rng = Rng.root(11).derive('test.restir');
  const random = () => rng.float();
  let total = 0;
  for (let i = 0; i < trials; i++) total += frames(random);
  return total / trials;
}

describe('ReSTIR on the CPU', () => {
  it('resamples uniform candidates without bias: the mean estimate is the sum of the listed lights', () => {
    const m = mean(1e5, (random) => estimate(still, resample(still, null, random)));
    expect(Math.abs(m / sum(still) - 1)).toBeLessThan(0.01);
  });

  it('stays unbiased merging last frame\'s reservoir, frame after frame', () => {
    const m = mean(2e4, (random) => {
      let r: Reservoir | null = null;
      for (let f = 0; f < 30; f++) r = resample(still, r, random);
      return estimate(still, r!);
    });
    expect(Math.abs(m / sum(still) - 1)).toBeLessThan(0.01);
  });

  it('weighs a light that moved by where it is now, and one that came into reach only from now', () => {
    // Last frame light 5 lit the pixel at 7 and light 1 not at all; now light 5 lights it at 1 and light 1 at 6.
    const now: Pixel = { list: still.list, target: (l) => (l === 5 ? 1 : l === 1 ? 6 : LIGHT[l]), targetBefore: (l) => (l === 1 ? 0 : LIGHT[l]) };
    const before: Pixel = { list: still.list, target: (l) => (l === 1 ? 0 : LIGHT[l]), targetBefore: (l) => (l === 1 ? 0 : LIGHT[l]) };
    const m = mean(1e5, (random) => {
      let r: Reservoir | null = null;
      for (let f = 0; f < 10; f++) r = resample(before, r, random);
      return estimate(now, resample(now, r, random));
    });
    expect(Math.abs(m / sum(now) - 1)).toBeLessThan(0.01);
  });

  it('keeps a history\'s light that has left the cell\'s list, counted by the history alone', () => {
    // Light 6 was listed last frame; now the list has moved on, though the light still reaches.
    const was: Pixel = { list: [1, 6], target: (l) => LIGHT[l], targetBefore: (l) => LIGHT[l] };
    const now: Pixel = { list: [1, 7], target: (l) => LIGHT[l], targetBefore: (l) => LIGHT[l] };
    const m = mean(1e5, (random) => {
      let r: Reservoir | null = null;
      for (let f = 0; f < 10; f++) r = resample(was, r, random);
      const after = resample(now, r, random);
      return after.light === 6 ? estimate(now, after) : 0;
    });
    // Light 6's share of the history's light, carried over: the history's estimate of it (all of it, 2).
    const history = mean(1e5, (random) => {
      let r: Reservoir | null = null;
      for (let f = 0; f < 10; f++) r = resample(was, r, random);
      return r!.light === 6 ? estimate(was, r!) : 0;
    });
    expect(history).toBeGreaterThan(1.9);
    expect(m).toBeGreaterThan(0);
    expect(Math.abs(m / history - 1)).toBeLessThan(0.05);
  });

  it('never divides by a target of zero: no light lit means an empty reservoir, not a number that is not one', () => {
    const dark: Pixel = { list: [4, 4, 4], target: () => 0, targetBefore: () => 0 };
    const rng = Rng.root(3).derive('test.restir.dark');
    let r: Reservoir | null = null;
    for (let f = 0; f < 5; f++) {
      r = resample(dark, r, () => rng.float());
      expect(r.light).toBe(NONE);
      expect(r.weight).toBe(0);
    }
    // A history whose light has gone dark.
    const lit = resample(still, null, () => rng.float());
    const after = resample(dark, lit, () => rng.float());
    expect(after.light).toBe(NONE);
    expect(Number.isFinite(after.weight)).toBe(true);
    // An empty list and no history.
    expect(resample({ ...still, list: [] }, null, () => rng.float())).toEqual({ light: NONE, weight: 0, count: 0, target: 0 });
  });

  it('caps what a history stands for at 20 frames of candidates', () => {
    const rng = Rng.root(5).derive('test.restir.cap');
    const old: Reservoir = { light: 5, weight: 1 / 7, count: 1e6, target: 7 };
    const r = resample(still, old, () => rng.float());
    expect(r.count).toBe(8 + HISTORY_MAX);
    expect(HISTORY_MAX).toBe(160);
  });
});
