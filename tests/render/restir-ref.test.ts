import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { HISTORY_MAX, NONE, resample, share, type Pixel, type Reservoir } from '../support/restir-ref';

// Six lights a pixel's cell lists, each lighting it by its target (a light's estimate is f(y) × W,
// with f its target here), and two more that light it but are not in its list. And eight that
// reach no pixel here: listed with the others, they make a list longer than a frame's candidates,
// so its pixel merges its history and shares, rather than drawing its list whole.
const LIGHT: Record<number, number> = { 0: 3, 1: 0.5, 2: 0.05, 3: 1.2, 4: 0, 5: 7, 6: 2, 7: 4 };
const DARK = [100, 101, 102, 103, 104, 105, 106, 107];
const lit = (l: number) => LIGHT[l] ?? 0;
const few: Pixel = { list: [0, 1, 2, 3, 4, 5], target: lit, targetBefore: lit };
const still: Pixel = { list: [...few.list, ...DARK], target: lit, targetBefore: lit };
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
  it('resamples its candidates without bias: the mean estimate is the sum of the listed lights', () => {
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
    const now: Pixel = { list: still.list, target: (l) => (l === 5 ? 1 : l === 1 ? 6 : lit(l)), targetBefore: (l) => (l === 1 ? 0 : lit(l)) };
    const before: Pixel = { list: still.list, target: (l) => (l === 1 ? 0 : lit(l)), targetBefore: (l) => (l === 1 ? 0 : lit(l)) };
    const m = mean(1e5, (random) => {
      let r: Reservoir | null = null;
      for (let f = 0; f < 10; f++) r = resample(before, r, random);
      return estimate(now, resample(now, r, random));
    });
    expect(Math.abs(m / sum(now) - 1)).toBeLessThan(0.01);
  });

  it('keeps a history\'s light that has left the cell\'s list, counted by the history alone', () => {
    // Light 6 was listed last frame; now the list has moved on, though the light still reaches.
    const was: Pixel = { list: [1, 6, ...DARK], target: lit, targetBefore: lit };
    const now: Pixel = { list: [1, 7, ...DARK], target: lit, targetBefore: lit };
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
    const dark: Pixel = { list: [4, 4, 4, ...DARK], target: () => 0, targetBefore: () => 0 };
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

  it('shares neighbours\' picks without bias, where some neighbours could not have drawn the light', () => {
    // This pixel's lights 0-3; one neighbour has the same; one is reached by lights 2, 3 and 5 only
    // (5 not reaching this pixel); one by none.
    const here: Pixel = { list: [0, 1, 2, 3, ...DARK], target: (l) => (l <= 3 ? lit(l) : 0), targetBefore: (l) => (l <= 3 ? lit(l) : 0) };
    const same = here;
    const part: Pixel = { list: [2, 3, 5, ...DARK], target: (l) => ([2, 3, 5].includes(l) ? lit(l) * 1.5 : 0), targetBefore: () => 0 };
    const dark: Pixel = { list: [0, 1, ...DARK], target: () => 0, targetBefore: () => 0 };
    const m = mean(1e5, (random) => {
      const own = resample(here, null, random);
      const neighbours = [same, part, dark].map((p) => ({ reservoir: resample(p, null, random), target: p.target }));
      return estimate(here, share(here, own, neighbours, random));
    });
    expect(Math.abs(m / sum(here) - 1)).toBeLessThan(0.01);
  });

  it('shares a neighbour\'s pick that is far brighter here than where it was drawn without letting it swamp the rest', () => {
    // A neighbour where light 0 is a twentieth as bright as here: its picks of it carry a W twenty
    // times too large for here. Shared by equal shares (1 / Z) they make the estimate's spread far wider.
    const here: Pixel = { list: [0, 1, 3, 5, ...DARK], target: lit, targetBefore: lit };
    const far: Pixel = { list: [0, 1, 3, 5, ...DARK], target: (l) => (l === 0 ? LIGHT[0] / 20 : lit(l)), targetBefore: () => 0 };
    const rng = Rng.root(9).derive('test.restir.spread');
    const random = () => rng.float();
    let s1 = 0;
    let s2 = 0;
    const n = 4e4;
    for (let i = 0; i < n; i++) {
      const own = resample(here, null, random);
      const near = [far, far, far].map((p) => ({ reservoir: resample(p, null, random), target: p.target }));
      const e = estimate(here, share(here, own, near, random));
      s1 += e;
      s2 += e * e;
    }
    const m = s1 / n;
    expect(Math.abs(m / sum(here) - 1)).toBeLessThan(0.02);
    // The spread of one estimate over its mean.
    expect(Math.sqrt(s2 / n - m * m) / m).toBeLessThan(0.6);
  });

  it('stays unbiased frame after frame, each frame merging its own history and then sharing with its neighbours', () => {
    // A row of five pixels, each lit by its own mix of the lights; each frame every pixel resamples
    // with its history, then shares with the pixels either side; its history next frame is its own.
    const row: Pixel[] = [0, 1, 2, 3, 4].map((i) => {
      const here = (l: number) => (l === 5 && i > 2 ? 0 : lit(l) * (1 + 0.3 * Math.sin(i + l)));
      return { list: [...[0, 1, 2, 3, 5, 6].filter((l) => here(l) > 0 || l !== 5), ...DARK], target: here, targetBefore: here };
    });
    const m = mean(4000, (random) => {
      let histories: (Reservoir | null)[] = row.map(() => null);
      let shared: Reservoir[] = [];
      for (let f = 0; f < 12; f++) {
        const fresh = row.map((p, i) => resample(p, histories[i], random));
        shared = row.map((p, i) => {
          const near = [i - 1, i + 1].filter((j) => j >= 0 && j < row.length).map((j) => ({ reservoir: fresh[j], target: row[j].target }));
          return share(p, fresh[i], near, random);
        });
        histories = fresh;
      }
      return row.reduce((t, p, i) => t + estimate(p, shared[i]) / sum(p), 0) / row.length;
    });
    expect(Math.abs(m - 1)).toBeLessThan(0.015);
  });

  it('trusts a neighbour for one frame\'s candidates: a pixel whose own history is long is barely moved, a fresh one leans on its neighbours', () => {
    const here: Pixel = { list: [0, 1, 3, 5, ...DARK], target: lit, targetBefore: lit };
    const rng = Rng.root(13).derive('test.restir.trust');
    const random = () => rng.float();
    // A history of 160 for light 5, its W exact; a neighbour of 160 for light 0, its W exact.
    const own: Reservoir = { light: 5, weight: sum(here) / LIGHT[5], count: 168, target: LIGHT[5] };
    const near = [{ reservoir: { light: 0, weight: sum(here) / LIGHT[0], count: 168, target: LIGHT[0] }, target: here.target }];
    let kept = 0;
    for (let i = 0; i < 1e4; i++) if (share(here, own, near, random).light === 5) kept++;
    // Each light as bright at both pixels, the balance heuristic shares by confidence alone: its
    // own light 168 / 176 of the time.
    expect(Math.abs(kept / 1e4 - 168 / 176)).toBeLessThan(0.01);
    const fresh: Reservoir = { ...own, count: 8 };
    let leaned = 0;
    for (let i = 0; i < 1e4; i++) if (share(here, fresh, near, random).light === 0) leaned++;
    // Fresh, 8 against 8: the neighbour's light half the time.
    expect(Math.abs(leaned / 1e4 - 0.5)).toBeLessThan(0.02);
  });

  it('counts what an empty history stood for: a history restarted in a crowded cell is unbiased from its second frame', () => {
    // 32 lights listed, of which one (then three) reach the pixel: most frames' candidates miss
    // them, and a history that drew nothing still stood for its candidates.
    for (const reach of [[17], [3, 17, 29]]) {
      const lit = (l: number) => (reach.includes(l) ? 1 + l / 10 : 0);
      const crowd: Pixel = { list: Array.from({ length: 32 }, (_, i) => i), target: lit, targetBefore: lit };
      for (const frames of [2, 4, 8]) {
        const m = mean(4e4, (random) => {
          let r: Reservoir | null = null;
          for (let f = 0; f < frames; f++) r = resample(crowd, r, random);
          return estimate(crowd, r!);
        });
        expect(Math.abs(m / sum(crowd) - 1), `${reach.length} reaching, frame ${frames}`).toBeLessThan(0.02);
      }
    }
  });

  it('draws a list longer than its candidates in uneven stretches without bias: 9, 13 and 32 lights, one frame and several', () => {
    for (const n of [9, 13, 32]) {
      // Lights of very different strength, the strongest late in the list, where stretches differ in size.
      const lit = (l: number) => 0.2 + ((l * 7) % 5) * 0.6 + (l === n - 2 ? 5 : 0);
      const p: Pixel = { list: Array.from({ length: n }, (_, i) => i), target: lit, targetBefore: lit };
      for (const frames of [1, 6]) {
        const m = mean(4e4, (random) => {
          let r: Reservoir | null = null;
          for (let f = 0; f < frames; f++) r = resample(p, r, random);
          return estimate(p, r!);
        });
        expect(Math.abs(m / sum(p) - 1), `${n} lights, ${frames} frames`).toBeLessThan(0.015);
      }
    }
  });

  it('resamples a list no longer than its candidates exactly, every frame: each light drawn once, and nothing merged or shared that could only add noise', () => {
    // Lights of one colour, so a light's estimate is its target: exact means the list's own sum.
    const rng = Rng.root(17).derive('test.restir.exact');
    const random = () => rng.float();
    const neighbour: Pixel = { list: [0, 1, 3, 5, ...DARK], target: (l) => lit(l) * 2, targetBefore: (l) => lit(l) * 2 };
    let r: Reservoir | null = null;
    for (let f = 0; f < 20; f++) {
      r = resample(few, r, random);
      expect(estimate(few, r), `frame ${f}`).toBeCloseTo(sum(few), 9);
      const near = [{ reservoir: resample(neighbour, null, random), target: neighbour.target }];
      expect(estimate(few, share(few, r, near, random)), `shared, frame ${f}`).toBeCloseTo(sum(few), 9);
    }
  });
});

