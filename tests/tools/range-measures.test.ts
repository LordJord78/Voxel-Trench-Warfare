import { describe, expect, it } from 'vitest';
import { decode, encode, type Image } from '../../tools/lib/image.mjs';
import { project } from '../../tools/lib/camera.mjs';
import { loadTunables } from '../../src/core/tunables';
import { CAPTURES, countFailures, DELTA, laidOf, LOOK, lookFailures, marked, noiseFloor, sheet, shows, SHOW_PIXELS, sizesOf, targetBox, USAGE, type Target } from '../../tools/lib/range-measures.mjs';

// G2's proof (tools/range-captures.mjs): the range photographed from the firing step, its counts held to
// what rangeLayout lays, each target's box found by the camera, and what the range changes in it read
// against the same frame with the range down. Read on synthetic images.

/** A w × h image of one colour, `paint` changing pixels as it likes, decoded as a screenshot is. */
function image(w: number, h: number, rgb: readonly number[], paint: (set: (x: number, y: number, c: readonly number[]) => void) => void = () => {}): Image {
  const data = new Uint8Array(w * h * 4);
  const set = (x: number, y: number, c: readonly number[]) => data.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(x, y, rgb);
  paint(set);
  return decode(encode(data, w, h));
}

const rgbAt = (img: { data: Uint8Array; w: number }, x: number, y: number) => Array.from(img.data.subarray((y * img.w + x) * 4, (y * img.w + x) * 4 + 3));

/** The camera at the origin looking down +z, level, 90° across: 1 m at 20 m out is 40 px on a 1600 × 1000 picture. */
const POSE = { position: [0, 0, 0] as const, yaw: 0, pitch: 0, fov: 90 };
const RES = [1600, 1000] as const;

describe("G2's proof: what it photographs", () => {
  it('--only takes a list of captures (tools/lib/cli.mjs parseOnly, tests/tools/cli.test.ts); the usage names every capture', () => {
    const names = CAPTURES.map((c) => c.name);
    for (const n of names) expect(USAGE).toContain(n);
    expect(USAGE).toContain('--only');
  });

  it('the Ravine at noon, 17:35, dusk (19:30) and night (22:30), as G1 photographed its tracers, and the Corridor at the same hours', () => {
    expect(CAPTURES.map((c) => [c.name, c.map, c.hours])).toEqual([
      ['noon', 'ravine', 12],
      ['1735', 'ravine', 17 + 35 / 60],
      ['dusk', 'ravine', 19.5],
      ['night', 'ravine', 22.5],
      ['corridor-noon', 'corridor', 12],
      ['corridor-1735', 'corridor', 17 + 35 / 60],
      ['corridor-dusk', 'corridor', 19.5],
      ['corridor-night', 'corridor', 22.5],
    ]);
  });
});

describe("G2's proof: the range up is what rangeLayout lays", () => {
  const laid = { dummies: 5, plates: 4 };
  const all = { up: true, dummies: 5, standing: 5, drawn: 5, plates: 4, steel: 4 };

  it("a layout's dummies are its standing ones and its movers; its plates, the torso and head plates", () => {
    const kinds = ['dummy', 'dummy', 'dummy', 'dummy', 'mover', 'torso', 'torso', 'head', 'head'] as const;
    expect(laidOf(kinds.map((kind) => ({ kind })))).toEqual(laid);
    expect(laidOf([])).toEqual({ dummies: 0, plates: 0 });
  });

  it('every dummy listed, standing and drawn, and every plate listed with its steel in the world: no failure', () => {
    expect(countFailures(laid, all)).toEqual([]);
    // More drawn, standing or with steel than laid is no failure of the counts (a dummy drawn twice
    // would be the renderer's).
    expect(countFailures(laid, { ...all, drawn: 6 })).toEqual([]);
  });

  it('more listed than laid fails too: the dummies and plates listed are what was laid, no more (an unsighted raise lays 7 and 5 on the Ravine)', () => {
    expect(countFailures(laid, { up: true, dummies: 7, standing: 7, drawn: 7, plates: 5, steel: 5 })).toEqual(['7 dummies listed of the 5 laid', '5 plates listed of the 4 laid']);
    expect(countFailures(laid, { ...all, plates: 5, steel: 5 })).toEqual(['5 plates listed of the 4 laid']);
  });

  it('fewer up than laid fails, by what is short: listed, standing, drawn, or a plate without its steel', () => {
    expect(countFailures(laid, { ...all, dummies: 4, standing: 4, drawn: 4 })).toEqual(['4 dummies listed of the 5 laid', '4 dummies standing of the 5 laid', '4 dummies drawn of the 5 laid']);
    expect(countFailures(laid, { ...all, drawn: 3 })).toEqual(['3 dummies drawn of the 5 laid']);
    expect(countFailures(laid, { ...all, plates: 3, steel: 3 })).toEqual(['3 plates listed of the 4 laid', "3 plates' steel in the world of the 4 laid"]);
    expect(countFailures(laid, { ...all, steel: 0 })).toEqual(["0 plates' steel in the world of the 4 laid"]);
  });

  it('a range that is not up, or a layout that lays none of either, fails', () => {
    expect(countFailures(laid, { up: false, dummies: 0, standing: 0, drawn: 0, plates: 0, steel: 0 })).toEqual([
      'the range is not up',
      '0 dummies listed of the 5 laid',
      '0 dummies standing of the 5 laid',
      '0 dummies drawn of the 5 laid',
      '0 plates listed of the 4 laid',
      "0 plates' steel in the world of the 4 laid",
    ]);
    expect(countFailures({ dummies: 0, plates: 4 }, { ...all, dummies: 0, standing: 0, drawn: 0 })).toEqual(['rangeLayout lays no dummies']);
    expect(countFailures({ dummies: 5, plates: 0 }, { ...all, plates: 0, steel: 0 })).toEqual(['rangeLayout lays no plates']);
  });
});

describe("G2's proof: where each target is on the picture", () => {
  /** The sizes as the page's tunables give them ([range] torso_plate_m and head_plate_m, [stance.standing] height). */
  const tun = loadTunables();
  const SIZES = sizesOf({ torsoPlateM: tun.get('range.torso_plate_m') as [number, number], headPlateM: tun.get('range.head_plate_m') as [number, number], standingM: tun.f('stance.standing.height') });

  it("the targets' sizes are the page's: a plate's steel by [range], a dummy as tall as the player stands and as wide as a man", () => {
    expect(SIZES).toEqual({ dummy: [0.6, 1.8], mover: [0.6, 1.8], torso: [0.45, 0.6], head: [0.25, 0.3] });
    expect(sizesOf({ torsoPlateM: [0.5, 0.7], headPlateM: [0.2, 0.2], standingM: 1.9 })).toEqual({ dummy: [0.6, 1.9], mover: [0.6, 1.9], torso: [0.5, 0.7], head: [0.2, 0.2] });
  });

  it("a dummy's box runs from its feet to its head, as wide as a man, and a margin round it", () => {
    // Its feet 1.62 m under the eye, 20 m out: 40 px a metre, so 0.6 m across is 24 px and 1.8 m high 72.
    const t: Target = { kind: 'dummy', at: [0, -1.62, 20] };
    const feet = project(POSE, RES, t.at)!;
    const head = project(POSE, RES, [0, -1.62 + 1.8, 20])!;
    expect(feet[0]).toBeCloseTo(800, 9);
    expect(feet[1]).toBeCloseTo(500 + 1.62 * 40, 9);
    expect(targetBox(t, POSE, RES, SIZES)).toEqual([800 - 12 - 3, Math.floor(head[1]) - 3, 800 + 12 + 3, Math.ceil(feet[1]) + 3]);
    // A mover is a dummy walking: the same box.
    expect(targetBox({ ...t, kind: 'mover' }, POSE, RES, SIZES)).toEqual(targetBox(t, POSE, RES, SIZES));
    // Taller, by the sizes it is given: its head 2 m over its feet.
    const tall = targetBox(t, POSE, RES, { ...SIZES, dummy: [0.6, 2] })!;
    expect(tall[1]).toBe(Math.floor(project(POSE, RES, [0, -1.62 + 2, 20])![1]) - 3);
    expect(tall[1]).toBeLessThan(Math.floor(head[1]) - 3);
  });

  it("a plate's box is its steel's, about its centre, and a margin round it; behind the camera, none", () => {
    // A torso plate's centre 40 m out at the eye's height: 0.45 × 0.6 m is 9 × 12 px.
    expect(targetBox({ kind: 'torso', at: [0, 0, 40] }, POSE, RES, SIZES)).toEqual([800 - 5 - 3, 500 - 6 - 3, 800 + 5 + 3, 500 + 6 + 3]);
    // A head plate 0.25 × 0.3 m at 20 m: 10 × 12 px.
    expect(targetBox({ kind: 'head', at: [2, 0, 20] }, POSE, RES, SIZES)).toEqual([880 - 5 - 3, 500 - 6 - 3, 880 + 5 + 3, 500 + 6 + 3]);
    expect(targetBox({ kind: 'torso', at: [0, 0, -40] }, POSE, RES, SIZES)).toBeNull();
  });
});

describe("G2's proof: the range shows at 17:35, solo's opening hour, on the Ravine", () => {
  const at = (name: string) => CAPTURES.find((c) => c.name === name)!;
  /** A target as measured: its kind, its distance out as laid, whether it shows, and what was read. */
  const target = (kind: Target['kind'], distanceM: number, shows: boolean) => ({ kind, distanceM, shows, pixels: shows ? 30 : 1, area: 400, peak: shows ? 60 : 20 });

  it('every dummy (a mover too) and torso plate laid within 60 m must show; a head plate, or anything past 60 m, need not', () => {
    expect(LOOK).toEqual({ capture: '1735', withinM: 60, kinds: ['dummy', 'mover', 'torso'] });
    const shown = [target('dummy', 25, true), target('dummy', 40, true), target('dummy', 60, true), target('mover', 50, true), target('torso', 30, true), target('torso', 55, true)];
    expect(lookFailures(at('1735'), shown)).toEqual([]);
    // Faint past 60 m, or a head plate: no failure.
    expect(lookFailures(at('1735'), [...shown, target('dummy', 80, false), target('head', 45, false), target('torso', 85, false)])).toEqual([]);
    // Faint within it: each one named, with what was read.
    expect(lookFailures(at('1735'), [target('dummy', 40, false), target('mover', 50, false), target('torso', 55, false), target('dummy', 25, true)])).toEqual([
      "the dummy at 40 m does not show at 17:35: 1 of its 400 px changed by 24 or more (peak 20), not 4",
      "the mover at 50 m does not show at 17:35: 1 of its 400 px changed by 24 or more (peak 20), not 4",
      "the torso plate at 55 m does not show at 17:35: 1 of its 400 px changed by 24 or more (peak 20), not 4",
    ]);
  });

  it("only the Ravine's 17:35 is held to it: the other hours, and the Corridor's, are for the eye", () => {
    const faint = [target('dummy', 40, false), target('torso', 30, false)];
    for (const name of ['noon', 'dusk', 'night', 'corridor-1735', 'corridor-noon']) expect(lookFailures(at(name), faint), name).toEqual([]);
  });
});

describe('G2\'s proof: what the range changes, up against down', () => {
  // A 40 × 30 frame without the range; with it, a target in the box [10, 10, 20, 20): five pixels it
  // changes by 30 in red, three by 10 (under DELTA), and one out of the box by 200.
  const down = image(40, 30, [60, 70, 80]);
  const up = image(40, 30, [60, 70, 80], (set) => {
    for (let x = 12; x < 17; x++) set(x, 14, [90, 70, 80]);
    for (let x = 12; x < 15; x++) set(x, 16, [70, 70, 80]);
    set(30, 5, [255, 255, 255]);
  });

  it('a box counts the pixels changed by DELTA or more in some channel, the most any changed, and its area', () => {
    expect(DELTA).toBe(24);
    expect(SHOW_PIXELS).toBe(4);
    expect(shows(up, down, [10, 10, 20, 20])).toEqual({ pixels: 5, peak: 30, area: 100 });
    // Asked to count smaller changes, the three by 10 count too.
    expect(shows(up, down, [10, 10, 20, 20], 10)).toEqual({ pixels: 8, peak: 30, area: 100 });
    // A box over the frame's edge is read where it is in the frame.
    expect(shows(up, down, [35, 25, 45, 35])).toEqual({ pixels: 0, peak: 0, area: 25 });
  });

  it("the noise floor is the 99th percentile of the change outside every target's box", () => {
    // Only the white pixel at (30, 5) changes outside the box: under 1% of the frame, so the floor is 0.
    expect(noiseFloor(up, down, [[10, 10, 20, 20]])).toBe(0);
    // With every pixel outside the box changed by 6, the floor is 6.
    const grey = image(40, 30, [66, 70, 80]);
    expect(noiseFloor(grey, down, [[10, 10, 20, 20]])).toBe(6);
    // Frames of other sizes are no comparison.
    expect(() => shows(image(10, 10, [0, 0, 0]), down, [0, 0, 5, 5])).toThrow(/10x10/);
  });
});

describe("G2's proof: its pictures", () => {
  it('marked: a 1 px magenta box on the edges of each target\'s box, the rest of the frame as it was', () => {
    const img = image(40, 30, [60, 70, 80]);
    const m = marked(img, [[10, 10, 20, 20]]);
    expect([m.w, m.h]).toEqual([40, 30]);
    for (const [x, y] of [[10, 10], [19, 10], [10, 19], [19, 19], [15, 10], [10, 15]]) expect(rgbAt(m, x, y), `${x}, ${y}`).toEqual([255, 0, 255]);
    for (const [x, y] of [[15, 15], [9, 10], [20, 20], [0, 0]]) expect(rgbAt(m, x, y), `${x}, ${y}`).toEqual([60, 70, 80]);
    // The frame itself is left as it was.
    expect(rgbAt(img, 10, 10)).toEqual([60, 70, 80]);
  });

  it("the sheet: each target's neighbourhood magnified, up beside down, two targets to a row, each labelled", () => {
    // A 200 × 100 frame with a red target at (50, 50) in the frame up; down, none.
    const down = image(200, 100, [40, 40, 40]);
    const up = image(200, 100, [40, 40, 40], (set) => set(50, 50, [255, 0, 0]));
    const boxes: [number, number, number, number][] = [[45, 45, 56, 56], [150, 20, 160, 30], [10, 80, 20, 90]];
    const s = sheet(up, down, boxes, ['D25', 'T30', 'H45']);
    // Cells of 192 px, a pair's up and down 6 px apart, pairs 18 px apart and from the edges, 20 px over
    // each pair for its label; three targets make two rows.
    expect([s.w, s.h]).toEqual([18 + (192 + 6 + 192) + 18 + (192 + 6 + 192) + 18, 2 * (20 + 192) + 18]);
    // The first target's crop is 48 px about its box's middle (50.5, 50.5 rounds to 50), 4 times over:
    // the red pixel is 4 × 4 at (24 + 0) × 4 into the up cell, and absent from the down cell.
    const upX = 18;
    const downX = 18 + 192 + 6;
    const top = 20;
    expect(rgbAt(s, upX + 24 * 4 + 1, top + 24 * 4 + 1)).toEqual([255, 0, 0]);
    expect(rgbAt(s, downX + 24 * 4 + 1, top + 24 * 4 + 1)).toEqual([40, 40, 40]);
    // The box drawn round the target in both cells, magenta, a pixel outside its scaled edge.
    expect(rgbAt(s, upX + (45 - 26) * 4 - 1, top + 24 * 4 + 1)).toEqual([255, 0, 255]);
    expect(rgbAt(s, downX + (45 - 26) * 4 - 1, top + 24 * 4 + 1)).toEqual([255, 0, 255]);
    // Its label, in yellow, over the pair.
    let yellow = 0;
    for (let y = 0; y < top; y++) for (let x = upX; x < upX + 192; x++) if (rgbAt(s, x, y).join() === '255,220,0') yellow++;
    expect(yellow).toBeGreaterThan(20);
    // A label of a letter the font does not have is refused.
    expect(() => sheet(up, down, [boxes[0]], ['X1'])).toThrow(/X/);
  });
});
