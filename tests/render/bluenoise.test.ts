import { describe, expect, it } from 'vitest';
import { blueNoise } from '../../src/render/bluenoise';

describe('blue noise', () => {
  const ranks = blueNoise(64);
  it('ranks every pixel once', () => {
    expect(Array.from(ranks).sort((a, b) => a - b)).toEqual(Array.from({ length: 4096 }, (_, i) => i));
  });
  it('spreads each threshold evenly: far fewer solid 2 × 2 blocks than white noise leaves', () => {
    // At a 50% threshold, white noise leaves 1 block in 8 all on or all off: 128 of 1024.
    let solid = 0;
    for (let y = 0; y < 64; y += 2) {
      for (let x = 0; x < 64; x += 2) {
        const on = [ranks[y * 64 + x], ranks[y * 64 + x + 1], ranks[(y + 1) * 64 + x], ranks[(y + 1) * 64 + x + 1]].filter((r) => r < 2048).length;
        if (on === 0 || on === 4) solid++;
      }
    }
    expect(solid).toBeLessThan(64);
  });
  it('is the same pattern every time', () => {
    expect(Array.from(blueNoise(64))).toEqual(Array.from(ranks));
  });
});
