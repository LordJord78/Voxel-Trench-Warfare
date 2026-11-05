import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { projectToPixel } from '../../src/render/camera';
import { Rng } from '../../src/core/rng';
import { project } from '../../tools/lib/camera.mjs';
import { at, brightest, colourOf, composite, decode, encode, hsv, hueOff, lit, luminance, median, p95, percentile, ringMean, topChannel, type Composite, type Image } from '../../tools/lib/image.mjs';
import { failedEntry, removePictures, stamp } from '../../tools/lib/report.mjs';
import { byDay, CAPTURES, FAR_LIT_MIN, gateCapture, headRing, kindOf, MIN_GPU_SAMPLES, nearLike, pathCover, streamCover, TARGET, TEAM, teamChannel, tinted, trackRound, WALL, type Burst, type Capture, type Frame, type Measures, type Track } from '../../tools/lib/tracer-measures.mjs';
import { P } from '../../src/world/materials';

// The capture tools' measures (tools/lib: the pixels of a screenshot as displayed, the game's camera, a
// report's entries) and G1's proof's own (tools/lib/tracer-measures.mjs), read on synthetic images: every
// gate fails on a measure that is missing where it is gated, and a head's top channel breaks a tie
// toward its team's.

/** A w × h image of one colour, `paint` changing pixels as it likes, decoded as a screenshot is. */
function image(w: number, h: number, rgb: readonly number[], paint: (set: (x: number, y: number, c: readonly number[]) => void) => void = () => {}): Image {
  const data = new Uint8Array(w * h * 4);
  const set = (x: number, y: number, c: readonly number[]) => data.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(x, y, rgb);
  paint(set);
  return decode(encode(data, w, h));
}

const scratch = mkdtempSync(join(tmpdir(), 'capture-measures-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("the capture tools' image measures", () => {
  it('a screenshot decodes to its RGBA and its displayed luminance (Rec. 709 on the sRGB values)', () => {
    const img = image(3, 2, [10, 20, 30], (set) => set(2, 1, [255, 0, 128]));
    expect(img.w).toBe(3);
    expect(img.h).toBe(2);
    expect(Array.from(img.data.subarray(20, 24))).toEqual([255, 0, 128, 255]);
    expect(img.lum[5]).toBeCloseTo(0.2126 * 255 + 0.0722 * 128, 4);
    expect(img.lum[0]).toBeCloseTo(luminance(10, 20, 30), 4);
    expect(at(img, [2.9, 1.2])).toBe(5);
    expect(at(img, [3, 0])).toBe(-1);
    expect(at(img, [-0.1, 0])).toBe(-1);
  });

  it("a composite shows each pixel as its frame most unlike its background, the background its least luminance", () => {
    // A tracer's light added (pixel 0, brighter in the second frame) shows as that frame, as each
    // channel's most over the frames did; one that covers a bright haze behind it (pixel 1, by day:
    // darker, redder in the third) is no longer brighter than its background.
    const haze = [220, 190, 150];
    const a = image(2, 1, haze, (set) => set(0, 0, [10, 10, 10]));
    const b = image(2, 1, haze, (set) => set(0, 0, [200, 40, 30]));
    const c3 = image(2, 1, haze, (set) => {
      set(0, 0, [12, 10, 10]);
      set(1, 0, [250, 80, 55]);
    });
    const c = composite([a, b, c3]);
    expect(Array.from(c.data.subarray(0, 3))).toEqual([200, 40, 30]);
    expect(c.lum[0]).toBeCloseTo(luminance(200, 40, 30), 4);
    // The background: pixel 0's darkest frame. Pixel 1's, with nothing to say a tracer was over it,
    // is its darkest too, the covered frame, and the haze is what is most unlike it: so the tool says
    // where each frame's tracers are drawn (`near`, below).
    expect(c.least[0]).toBeCloseTo(a.lum[0], 4);
    expect(Array.from(c.back.subarray(0, 3))).toEqual([10, 10, 10]);
    expect(c.least[1]).toBeCloseTo(luminance(250, 80, 55), 4);
    expect(Array.from(c.data.subarray(4, 7))).toEqual(haze);
    expect(() => composite([a, image(1, 1, [0, 0, 0])])).toThrow();
  });

  it('a pixel with a tracer drawn near it in a frame (`near`) takes its background from the frames without one: a covering tracer is not the background', () => {
    const haze = [220, 190, 150];
    const frames = [image(2, 1, haze), image(2, 1, haze, (set) => set(1, 0, [250, 80, 55])), image(2, 1, haze)];
    // The second frame drew a tracer over pixel 1.
    const near = [new Uint8Array([0, 0]), new Uint8Array([0, 1]), new Uint8Array([0, 0])];
    const c = composite(frames, near);
    expect(c.least[1]).toBeCloseTo(luminance(haze[0], haze[1], haze[2]), 4);
    expect(Array.from(c.back.subarray(3, 6))).toEqual(haze);
    // And it still shows in the composite, as drawn.
    expect(Array.from(c.data.subarray(4, 7))).toEqual([250, 80, 55]);
    // Every frame with a tracer near it: the least over them all.
    const all = composite(frames, [new Uint8Array([1, 1]), new Uint8Array([1, 1]), new Uint8Array([1, 1])]);
    expect(all.least[1]).toBeCloseTo(luminance(250, 80, 55), 4);
  });

  it("a pixel tinted by a tracer: its team's hue within reach, saturated, and more coloured than its background", () => {
    const haze = [220, 190, 150];
    // Red's glow covering the low sun's haze, and red's glow added to it (orange-peach).
    expect(tinted([250, 80, 55], haze, TEAM.red)).toBe(true);
    expect(tinted([255, 176, 127], haze, TEAM.red)).toBe(false);
    // A blue one covering it, and added to it (lavender-white).
    expect(tinted([121, 164, 252], haze, TEAM.blue)).toBe(true);
    expect(tinted([223, 213, 255], haze, TEAM.blue)).toBe(false);
    // Over the night's violet sky, red shows; the sky itself is no tracer, nor a red-brown wall.
    expect(tinted([255, 59, 60], [60, 50, 104], TEAM.red)).toBe(true);
    expect(tinted([60, 50, 104], [60, 50, 104], TEAM.red)).toBe(false);
    expect(tinted([150, 60, 50], [140, 58, 50], TEAM.red)).toBe(false);
  });

  it("a ring's mean is its annulus's, less what is dropped; with nothing left, nulls", () => {
    // 40 grey in the annulus 3 to 5 px round (10, 10); 255 in the middle, outside it.
    const img = image(21, 21, [40, 40, 40], (set) => {
      set(10, 10, [255, 255, 255]);
      set(20, 20, [255, 0, 0]);
    });
    const r = ringMean(img, 10, 10, [3, 5]);
    expect(r.n).toBeGreaterThan(40);
    expect(r.mean).toBeCloseTo(luminance(40, 40, 40), 4);
    expect(r.meanV).toBeCloseTo(40, 6);
    expect(r.meanRGB).toEqual([40, 40, 40]);
    const left = ringMean(img, 10, 10, [3, 5], (x) => x < 10);
    expect(left.n + left.dropped).toBe(r.n);
    expect(left.dropped).toBeGreaterThan(0);
    const none = ringMean(img, 10, 10, [3, 5], () => true);
    expect(none).toMatchObject({ mean: null, meanV: null, meanRGB: null, n: 0 });
  });

  it('the brightest pixel near a point, by luminance, within its Chebyshev reach', () => {
    const img = image(9, 9, [0, 0, 0], (set) => {
      set(6, 6, [0, 255, 0]);
      set(8, 8, [255, 255, 255]);
    });
    expect(brightest(img, 4, 4, 2)).toBeCloseTo(0.7152 * 255, 3);
    expect(brightest(img, 4, 4, 1)).toBe(0);
    expect(brightest(img, 4, 4, 4)).toBeCloseTo(255, 3);
  });

  it("a head's top channel is its highest; a tie goes to the team's channel, else to R before G before B", () => {
    // A blue-hot pixel beside a dimmer red one: blue, whatever is preferred.
    const blue = image(5, 5, [0, 0, 0], (set) => {
      set(2, 2, [180, 0, 0]);
      set(3, 2, [0, 40, 230]);
    });
    expect(topChannel(blue, 2, 2, 1, 0)).toEqual({ value: 230, channel: 2 });
    // A white-hot head: every channel at 255. A blue tracer's is blue, a red one's red.
    const white = image(5, 5, [0, 0, 0], (set) => set(2, 2, [255, 255, 255]));
    expect(topChannel(white, 2, 2, 1, 2)).toEqual({ value: 255, channel: 2 });
    expect(topChannel(white, 2, 2, 1, 0)).toEqual({ value: 255, channel: 0 });
    expect(topChannel(white, 2, 2, 1, 1)).toEqual({ value: 255, channel: 1 });
    // R and B tied, G short of them: preferring G gives the first that reaches it, R.
    const magenta = image(5, 5, [0, 0, 0], (set) => {
      set(1, 2, [10, 10, 255]);
      set(2, 2, [255, 128, 0]);
    });
    expect(topChannel(magenta, 2, 2, 1, 1)).toEqual({ value: 255, channel: 0 });
    expect(topChannel(magenta, 2, 2, 1, 2)).toEqual({ value: 255, channel: 2 });
  });

  it('colour as HSV, hues apart round the circle, and a mean hue weighted by chroma', () => {
    expect(hsv([255, 0, 0])).toEqual({ hue: 0, saturation: 1, chroma: 255 });
    expect(hsv([0, 0, 255]).hue).toBeCloseTo(240, 6);
    expect(hsv([255, 128, 0]).hue).toBeCloseTo(30.1, 1);
    expect(hsv([90, 90, 90]).saturation).toBe(0);
    expect(hsv([0, 0, 0])).toEqual({ hue: 0, saturation: 0, chroma: 0 });
    expect(hueOff(350, 10)).toBeCloseTo(20, 9);
    expect(hueOff(10, 350)).toBeCloseTo(20, 9);
    expect(hueOff(0, 180)).toBeCloseTo(180, 9);
    expect(colourOf([])).toEqual({ saturation: null, hueDeg: null, n: 0 });
    const reds = colourOf([{ rgb: [255, 0, 0] }, { rgb: [255, 128, 128] }]);
    expect(reds.saturation).toBeCloseTo((1 + 127 / 255) / 2, 6);
    expect(reds.hueDeg).toBeCloseTo(0, 6);
    // Red (0) and blue (240) at one chroma: 300, the short way round, not 120.
    expect(colourOf([{ rgb: [255, 0, 0] }, { rgb: [0, 0, 255] }]).hueDeg).toBeCloseTo(300, 6);
  });

  it('lit: so many times the background and so many steps over it, both', () => {
    const rule = { ratio: 1.5, min: 6 };
    expect(lit(16, 10, rule)).toBe(true);
    expect(lit(15.9, 10, rule)).toBe(false);
    expect(lit(8, 2, rule)).toBe(true);
    expect(lit(7.9, 2, rule)).toBe(false);
    expect(lit(100, 0, { ratio: 3, min: 0 })).toBe(true);
  });

  it('percentiles of a sample, and nulls for none', () => {
    const hundred = Array.from({ length: 100 }, (_, i) => 100 - i);
    expect(p95(hundred)).toBe(96);
    expect(median(hundred)).toBe(51);
    expect(percentile(hundred, 0)).toBe(1);
    expect(percentile(hundred, 1)).toBe(100);
    expect(p95([])).toBeNull();
    expect(median([])).toBeNull();
    expect(p95(Float32Array.from([3]))).toBe(3);
  });
});

describe("the capture tools' camera", () => {
  it("projects a point as the game's camera does (render/camera.ts projectToPixel), and nothing behind it", () => {
    const rng = Rng.root(41);
    for (let k = 0; k < 200; k++) {
      const pose = {
        position: [rng.uniform(-50, 50), rng.uniform(0, 30), rng.uniform(-50, 50)] as [number, number, number],
        yaw: rng.uniform(-180, 180),
        pitch: rng.uniform(-80, 80),
        roll: k % 3 === 0 ? 0 : rng.uniform(-20, 20),
        fov: k % 4 === 0 ? undefined : rng.uniform(40, 110),
      };
      const res: [number, number] = [1600, 1000];
      const p: [number, number, number] = [rng.uniform(-100, 100), rng.uniform(-20, 60), rng.uniform(-100, 100)];
      const want = projectToPixel(pose, res, p);
      const got = project(pose, res, p);
      if (want === null) expect(got).toBeNull();
      else {
        expect(got).not.toBeNull();
        expect(got![0]).toBeCloseTo(want[0], 6);
        expect(got![1]).toBeCloseTo(want[1], 6);
      }
    }
    expect(project({ position: [0, 0, 0], yaw: 0, pitch: 0 }, [100, 100], [0, 0, -5])).toBeNull();
    expect(project({ position: [0, 0, 0], yaw: 0, pitch: 0 }, [100, 100], [0, 0, 5])).toEqual([50, 50]);
  });
});

describe("a capture tool's report", () => {
  it('each entry is stamped with the commit the tree is at, whether it has changes, and when', () => {
    const when = new Date('2026-11-04T10:00:00.000Z');
    const s = stamp(process.cwd(), when);
    expect(s.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof s.dirty).toBe('boolean');
    expect(s.at).toBe('2026-11-04T10:00:00.000Z');
    // Outside a repository: nulls, never a throw.
    const outside = mkdtempSync(join(tmpdir(), 'not-a-repo-'));
    try {
      expect(stamp(outside, when)).toEqual({ commit: null, dirty: null, at: '2026-11-04T10:00:00.000Z' });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a capture that did not finish leaves its failure, stamped, and none of its pictures', () => {
    const s = { commit: 'a'.repeat(40), dirty: false, at: '2026-11-04T10:00:00.000Z' };
    expect(failedEntry(['far-night: timed out'], s)).toEqual({ failures: ['far-night: timed out'], commit: 'a'.repeat(40), dirty: false, at: '2026-11-04T10:00:00.000Z' });
    const dir = join(scratch, 'pictures');
    mkdirSync(dir);
    for (const n of ['far-night.png', 'far-night-marked.png', 'far-night-persist.png', 'far-night-persist-marked.png', 'side-night.png']) writeFileSync(join(dir, n), 'x');
    // Those there are removed, one not there passed over.
    removePictures(['far-night.png', 'far-night-marked.png', 'far-night-persist.png', 'far-night-persist-marked.png', 'never.png'].map((n) => join(dir, n)));
    expect(readdirSync(dir)).toEqual(['side-night.png']);
  });
});

/** A frame of the window: the player's tracers as tracerPixels() gives them, a pose looking along +z from the origin. */
const frameOf = (k: number, tracers: Frame['info']['tracers'], res: [number, number] = [200, 200]): Frame => ({ k, info: { res, pose: { position: [0, 0, 0], yaw: 0, pitch: 0 }, gun: null, tracers } });

describe("G1's proof: its measures", () => {
  it('a capture fires its team: Blue captures are blue, and red the rest', () => {
    expect(CAPTURES.filter((c) => c.team === 'blue').map((c) => c.name).sort()).toEqual(['far-night-blue', 'side-1735-blue', 'side-night-blue']);
    for (const c of CAPTURES) expect(kindOf(c), c.name).toBe(c.team === 'blue' ? 3 : 2);
    // Each team's own channel: red's R, blue's B, amber's R.
    expect([teamChannel(2), teamChannel(3), teamChannel(1)]).toEqual([0, 2, 0]);
  });

  it("17:35 is photographed near, far and side on, side on as Blue and with the front's fire heavy; night far and side on as Blue; and a wall 10 m out at night", () => {
    const names = CAPTURES.map((c) => c.name);
    for (const n of ['1735', 'far-1735', 'side-1735', 'side-1735-blue', 'side-1735-heavy', 'far-night-blue', 'side-night-blue', 'wall-night']) expect(names).toContain(n);
    for (const c of CAPTURES.filter((x) => x.name.includes('1735'))) expect(c.hours).toBeCloseTo(17 + 35 / 60, 9);
    expect(CAPTURES.find((c) => c.name === 'side-1735-heavy')!.front).toBe('heavy');
    expect(CAPTURES.filter((c) => c.front).map((c) => c.name)).toEqual(['side-1735-heavy']);
    const wall = CAPTURES.find((c) => c.name === 'wall-night')!;
    expect(wall.burst).toBe('wall');
    expect(nearLike(wall)).toBe(true);
    // Its rounds strike within their first tick (an AK's 14.7 m), so each is drawn once, to the wall.
    expect(WALL.outM).toBeLessThan(880 / 60);
    // Of the game's timber (world/materials.ts P), and the wall's place is put back after.
    expect(WALL.material).toBe(P.TIMBER);
  });

  it("a white-hot head's top channel is its team's: a blue head is read in blue against the ring's blue", () => {
    // A white head on a violet night: the ring (20, 20, 60) over (40, 40) px round it.
    const img = image(200, 200, [20, 20, 60], (set) => {
      for (let y = 99; y <= 101; y++) for (let x = 99; x <= 101; x++) set(x, y, [255, 255, 255]);
    });
    const head = (kind: number) => ({ kind, flown: 80, headDrawn: true, head: [100.5, 100.5] as [number, number], tail: [60, 100] as [number, number], headM: [0, 0, 80] as [number, number, number], tailM: [0, 0, 60] as [number, number, number], joinsM: 150 });
    const blue = headRing(img, frameOf(0, [head(3)]).info, 3).headline;
    expect(blue.headTop).toBe('B');
    expect(blue.headChannel).toBe(255);
    expect(blue.ringMeanTop).toBeCloseTo(60, 6);
    expect(blue.ratioTop).toBeCloseTo(255 / 60, 6);
    const red = headRing(img, frameOf(0, [head(2)]).info, 2).headline;
    expect(red.headTop).toBe('R');
    expect(red.ratioTop).toBeCloseTo(255 / 20, 6);
    // Only the capture's own kind is measured.
    expect(headRing(img, frameOf(0, [head(1)]).info, 2).headsDrawn).toBe(0);
  });

  it('a round is followed frame to frame, and its line fitted to where its tracer is drawn, joined to its path or not', () => {
    // A round 900 m/s along +z: each frame's streak 21 m, joined to its path from 10 m out.
    const streak = (k: number, flown: number) => frameOf(k, [{ kind: 2, flown, headDrawn: true, head: null, tail: null, headM: [0.2, 1, flown], tailM: [0.2, 1, flown - 21], joinsM: 10 }]);
    const frames = [streak(0, 45), streak(1, 60), streak(2, 75), streak(3, 90)];
    const track = trackRound(frames, 2)!;
    expect(track.seen.map((s) => s.frame)).toEqual([0, 1, 2, 3]);
    expect(track.path!.fit).toBe('drawn');
    for (const s of track.seen) {
      const q = track.path!.point(s.t.flown);
      for (let k = 0; k < 3; k++) expect(q[k]).toBeCloseTo(s.t.headM[k], 6);
    }
    // Another kind's round is not the player's.
    expect(trackRound(frames, 3)).toBeNull();
  });
});

/** Every measure a capture can be gated on, each passing, the far colour at the capture's team's hue. */
function passing(c: Capture): Measures {
  const team = c.team === 'blue' ? TEAM.blue : TEAM.red;
  return {
    headsDrawn: 3,
    headsMeasured: 3,
    headline: { headChannel: 255, headTop: c.team === 'blue' ? 'B' : 'R', ringMeanTop: 40, ratioTop: 6.4, ratioV: 5, ratio: 4 },
    nearWidth: { px: 10.5, samples: 60 },
    farColour: { saturation: 0.6, hueDeg: team.hue, n: 120, measured: true },
    battleColour: { saturation: 0.5, hueDeg: 38, n: 300, measured: true },
    stream: { share: 0.95, span: 0.75, samples: 80, reachPx: 300, muzzlePx: 400 },
    pathCover: { share: 0.95 },
    noonContrast: { ratio: 1.9 },
    frontColour: { drawn: 2, n: 300, saturation: 0.7, hueDeg: TEAM.amber.hue },
  };
}
const burstOf = (ricochetsByKind = [0, 2, 3, 3]): Burst => ({ most: { ricochets: ricochetsByKind.reduce((a, b) => a + b, 0), embers: 6, ricochetsByKind, embersByKind: [0, 2, 4, 0] }, gpuSamples: 120 });

/** A copy of `m` with the measure at `path` (dotted) missing. */
function without(m: Measures, path: string): Measures {
  const copy = JSON.parse(JSON.stringify(m)) as Measures;
  const parts = path.split('.');
  let node = copy;
  for (const p of parts.slice(0, -1)) node = node[p];
  node[parts[parts.length - 1]] = null;
  return copy;
}

/** What each capture is gated on (the G1 ledger's rulings), as measure paths: each must fail missing. */
function gated(c: Capture): string[] {
  const hip = !c.aimed && !c.side;
  const day = c.hours < 19;
  const far = c.burst === 'far' && !c.aimed;
  const paths: string[] = [];
  if (hip && c.burst === 'near') paths.push('headline', day ? 'headline.headChannel' : 'headline.ratioTop', 'headsDrawn');
  if (hip && (c.burst === 'near' || c.burst === 'wall')) paths.push('stream', 'stream.share', 'stream.span');
  if (hip && c.burst !== 'graze') paths.push('nearWidth', 'nearWidth.px');
  if (far && !day) paths.push('farColour', 'farColour.measured', 'farColour.saturation', 'farColour.hueDeg');
  if (far && c.hours === 12) paths.push('noonContrast', 'noonContrast.ratio');
  if (c.side) paths.push('pathCover', 'pathCover.share');
  if (c.battle) paths.push('battleColour', 'battleColour.measured', 'battleColour.saturation');
  if (c.front) paths.push('frontColour', 'frontColour.drawn', 'frontColour.n');
  return paths;
}

describe("G1's proof: its gates", () => {
  it('every capture passes on passing measures', () => {
    for (const c of CAPTURES) expect(gateCapture(c, passing(c), burstOf()), c.name).toEqual([]);
  });

  it('each gate fails on a measure missing where it is gated', () => {
    let checked = 0;
    for (const c of CAPTURES) {
      for (const path of gated(c)) {
        expect(gateCapture(c, without(passing(c), path), burstOf()).length, `${c.name}: ${path} missing`).toBeGreaterThan(0);
        checked++;
      }
      // The burst's own: its GPU samples, and the graze's ricochets of the player's kind.
      expect(gateCapture(c, passing(c), { ...burstOf(), gpuSamples: null as unknown as number }).length, `${c.name}: GPU samples missing`).toBeGreaterThan(0);
      expect(gateCapture(c, passing(c), { ...burstOf(), gpuSamples: MIN_GPU_SAMPLES - 1 }).length, `${c.name}: too few GPU samples`).toBeGreaterThan(0);
    }
    expect(checked).toBeGreaterThan(60);
  });

  it("by day (noon, 17:35) the head is gated at the display's top in its own channel; after dark against its ring", () => {
    const near = (name: string) => CAPTURES.find((c) => c.name === name)!;
    for (const name of ['noon', '1735']) {
      const m = passing(near(name));
      expect(gateCapture(near(name), { ...m, headline: { ...m.headline, ratioTop: 1.2 } }, burstOf()), name).toEqual([]);
      expect(gateCapture(near(name), { ...m, headline: { ...m.headline, headChannel: 249 } }, burstOf()).length, name).toBe(1);
    }
    for (const name of ['dusk', 'night']) {
      const m = passing(near(name));
      expect(gateCapture(near(name), { ...m, headline: { ...m.headline, ratioTop: 2.9 } }, burstOf()).length, name).toBe(1);
    }
  });

  it("17:35's far colour and contrast, Blue's battle and the eye's path are reported, not gated", () => {
    for (const name of ['far-1735', 'side-1735', 'side-1735-blue', 'side-1735-heavy']) {
      const c = CAPTURES.find((x) => x.name === name)!;
      expect(gateCapture(c, without(without(passing(c), 'farColour'), 'noonContrast'), burstOf()), name).toEqual([]);
    }
    for (const name of ['far-night-blue', 'side-night-blue']) {
      const c = CAPTURES.find((x) => x.name === name)!;
      expect(gateCapture(c, without(passing(c), 'battleColour'), burstOf()), name).toEqual([]);
    }
    for (const name of ['far-noon', 'far-1735', 'far-dusk', 'far-night', 'far-night-blue']) {
      const c = CAPTURES.find((x) => x.name === name)!;
      expect(gateCapture(c, without(passing(c), 'pathCover'), burstOf()), name).toEqual([]);
    }
  });

  it("17:35 side on is gated on its path's cover as side-1735 is, as Blue and with the front heavy too; the wall at night on its stream and near width as a near burst is, its head reported", () => {
    for (const name of ['side-1735', 'side-1735-blue', 'side-1735-heavy']) {
      const c = CAPTURES.find((x) => x.name === name)!;
      const m = passing(c);
      expect(gateCapture(c, { ...m, pathCover: { share: TARGET.pathCover - 0.01 } }, burstOf()).length, name).toBe(1);
    }
    const wall = CAPTURES.find((x) => x.name === 'wall-night')!;
    const m = passing(wall);
    expect(gateCapture(wall, { ...m, stream: { ...m.stream, share: TARGET.streamCover - 0.01 } }, burstOf()).length).toBe(1);
    expect(gateCapture(wall, { ...m, nearWidth: { px: TARGET.nearWidthPx + 1, samples: 10 } }, burstOf()).length).toBe(1);
    // With the front heavy, its amber in the frame, read as amber.
    const heavy = CAPTURES.find((x) => x.name === 'side-1735-heavy')!;
    const h = passing(heavy);
    expect(gateCapture(heavy, { ...h, pathCover: { share: 1 } }, burstOf())).toEqual([]);
    expect(gateCapture(heavy, { ...h, pathCover: { share: 1 }, frontColour: { drawn: 0, n: 0, saturation: null, hueDeg: null } }, burstOf()).length).toBe(1);
    expect(gateCapture(heavy, { ...h, pathCover: { share: 1 }, frontColour: { drawn: 1, n: FAR_LIT_MIN - 1, saturation: 0.7, hueDeg: 40 } }, burstOf()).length).toBe(1);
    // Its head is drawn only in the frame its round is fired, its own shot's flash beside it: reported.
    expect(gateCapture(wall, { ...m, headline: { ...m.headline, ratioTop: 2.9 } }, burstOf())).toEqual([]);
    expect(gateCapture(wall, without(m, 'headline'), burstOf())).toEqual([]);
  });

  it("a Blue capture's far colour is gated against blue: red there fails", () => {
    const c = CAPTURES.find((x) => x.name === 'side-night-blue')!;
    const m = passing(c);
    expect(gateCapture(c, { ...m, farColour: { ...m.farColour, hueDeg: TEAM.blue.hue + TARGET.farHueDeg - 1 } }, burstOf())).toEqual([]);
    expect(gateCapture(c, { ...m, farColour: { ...m.farColour, hueDeg: TEAM.red.hue } }, burstOf()).length).toBe(1);
    const red = CAPTURES.find((x) => x.name === 'side-night')!;
    expect(gateCapture(red, { ...passing(red), farColour: { ...m.farColour, hueDeg: TEAM.blue.hue } }, burstOf()).length).toBe(1);
  });

  it("after dark a far tracer's saturation is gated at its kind's: red's 0.45, Blue's 0.40", () => {
    const at = (c: Capture, saturation: number) => {
      const m = passing(c);
      return gateCapture(c, { ...m, farColour: { ...m.farColour, saturation } }, burstOf());
    };
    for (const name of ['far-night-blue', 'side-night-blue']) {
      const c = CAPTURES.find((x) => x.name === name)!;
      expect(at(c, 0.42), name).toEqual([]);
      expect(at(c, 0.38), name).toHaveLength(1);
    }
    for (const name of ['far-night', 'side-night', 'far-dusk', 'side-dusk']) {
      const c = CAPTURES.find((x) => x.name === name)!;
      expect(at(c, 0.46), name).toEqual([]);
      expect(at(c, 0.44), name).toHaveLength(1);
    }
    // Blue's is red's scaled by how saturated each team's colour is as shown (0.45 × 0.745 / 0.84): a
    // change to either colour asks for it to be derived again.
    expect((TARGET.farSaturation.red * TEAM.blue.saturation) / TEAM.red.saturation).toBeCloseTo(TARGET.farSaturation.blue, 2);
  });

  it("the graze is gated on ricochets of the player's kind, not the front's amber beside them", () => {
    const c = CAPTURES.find((x) => x.name === 'graze-night')!;
    expect(gateCapture(c, passing(c), burstOf([0, 0, 1, 0]))).toEqual([]);
    expect(gateCapture(c, passing(c), burstOf([0, 7, 0, 0])).length).toBe(1);
    expect(gateCapture(c, passing(c), burstOf([0, 7, 0, 4])).length).toBe(1);
  });

  it('a far colour of too few lit pixels is no measure', () => {
    const c = CAPTURES.find((x) => x.name === 'far-night')!;
    const m = passing(c);
    expect(gateCapture(c, { ...m, farColour: { ...m.farColour, n: FAR_LIT_MIN - 1, measured: false } }, burstOf()).length).toBe(1);
  });
});

describe("G1's proof: by day (c) and (e) count a sample shown lit or tinted, after dark lit only", () => {
  // By day a tracer's light covers the bright haze behind it (effects.wgsl tracerLight): a red line over
  // the low sun's haze is darker than the haze, so no sample of it can be lit, and luminance alone could
  // never pass it. Tinted by its team's colour (TINT) it shows what the gate asks: the line is there, in
  // its colour. After dark nothing changes: over the dark sky a tracer's light only adds, and lit it is.
  const haze = [220, 190, 150];
  const violet = [60, 50, 104];
  /** Red's glow covering the haze (tinted, darker than it); a dull line all but the haze's own (neither); red over the night's violet, too faint to be lit there (tinted only). */
  const covering = [250, 80, 55];
  const dull = [205, 180, 150];
  const faint = [150, 40, 40];

  /** A composite as composite() gives one: every pixel's background `back` (its colour, and its luminance as the least), shown as it but where `paint` sets another colour. */
  function compositeOf(back: readonly number[], paint: (set: (x: number, y: number, c: readonly number[]) => void) => void): Composite {
    const shown = image(200, 200, back, paint);
    const n = shown.w * shown.h;
    const backs = new Uint8Array(n * 3);
    for (let p = 0; p < n; p++) backs.set(back, p * 3);
    return { ...shown, least: new Float32Array(n).fill(luminance(back[0], back[1], back[2])), back: backs };
  }

  // (c): a round's path seen side on by frameOf's camera, 20 to 60 m of its flight along +x, 40 m out:
  // on the image's row 100 from x 50 to 150, read 1.5 px either side of it.
  const origin = [-40, 0, 40];
  const side: Track = { seen: [], path: { fit: 'drawn', origin, dir: [1, 0, 0], lastFlownM: 60, point: (s) => [origin[0] + s, origin[1], origin[2]] } };
  const alongPath = (c: readonly number[]) => (set: (x: number, y: number, c: readonly number[]) => void) => {
    for (let y = 98; y <= 102; y++) for (let x = 45; x <= 155; x++) set(x, y, c);
  };
  const cover = (comp: Composite, team: typeof TEAM.red, day: boolean) => pathCover(comp, [frameOf(0, [])], side, false, null, team, day);

  // (e): the stream from the hip, from a muzzle at the view's bottom right (on the image 94 px from the
  // point of aim) to the point of aim 30 m out: on the image's diagonal, from 79 px out to the middle.
  const muzzle: [number, number, number] = [2, -2, 3];
  const hip: Frame[] = [{ ...frameOf(0, []), muzzle }];
  const stream: Track = { seen: [{ frame: 0, t: { kind: 2, flown: 30, headDrawn: true, head: null, tail: null, headM: [0, 0, 30], tailM: muzzle, joinsM: 30 } }], path: null };
  const alongStream = (c: readonly number[]) => (set: (x: number, y: number, c: readonly number[]) => void) => {
    for (let x = 95; x <= 175; x++) for (let d = -1; d <= 1; d++) if (x + d >= 0 && x + d < 200) set(x, x + d, c);
  };
  const capture = (name: string) => CAPTURES.find((x) => x.name === name)!;

  it('(c) by day: a path tinted by its team covering the haze is shown, none of it lit; one neither lit nor tinted is not', () => {
    for (const [name, team, colour] of [['side-1735', TEAM.red, covering], ['side-1735-heavy', TEAM.red, covering], ['side-1735-blue', TEAM.blue, [121, 164, 252]], ['side-noon', TEAM.red, covering]] as const) {
      const c = capture(name);
      expect(byDay(c), name).toBe(true);
      const tintedPath = cover(compositeOf(haze, alongPath(colour)), team, true);
      expect(tintedPath.share, name).toBe(1);
      // The lit-only share reported beside it: none.
      expect(tintedPath.litShare, name).toBe(0);
      expect(gateCapture(c, { ...passing(c), pathCover: tintedPath }, burstOf()), name).toEqual([]);
      const neither = cover(compositeOf(haze, alongPath(dull)), team, true);
      expect(neither.share, name).toBe(0);
      expect(gateCapture(c, { ...passing(c), pathCover: neither }, burstOf()), name).toHaveLength(1);
    }
  });

  it('(e) by day: a stream from the hip tinted by its team covering the haze is shown, as far out as it is drawn; one neither lit nor tinted is not', () => {
    for (const name of ['noon', '1735']) {
      const c = capture(name);
      const e = streamCover(compositeOf(haze, alongStream(covering)), hip, stream, TEAM.red, true);
      expect(e.share, name).toBe(1);
      // From 79 px out, the muzzle 94 px out.
      expect(e.span, name).toBeCloseTo(79.3 / 94.3, 2);
      // The lit-only share and span reported beside them: none.
      expect(e.lit.share, name).toBe(0);
      expect(e.lit.span, name).toBe(0);
      expect(gateCapture(c, { ...passing(c), stream: e }, burstOf()), name).toEqual([]);
      const neither = streamCover(compositeOf(haze, alongStream(dull)), hip, stream, TEAM.red, true);
      expect(neither.share, name).toBe(0);
      expect(gateCapture(c, { ...passing(c), stream: neither }, burstOf()), name).toHaveLength(1);
    }
  });

  it('(c) and (e) after dark: a sample tinted and not lit is not shown, and a lit one is, as before', () => {
    const sideNight = capture('side-night');
    const night = capture('night');
    expect(byDay(sideNight) || byDay(night)).toBe(false);
    const tintedPath = cover(compositeOf(violet, alongPath(faint)), TEAM.red, false);
    expect(tintedPath.share).toBe(0);
    expect(gateCapture(sideNight, { ...passing(sideNight), pathCover: tintedPath }, burstOf())).toHaveLength(1);
    const tintedStream = streamCover(compositeOf(violet, alongStream(faint)), hip, stream, TEAM.red, false);
    expect(tintedStream.share).toBe(0);
    expect(gateCapture(night, { ...passing(night), stream: tintedStream }, burstOf())).toHaveLength(1);
    // Lit over the dark sky: shown, by day or not.
    const bright = [255, 120, 110];
    for (const day of [false, true]) {
      expect(cover(compositeOf(violet, alongPath(bright)), TEAM.red, day).share).toBe(1);
      expect(streamCover(compositeOf(violet, alongStream(bright)), hip, stream, TEAM.red, day).share).toBe(1);
    }
    expect(gateCapture(sideNight, { ...passing(sideNight), pathCover: cover(compositeOf(violet, alongPath(bright)), TEAM.red, false) }, burstOf())).toEqual([]);
  });
});
