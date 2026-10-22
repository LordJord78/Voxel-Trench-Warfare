/**
 * The exposure's metering and adaptation (histogram.wgsl), for checking the GPU by: the frame's log2
 * luminance, under the exposure reckoned from the light, counted in 128 bins over [-12, +4) stops;
 * the mean of the counts between the darkest 50% and the brightest 2%; how far that lies beyond a
 * zone round the norm; and the exposure's correction moving toward it at its rates.
 */

export const BINS = 128;
export const LOW = -12;
export const HIGH = 4;
const WIDTH = (HIGH - LOW) / BINS;

/** The bin a pixel of luminance `lum` under exposure `base` counts in, or null if it counts in none (not finite, not above zero). */
export function binOf(lum: number, base: number): number | null {
  const l = Math.fround(lum * base);
  if (!Number.isFinite(l) || !(l > 0)) return null;
  return Math.min(BINS - 1, Math.max(0, Math.floor((Math.log2(l) - LOW) / WIDTH)));
}

/** A bin's middle, in stops. */
export const centre = (bin: number) => LOW + (bin + 0.5) * WIDTH;

/** The counts of `lums` under `base`. */
export function histogram(lums: Iterable<number>, base: number): number[] {
  const counts = new Array<number>(BINS).fill(0);
  for (const l of lums) {
    const b = binOf(l, base);
    if (b !== null) counts[b]++;
  }
  return counts;
}

/** The mean, in stops, of the counts between the darkest 50% and the brightest 2%, bins at their middles; `otherwise` if nothing was counted. */
export function meteredMean(counts: readonly number[], otherwise: number): number {
  const n = counts.reduce((a, b) => a + b, 0);
  if (n === 0) return otherwise;
  const [lo, hi] = [0.5 * n, 0.98 * n];
  let below = 0;
  let sum = 0;
  let weight = 0;
  counts.forEach((c, bin) => {
    const w = Math.max(0, Math.min(below + c, hi) - Math.max(below, lo));
    sum += w * centre(bin);
    weight += w;
    below += c;
  });
  return weight > 0 ? sum / weight : otherwise;
}

/** How far, in stops, to correct a view metered at `metered` toward `target`: none within `zone` of it, the excess beyond. */
export function zoneCorrection(target: number, metered: number, zone: number): number {
  const d = target - metered;
  const excess = Math.abs(d) - zone;
  return excess > 0 ? Math.sign(d) * excess : 0;
}

/** The correction `c` a frame of `dt` seconds later, toward `want`: rising (a darker scene) at most `rise` stops a second, falling (a brighter one) at most `fall`. */
export function adapt(c: number, want: number, dt: number, rise: number, fall: number): number {
  return want > c ? c + Math.min(want - c, rise * dt) : c - Math.min(c - want, fall * dt);
}
