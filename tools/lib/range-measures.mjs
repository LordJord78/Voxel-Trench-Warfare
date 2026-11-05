// G2's proof's own measures (tools/range-captures.mjs; the shots spec's §5): what it photographs, the range
// up held to what rangeLayout lays, each target's box on the picture by the camera the frame was drawn
// from, what the range changes in that box (the frame with it up against the same frame with it down),
// and the pictures that show it: the frame marked, and a sheet of each target magnified, up beside down.
// Pure but for the PNG codec's images; tests/tools/range-measures.test.ts reads them on synthetic images.
import { basis, project } from './camera.mjs';

/** The hours G1's proof photographed its tracers at (tools/lib/tracer-measures.mjs): noon, 17:35 (solo's opening hour), dusk and night. */
const HOURS = [['noon', 12], ['1735', 17 + 35 / 60], ['dusk', 19.5], ['night', 22.5]];

/** The captures: the Ravine's (solo's map, the visitor's first) by the hour's name, the Corridor's after it. */
export const CAPTURES = [
  ...HOURS.map(([name, hours]) => ({ name, map: 'ravine', hours })),
  ...HOURS.map(([name, hours]) => ({ name: `corridor-${name}`, map: 'corridor', hours })),
];

/** A target's size across and high, metres: a dummy's as it stands (feet to the top of its head, its shoulders), a plate's steel ([range]'s torso_plate_m and head_plate_m). */
export const SIZE_M = { dummy: [0.6, 1.85], mover: [0.6, 1.85], torso: [0.45, 0.6], head: [0.25, 0.3] };
/** Pixels round a target's projected box: its outline, and room for the frame's jitter. */
export const MARGIN_PX = 3;
/** A pixel the range changes: by this much or more in some channel (0-255, as displayed), its frame up against its frame down. */
export const DELTA = 24;
/** A target shows when the range changes this many of its box's pixels by DELTA. Reported, not gated: the eye judges. */
export const SHOW_PIXELS = 4;
/** A projection this near a whole pixel is that pixel (a box's edge is not moved by floating point). */
const EPS_PX = 1e-6;

/** What a layout lays (its spots' kinds): its dummies, standing and walking, and its plates, torso and head. */
export function laidOf(spots) {
  let dummies = 0;
  let plates = 0;
  for (const s of spots) {
    if (s.kind === 'dummy' || s.kind === 'mover') dummies++;
    else if (s.kind === 'torso' || s.kind === 'head') plates++;
  }
  return { dummies, plates };
}

/**
 * What is short of the layout (`laid`, laidOf rangeLayout's spots) in what the hooks say is up (`seen`):
 * the range not up; a layout of no dummies or no plates; fewer dummies listed, standing or drawn, or
 * fewer plates listed or with their steel in the world, than it lays. None: the range is all up.
 */
export function countFailures(laid, seen) {
  const out = [];
  if (!seen.up) out.push('the range is not up');
  if (laid.dummies === 0) out.push('rangeLayout lays no dummies');
  if (laid.plates === 0) out.push('rangeLayout lays no plates');
  const short = (n, of, what) => {
    if (n < of) out.push(`${n} ${what} of the ${of} laid`);
  };
  short(seen.dummies, laid.dummies, 'dummies listed');
  short(seen.standing, laid.dummies, 'dummies standing');
  short(seen.drawn, laid.dummies, 'dummies drawn');
  short(seen.plates, laid.plates, 'plates listed');
  short(seen.steel, laid.plates, "plates' steel in the world");
  return out;
}

/**
 * A target's box on a `res` picture drawn from `pose` (the game's camera: tools/lib/camera.mjs), [x0, y0,
 * x1, y1) in pixels with MARGIN_PX round it; null if any of it is behind the camera. A dummy's (or a
 * mover's) `at` is its feet, its box from them to its head; a plate's is its steel's middle. Its width
 * is taken along the camera's right: the range faces the step, as the camera on it does.
 */
export function targetBox(target, pose, res, margin = MARGIN_PX) {
  const [across, high] = SIZE_M[target.kind];
  const { right } = basis(pose);
  const plate = target.kind === 'torso' || target.kind === 'head';
  const base = plate ? target.at[1] - high / 2 : target.at[1];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const side of [-0.5, 0.5]) {
    for (const up of [0, 1]) {
      const p = project(pose, res, [target.at[0] + right[0] * across * side, base + high * up, target.at[2] + right[2] * across * side]);
      if (p === null) return null;
      x0 = Math.min(x0, p[0]);
      y0 = Math.min(y0, p[1]);
      x1 = Math.max(x1, p[0]);
      y1 = Math.max(y1, p[1]);
    }
  }
  return [Math.floor(x0 + EPS_PX) - margin, Math.floor(y0 + EPS_PX) - margin, Math.ceil(x1 - EPS_PX) + margin, Math.ceil(y1 - EPS_PX) + margin];
}

const sameSize = (up, down) => {
  if (up.w !== down.w || up.h !== down.h) throw new Error(`the frame up is ${up.w}x${up.h}, the frame down ${down.w}x${down.h}`);
};

/** How much pixel `i` (RGBA's index / 4) changes between two frames: its largest channel's change. */
const change = (up, down, i) => {
  const o = i * 4;
  return Math.max(Math.abs(up.data[o] - down.data[o]), Math.abs(up.data[o + 1] - down.data[o + 1]), Math.abs(up.data[o + 2] - down.data[o + 2]));
};

/** Over `box` (where it is in the frame): the pixels the range changes by `delta` or more, the most any changes, and how many pixels it holds. */
export function shows(up, down, box, delta = DELTA) {
  sameSize(up, down);
  const [x0, y0, x1, y1] = [Math.max(0, box[0]), Math.max(0, box[1]), Math.min(up.w, box[2]), Math.min(up.h, box[3])];
  let pixels = 0;
  let peak = 0;
  let area = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const d = change(up, down, y * up.w + x);
      area++;
      peak = Math.max(peak, d);
      if (d >= delta) pixels++;
    }
  }
  return { pixels, peak, area };
}

/** The change between the frames that no target makes: the 99th percentile of it outside every box. */
export function noiseFloor(up, down, boxes) {
  sameSize(up, down);
  const counts = new Float64Array(256);
  let n = 0;
  for (let y = 0; y < up.h; y++) {
    for (let x = 0; x < up.w; x++) {
      if (boxes.some((b) => x >= b[0] && x < b[2] && y >= b[1] && y < b[3])) continue;
      counts[change(up, down, y * up.w + x)]++;
      n++;
    }
  }
  const below = Math.floor(0.99 * n);
  let seen = 0;
  for (let d = 0; d < 256; d++) {
    seen += counts[d];
    if (seen > below) return d;
  }
  return 0;
}

const MAGENTA = [255, 0, 255];
const LABEL_RGB = [255, 220, 0];
const SHEET_BACK = [24, 24, 24];

/** `img` (its RGBA copied) with a 1 px magenta box on the edges of each box: where the measures read. */
export function marked(img, boxes) {
  const data = Uint8Array.from(img.data);
  const put = (x, y) => {
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) return;
    data.set([...MAGENTA, 255], (y * img.w + x) * 4);
  };
  for (const [x0, y0, x1, y1] of boxes) {
    for (let x = x0; x < x1; x++) {
      put(x, y0);
      put(x, y1 - 1);
    }
    for (let y = y0; y < y1; y++) {
      put(x0, y);
      put(x1 - 1, y);
    }
  }
  return { data, w: img.w, h: img.h };
}

// A 3 × 5 font for the sheet's labels: a target's kind (D a dummy, M a mover, T a torso plate, H a head
// plate) and its distance out.
const GLYPHS = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '001', '001', '001'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
  D: ['110', '101', '101', '101', '110'],
  M: ['101', '111', '111', '101', '101'],
  T: ['111', '010', '010', '010', '010'],
  H: ['101', '101', '111', '101', '101'],
  ' ': ['000', '000', '000', '000', '000'],
};

/** The sheet's layout: cells, a pair's up and down apart, pairs apart and from the edges, the label's strip over each pair, pairs to a row; the least of a frame a cell shows, and the label's scale. */
const SHEET = { cell: 192, pairGap: 6, gap: 18, label: 20, columns: 2, minCrop: 48, glyph: 3 };

/**
 * Each target's neighbourhood magnified, the frame up beside the frame down, `labels[i]` over the pair
 * (the font's letters and digits), two pairs to a row. A target's crop is a square about its box's
 * middle, at least SHEET.minCrop and its box's larger side and 8 more, as many whole times over as fit
 * a cell, its box outlined a pixel outside it in both.
 */
export function sheet(up, down, boxes, labels) {
  sameSize(up, down);
  for (const l of labels) for (const c of l) if (!GLYPHS[c]) throw new Error(`the sheet's font has no '${c}' (label '${l}')`);
  const { cell, pairGap, gap, label, columns, minCrop, glyph } = SHEET;
  const pairW = 2 * cell + pairGap;
  const rows = Math.ceil(boxes.length / columns);
  const w = gap + columns * (pairW + gap);
  const h = rows * (label + cell) + gap;
  const data = new Uint8Array(w * h * 4);
  const put = (x, y, rgb) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    data.set([rgb[0], rgb[1], rgb[2], 255], (y * w + x) * 4);
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x, y, SHEET_BACK);
  boxes.forEach((box, i) => {
    const px = gap + (i % columns) * (pairW + gap);
    const py = Math.floor(i / columns) * (label + cell) + label;
    const crop = Math.min(cell, Math.max(minCrop, Math.max(box[2] - box[0], box[3] - box[1]) + 8));
    const scale = Math.max(1, Math.floor(cell / crop));
    const inset = Math.floor((cell - crop * scale) / 2);
    const ox = Math.max(0, Math.min(up.w - crop, Math.floor((box[0] + box[2]) / 2) - crop / 2));
    const oy = Math.max(0, Math.min(up.h - crop, Math.floor((box[1] + box[3]) / 2) - crop / 2));
    for (const [img, cx] of [[up, px], [down, px + cell + pairGap]]) {
      for (let y = 0; y < crop; y++) {
        for (let x = 0; x < crop; x++) {
          const sx = Math.floor(ox) + x;
          const sy = Math.floor(oy) + y;
          if (sx < 0 || sy < 0 || sx >= img.w || sy >= img.h) continue;
          const o = (sy * img.w + sx) * 4;
          const rgb = [img.data[o], img.data[o + 1], img.data[o + 2]];
          for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) put(cx + inset + x * scale + dx, py + inset + y * scale + dy, rgb);
        }
      }
      // The box, a pixel outside its scaled edges.
      const bx0 = cx + inset + (box[0] - Math.floor(ox)) * scale - 1;
      const by0 = py + inset + (box[1] - Math.floor(oy)) * scale - 1;
      const bx1 = cx + inset + (box[2] - Math.floor(ox)) * scale;
      const by1 = py + inset + (box[3] - Math.floor(oy)) * scale;
      const inCell = (x, y) => x >= cx && x < cx + cell && y >= py && y < py + cell;
      for (let x = bx0; x <= bx1; x++) {
        if (inCell(x, by0)) put(x, by0, MAGENTA);
        if (inCell(x, by1)) put(x, by1, MAGENTA);
      }
      for (let y = by0; y <= by1; y++) {
        if (inCell(bx0, y)) put(bx0, y, MAGENTA);
        if (inCell(bx1, y)) put(bx1, y, MAGENTA);
      }
    }
    // Its label over the pair.
    [...(labels[i] ?? '')].forEach((c, k) => {
      GLYPHS[c].forEach((row, gy) => {
        for (let gx = 0; gx < 3; gx++) {
          if (row[gx] !== '1') continue;
          for (let dy = 0; dy < glyph; dy++) for (let dx = 0; dx < glyph; dx++) put(px + 2 + k * 4 * glyph + gx * glyph + dx, py - label + 2 + gy * glyph + dy, LABEL_RGB);
        }
      });
    });
  });
  return { data, w, h };
}
