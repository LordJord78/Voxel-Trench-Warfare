// Measures over screenshots as displayed, for the capture tools (tools/tracer-captures.mjs; G2's range
// captures): sRGB-encoded 0-255 RGBA, luminance by Rec. 709 weights on those values. A decoded image,
// a run of frames as the eye holds a stream (each pixel as its frame most unlike its background, its
// least over the frames no tracer is drawn near it), a ring's mean round a point, the brightest pixel
// and channel near one, colour as HSV, and whether a pixel is lit over its background. Pure but for the PNG codec; tests/tools/
// capture-measures.test.ts reads them on synthetic images.
import { PNG } from 'pngjs';

/** Displayed luminance of sRGB-encoded channels (0-255): Rec. 709's weights. */
export const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** A decoded PNG: its RGBA, its displayed luminance, its size. */
export function decode(buffer) {
  const png = PNG.sync.read(buffer);
  const lum = new Float32Array(png.width * png.height);
  for (let i = 0; i < lum.length; i++) lum[i] = luminance(png.data[i * 4], png.data[i * 4 + 1], png.data[i * 4 + 2]);
  return { data: png.data, lum, w: png.width, h: png.height };
}

/** RGBA (w × h × 4 bytes) as a PNG. */
export function encode(data, w, h) {
  const png = new PNG({ width: w, height: h });
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(png.data);
  return PNG.sync.write(png);
}

/**
 * The frames as the eye holds them. Each pixel's background: its least luminance over the frames in which
 * no tracer is drawn near it (`near[i]`, a byte a pixel, if given; over every frame when none is clear),
 * and that frame's colour (`back`). Each pixel shown as its frame most unlike that background (the
 * farthest in RGB): a tracer's light added shows as its brightest frame, as each channel's most over the
 * frames did, and one that covers a bright haze behind it (by day: effects.wgsl tracerLight) shows as it
 * is drawn, darker and redder, where each channel's most gave its red over the haze's green and blue.
 */
export function composite(imgs, near = null) {
  const { w, h } = imgs[0];
  for (const img of imgs.slice(1)) if (img.w !== w || img.h !== h) throw new Error(`a frame is ${img.w}x${img.h}, the first ${w}x${h}`);
  if (near && near.length !== imgs.length) throw new Error(`${near.length} masks for ${imgs.length} frames`);
  const n = w * h;
  const data = Buffer.alloc(n * 4);
  const least = new Float32Array(n);
  const back = new Uint8Array(n * 3);
  for (let p = 0; p < n; p++) {
    let bi = -1;
    let bl = Infinity;
    for (let i = 0; i < imgs.length; i++) {
      if (near && near[i][p]) continue;
      if (imgs[i].lum[p] < bl) {
        bl = imgs[i].lum[p];
        bi = i;
      }
    }
    if (bi < 0) {
      for (let i = 0; i < imgs.length; i++) {
        if (imgs[i].lum[p] < bl) {
          bl = imgs[i].lum[p];
          bi = i;
        }
      }
    }
    least[p] = bl;
    const o = p * 4;
    const B = imgs[bi].data;
    const [r0, g0, b0] = [B[o], B[o + 1], B[o + 2]];
    back[p * 3] = r0;
    back[p * 3 + 1] = g0;
    back[p * 3 + 2] = b0;
    let mi = bi;
    let md = -1;
    for (let i = 0; i < imgs.length; i++) {
      const D = imgs[i].data;
      const d = (D[o] - r0) ** 2 + (D[o + 1] - g0) ** 2 + (D[o + 2] - b0) ** 2;
      if (d > md) {
        md = d;
        mi = i;
      }
    }
    const M = imgs[mi].data;
    data[o] = M[o];
    data[o + 1] = M[o + 1];
    data[o + 2] = M[o + 2];
    data[o + 3] = M[o + 3];
  }
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = luminance(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  return { data, lum, least, back, w, h };
}

/** The index of the pixel under a point (continuous pixels), or -1 off the image. */
export function at(img, q) {
  const x = Math.floor(q[0]);
  const y = Math.floor(q[1]);
  return x < 0 || y < 0 || x >= img.w || y >= img.h ? -1 : y * img.w + x;
}

/** The mean luminance of an annulus `radii` ([inner, outer], pixels) round (cx, cy), its mean brightest channel (V) and each channel's mean, but where `drop(x, y, lum)` says: nulls when no pixel is left. */
export function ringMean(img, cx, cy, radii, drop = () => false) {
  let sum = 0;
  let sumV = 0;
  const sumC = [0, 0, 0];
  let n = 0;
  let dropped = 0;
  for (let y = Math.max(0, cy - radii[1]); y <= Math.min(img.h - 1, cy + radii[1]); y++) {
    for (let x = Math.max(0, cx - radii[1]); x <= Math.min(img.w - 1, cx + radii[1]); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < radii[0] || d > radii[1]) continue;
      const k = y * img.w + x;
      if (drop(x, y, img.lum[k])) {
        dropped++;
        continue;
      }
      sum += img.lum[k];
      sumV += Math.max(img.data[k * 4], img.data[k * 4 + 1], img.data[k * 4 + 2]);
      for (let c = 0; c < 3; c++) sumC[c] += img.data[k * 4 + c];
      n++;
    }
  }
  return { mean: n > 0 ? sum / n : null, meanV: n > 0 ? sumV / n : null, meanRGB: n > 0 ? sumC.map((v) => v / n) : null, n, dropped };
}

/** The brightest pixel's luminance within `r` (Chebyshev) of (cx, cy). */
export function brightest(img, cx, cy, r) {
  let best = 0;
  for (let y = Math.max(0, cy - r); y <= Math.min(img.h - 1, cy + r); y++) for (let x = Math.max(0, cx - r); x <= Math.min(img.w - 1, cx + r); x++) best = Math.max(best, img.lum[y * img.w + x]);
  return best;
}

/**
 * The highest value of any channel within `r` (Chebyshev) of (cx, cy), and which channel holds it (0 R,
 * 1 G, 2 B). On a tie (a white-hot pixel holds all three at the display's top), `prefer`'s if it is one
 * of them (a tracer's team's channel: a blue head read in blue), else the first of R, G and B.
 */
export function topChannel(img, cx, cy, r, prefer = 0) {
  const most = [0, 0, 0];
  for (let y = Math.max(0, cy - r); y <= Math.min(img.h - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(img.w - 1, cx + r); x++) {
      for (let k = 0; k < 3; k++) most[k] = Math.max(most[k], img.data[(y * img.w + x) * 4 + k]);
    }
  }
  const value = Math.max(...most);
  return { value, channel: most[prefer] === value ? prefer : most.indexOf(value) };
}

/** HSV hue (degrees), saturation and chroma of an sRGB colour (0-255). */
export function hsv([r, g, b]) {
  const top = Math.max(r, g, b);
  const low = Math.min(r, g, b);
  const c = top - low;
  let h = 0;
  if (c > 0) h = top === r ? ((g - b) / c) % 6 : top === g ? (b - r) / c + 2 : (r - g) / c + 4;
  return { hue: (((h * 60) % 360) + 360) % 360, saturation: top > 0 ? c / top : 0, chroma: c };
}

/** How far apart two hues are (degrees, 0 to 180). */
export const hueOff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

/** Pixels' colour: their mean saturation, and their mean hue (a circular mean, each weighted by its chroma); nulls for none. */
export function colourOf(pixels) {
  if (pixels.length === 0) return { saturation: null, hueDeg: null, n: 0 };
  let sx = 0;
  let sy = 0;
  let sat = 0;
  for (const p of pixels) {
    const c = hsv(p.rgb);
    sat += c.saturation;
    sx += c.chroma * Math.cos((c.hue * Math.PI) / 180);
    sy += c.chroma * Math.sin((c.hue * Math.PI) / 180);
  }
  return { saturation: sat / pixels.length, hueDeg: (((Math.atan2(sy, sx) * 180) / Math.PI) + 360) % 360, n: pixels.length };
}

/** Whether a pixel of luminance `v` is lit over its background `bg`: `rule.ratio` times it, and `rule.min` steps over it. */
export const lit = (v, bg, rule) => v >= Math.max(rule.ratio * bg, bg + rule.min);

/** The pixels within `r` of `q` on `img` lit (`rule`) over the composite's least, each once (`taken`), pushed to `out` with their colour. */
export function litNear(img, comp, q, r, taken, out, rule) {
  for (let y = Math.floor(q[1] - r); y <= Math.floor(q[1] + r); y++) {
    for (let x = Math.floor(q[0] - r); x <= Math.floor(q[0] + r); x++) {
      if (x < 0 || y < 0 || x >= img.w || y >= img.h || Math.hypot(x + 0.5 - q[0], y + 0.5 - q[1]) > r) continue;
      const k = y * img.w + x;
      if (taken.has(k)) continue;
      taken.add(k);
      if (!lit(img.lum[k], comp.least[k], rule)) continue;
      out.push({ at: [x, y], rgb: [img.data[k * 4], img.data[k * 4 + 1], img.data[k * 4 + 2]] });
    }
  }
}

/** The value `share` of the way up the sorted values (0 the least, 1 the most), or null for none. */
export function percentile(values, share) {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * share))] : null;
}

/** The middle value, or null for none. */
export const median = (values) => percentile(values, 0.5);

/** The 95th percentile, or null for none. */
export const p95 = (values) => percentile(values, 0.95);

/** To three decimals; null stays null. */
export const round3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
