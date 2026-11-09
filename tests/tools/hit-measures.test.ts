import { describe, expect, it } from 'vitest';
import { BACKSTOP, BURST, bloodDisc, bloodVoxels, changedPixels, clusters, discMask, crop, DUMMY, dummyCorners, GATES, magnify, NEAR_BACKSTOP, ringClear, screenBox, SHOTS, strip, wallBox, zoneOf, ZOOM } from '../../tools/lib/hit-measures.mjs';

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

describe("G3's proof: its gates (G3 Task 6)", () => {
  it('the gates: the burst seen at frame 2 (40 px for a torso hit, 80 for a headshot, a pixel changed by 16 of 255 in any channel, where its blood is drawn and 1.5 px round it), the ring clear of the dummy by frame 6, a splat of 6 at 2 m and at 0.9 m', () => {
    expect(BURST).toEqual({ frame: 2, threshold: 16, margin: 1.5, px: { torso: 40, head: 80 } });
    expect(GATES).toEqual({ ringFrame: 6, cluster: 6 });
    // The nearer backstop: a trench's back wall, about a metre behind the head; the rest as the first.
    expect(NEAR_BACKSTOP).toEqual({ ...BACKSTOP, behindM: 0.9 });
    // The dummy as it stands, for its box on the screen: 0.4 m either side of its feet, 1.9 m tall.
    expect(DUMMY).toEqual({ halfWidthM: 0.4, heightM: 1.9 });
  });

  it("the pixels a burst changes: those within the box where some channel differs by the threshold or more; alpha and what lies outside the box are no matter", () => {
    const a = ramp(8, 6);
    const b = { data: Uint8Array.from(a.data), w: 8, h: 6 };
    const set = (x: number, y: number, rgba: number[]) => b.data.set(rgba, (y * 8 + x) * 4);
    set(1, 1, [1 + 16, 1, 2, 255]); // red by 16: changed
    set(2, 1, [2, 1 + 15, 3, 255]); // green by 15: not
    set(3, 2, [3, 2, 0, 255]); // blue by 5 the other way: not
    set(4, 2, [0, 2, 6, 255]); // red by 4: not
    set(5, 3, [5, 3, 8 - 20, 255]); // blue down by 20: changed
    set(2, 2, [2, 2, 4, 0]); // alpha alone: not
    set(7, 5, [200, 200, 200, 255]); // outside the box: not counted
    expect(changedPixels(a, b, [0, 0, 7, 5], 16)).toBe(2);
    expect(changedPixels(a, b, [0, 0, 8, 6], 16)).toBe(3);
    expect(changedPixels(a, b, [0, 0, 8, 6], 4)).toBe(6);
    // A box past the frame's edge is cut to it.
    expect(changedPixels(a, b, [5, 3, 10, 10], 16)).toBe(2);
    expect(() => changedPixels(a, ramp(7, 6), [0, 0, 1, 1], 16)).toThrow(/size/);
  });

  it("where a blood billboard is drawn: its disc on the screen by the frame's camera, at least a pixel across, BURST's margin round it; none behind the camera", () => {
    // Looking along +z from the origin, 90° across a 200 × 100 frame: 100 px a metre at 1 m.
    const pose = { position: [0, 0, 0], yaw: 0, pitch: 0 };
    const near = bloodDisc(pose, [200, 100], { at: [0.1, 0, 1], half: 0.05 })!;
    expect(near.cx).toBeCloseTo(110, 9);
    expect(near.cy).toBeCloseTo(50, 9);
    expect(near.r).toBeCloseTo(5 + 1.5, 9);
    // At 25 m a 1.5 cm half is 0.06 px: held to half a pixel, and the margin.
    expect(bloodDisc(pose, [200, 100], { at: [0, 0, 25], half: 0.015 })!.r).toBeCloseTo(0.5 + 1.5, 9);
    // A narrower field of view draws it larger: 60° across, tan 30°.
    expect(bloodDisc({ ...pose, fov: 60 }, [200, 100], { at: [0, 0, 1], half: 0.05 })!.r).toBeCloseTo(5 / Math.tan(Math.PI / 6) + 1.5, 9);
    expect(bloodDisc(pose, [200, 100], { at: [0, 0, -1], half: 0.05 })).toBeNull();
  });

  it('the discs as a mask: the pixels whose middles lie within any of them, cut to the frame; the changed pixels counted only inside it when given', () => {
    const mask = discMask([{ cx: 2, cy: 2, r: 1.2 }, { cx: 7.5, cy: 5.5, r: 1 }, { cx: 2.5, cy: 2.5, r: 0.6 }], 8, 6);
    // (2, 2)'s disc takes the middles (1.5, 1.5), (2.5, 1.5), (1.5, 2.5), (2.5, 2.5); the third adds none; (7.5, 5.5)'s takes its own pixel and those beside it in the frame.
    const on = [] as string[];
    for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) if (mask.data[y * 8 + x]) on.push(`${x},${y}`);
    expect(on.sort()).toEqual(['1,1', '1,2', '2,1', '2,2', '6,5', '7,4', '7,5'].sort());
    expect(mask.count).toBe(7);
    const a = ramp(8, 6);
    const b = { data: Uint8Array.from(a.data), w: 8, h: 6 };
    for (const [x, y] of [[1, 1], [3, 3], [7, 5]]) b.data.set([255, 255, 255, 255], (y * 8 + x) * 4);
    expect(changedPixels(a, b, [0, 0, 8, 6], 16)).toBe(3);
    expect(changedPixels(a, b, [0, 0, 8, 6], 16, mask)).toBe(2);
  });

  it('clusters: voxels joined by a shared face are one (6-connected); an edge or a corner alone is not; their sizes, the largest first', () => {
    expect(clusters([])).toEqual([]);
    const plus = [[5, 5, 5], [4, 5, 5], [6, 5, 5], [5, 4, 5], [5, 6, 5]];
    // Dots touching at their corners on a wall's face (an edge in 3D) read as dots, not a splat.
    const diagonal = [[0, 0, 0], [1, 1, 0], [2, 2, 0]];
    const corner = [[20, 20, 20], [21, 21, 21]];
    expect(clusters([...plus, ...diagonal, ...corner])).toEqual([5, 1, 1, 1, 1, 1]);
    // A checkerboard on a face: no two share a face, so 8 dots, not a cluster of 8.
    const checker = [];
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) if ((x + y) % 2 === 0) checker.push([40 + x, 40 + y, 9]);
    expect(clusters(checker)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    // An L of a face-joined run, through each axis.
    expect(clusters([[0, 0, 30], [1, 0, 30], [1, 1, 30], [1, 1, 31]])).toEqual([4]);
    // The shade and anything after x, y, z are no matter, and a voxel twice is once.
    expect(clusters([[1, 1, 1, 85], [1, 1, 2, 83], [1, 1, 1, 85]])).toEqual([2]);
  });

  it("the ring clear of the dummy: every corner of the dummy's box on the screen within the ring's inner edge; by how much", () => {
    const ring = { cx: 100, cy: 100, inner: 50 };
    expect(ringClear(ring, { x0: 90, y0: 95, x1: 110, y1: 140 })).toEqual({ clear: true, far: Math.hypot(10, 40), margin: 50 - Math.hypot(10, 40) });
    const out = ringClear(ring, { x0: 90, y0: 95, x1: 110, y1: 150.5 });
    expect(out.clear).toBe(false);
    expect(out.margin).toBeLessThan(0);
    // A box off to one side.
    expect(ringClear(ring, { x0: 70, y0: 70, x1: 80, y1: 80 })).toMatchObject({ clear: true, far: Math.hypot(30, 30) });
  });

  it("the dummy's box: the eight corners of DUMMY about its feet, and their bounds on the screen", () => {
    const corners = dummyCorners([10, 2, 30], DUMMY);
    expect(corners).toHaveLength(8);
    for (const c of corners) {
      expect([9.6, 10.4]).toContain(Math.round(c[0] * 10) / 10);
      expect([2, 3.9]).toContain(Math.round(c[1] * 10) / 10);
      expect([29.6, 30.4]).toContain(Math.round(c[2] * 10) / 10);
    }
    expect(new Set(corners.map((c) => c.join())).size).toBe(8);
    expect(screenBox([[3, 9], null, [7, 1], [5, 4]])).toEqual({ x0: 3, y0: 1, x1: 7, y1: 9 });
    expect(screenBox([null])).toBeNull();
  });

  it("the zone a shot struck, by the readout's first word: TORSO, HEAD or LIMB; none without one", () => {
    expect(zoneOf('TORSO 55 · 25 m')).toBe('torso');
    expect(zoneOf('HEAD 100 · 25 m\nDOWN IN 2 · 25 m')).toBe('head');
    expect(zoneOf('LIMB 30 · 12 m')).toBe('limb');
    expect(zoneOf(null)).toBeNull();
    expect(zoneOf('DOWN IN 2 · 25 m')).toBeNull();
  });
});
