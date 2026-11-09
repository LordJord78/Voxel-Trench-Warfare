import { describe, expect, it } from 'vitest';
import { BACKSTOP, bloodVoxels, crop, magnify, SHOTS, strip, wallBox, ZOOM } from '../../tools/lib/hit-measures.mjs';

// G3's proof (tools/hit-captures.mjs, npm run hit-captures; the shots spec's §4): a torso hit and a
// headshot on the range's 25 m dummy at dusk, frame by frame, and the spatter on the backstop behind
// it. What it photographs, where it builds the backstop, and how its zoomed strips are cut. Read on
// synthetic images and boxes.

/** A w × h image whose pixel (x, y) is [x, y, x + y]. */
function ramp(w: number, h: number) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([x, y, x + y, 255], (y * w + x) * 4);
  return { data, w, h };
}

const px = (img: { data: Uint8Array; w: number }, x: number, y: number) => Array.from(img.data.subarray((y * img.w + x) * 4, (y * img.w + x) * 4 + 4));

describe("G3's proof: what it photographs", () => {
  it("a torso hit (frames 0, 2 and 6) and then a headshot (0, 2, 6 and 20) from an M4 on the 25 m dummy, at its chest 1.2 m and its head 1.62 m over its feet; the headshot's kill as the range's word gives it", () => {
    expect(SHOTS).toEqual([
      { name: 'torso', gun: 'm4', aimM: 1.2, zone: 'torso', frames: [0, 2, 6], kills: false },
      { name: 'head', gun: 'm4', aimM: 1.62, zone: 'head', frames: [0, 2, 6, 20], kills: true },
    ]);
  });

  it("the zoom: 360 × 280 of the frame about the crosshair, 70 px more under it than over it (the words and the readout), at 2×", () => {
    expect(ZOOM).toEqual({ w: 360, h: 280, below: 70, scale: 2 });
  });
});

describe("G3's proof: the backstop", () => {
  // Voxels of a quarter metre: every edge below falls on a sum exact in binary.
  const V = 0.25;
  const wall = { behindM: 1.5, halfWidthM: 1.5, aboveM: 2.4, belowM: 0.6, thickM: 0.4 };

  it('sandbags 2 m past the feet, 0.4 m deep, 1.5 m either side, from 0.6 m under the feet to 2.4 m over them', () => {
    expect(BACKSTOP).toEqual({ behindM: 2, halfWidthM: 1.5, aboveM: 2.4, belowM: 0.6, thickM: 0.4 });
  });

  it('a wall square to the line of fire across the axis nearer it, its near face `behindM` past the feet, as wide (about the feet), high and deep as asked, out to whole voxels', () => {
    // From the eye to the feet along +z (a little to −x): across x, from 26.5 to 26.9 m in z.
    expect(wallBox([10.25, 3.5, 0], [10, 2, 25], wall, V)).toEqual([34, 5, 106, 46, 18, 108]);
    // Along −x: across z, from 13.5 back to 13.1 m in x.
    expect(wallBox([40, 1, 7], [15, 3, 7.5], wall, V)).toEqual([52, 9, 24, 54, 22, 36]);
  });

  it("the blood voxels round the dummy, on the backstop and off it: each kept with its shade, counted by where it lies", () => {
    const box = [0, 0, 10, 10, 10, 12];
    const found = bloodVoxels(
      [
        [1, 1, 10, 85],
        [5, 2, 11, 85],
        [3, 0, 5, 83],
        [4, 0, 6, 83],
        [4, 1, 6, 83],
      ],
      box,
    );
    expect(found).toEqual({ wall: 2, ground: 3, byShade: { 85: 2, 83: 3 } });
  });
});

describe("G3's proof: the zoomed strips", () => {
  it('a crop keeps the pixels inside it, and fills what lies outside the frame with the back', () => {
    const img = ramp(8, 6);
    const c = crop(img, 2, 1, 3, 2);
    expect([c.w, c.h]).toEqual([3, 2]);
    expect(px(c, 0, 0)).toEqual([2, 1, 3, 255]);
    expect(px(c, 2, 1)).toEqual([4, 2, 6, 255]);
    const off = crop(img, -1, 5, 2, 2);
    expect(px(off, 0, 0)).toEqual([24, 24, 24, 255]);
    expect(px(off, 1, 0)).toEqual([0, 5, 5, 255]);
    expect(px(off, 1, 1)).toEqual([24, 24, 24, 255]);
  });

  it('magnified k times, each pixel a k × k block', () => {
    const m = magnify(ramp(2, 2), 3);
    expect([m.w, m.h]).toEqual([6, 6]);
    for (const [x, y, src] of [[0, 0, [0, 0, 0]], [2, 2, [0, 0, 0]], [3, 0, [1, 0, 1]], [5, 5, [1, 1, 2]], [0, 4, [0, 1, 1]]] as const) expect(px(m, x, y)).toEqual([...src, 255]);
  });

  it('a strip: the frames left to right, `gap` apart and from the edges, on the back', () => {
    const a = crop(ramp(4, 4), 0, 0, 2, 3);
    const b = crop(ramp(4, 4), 2, 1, 2, 2);
    const s = strip([a, b], 1);
    expect([s.w, s.h]).toEqual([1 + 2 + 1 + 2 + 1, 1 + 3 + 1]);
    expect(px(s, 0, 0)).toEqual([24, 24, 24, 255]);
    expect(px(s, 1, 1)).toEqual([0, 0, 0, 255]);
    expect(px(s, 2, 3)).toEqual([1, 2, 3, 255]);
    expect(px(s, 3, 1)).toEqual([24, 24, 24, 255]);
    expect(px(s, 4, 1)).toEqual([2, 1, 3, 255]);
    // The shorter frame's rows under it are the back.
    expect(px(s, 4, 3)).toEqual([24, 24, 24, 255]);
  });
});
