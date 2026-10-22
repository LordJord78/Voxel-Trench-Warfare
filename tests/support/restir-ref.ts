/**
 * ReSTIR's reservoir arithmetic (restir.wgsl) on the CPU, for one lighting pixel (Bitterli et al.
 * 2020, with the generalised RIS of Lin et al. 2022): candidates drawn uniformly from the pixel's
 * cell list and resampled to one by their target, then last frame's reservoir merged in, weighed
 * by its light's target now (`resample`); then its neighbours' reservoirs shared in, each weighed
 * by its light's target at this pixel (`share`). The chosen light's contribution weight W is
 * normalised by Z, the candidates of the reservoirs that could have drawn it: in the temporal
 * merge, this frame's if it is in the cell's list and the history's if its light reached the pixel
 * last frame. The spatial merge weighs each reservoir's light instead by the generalised balance
 * heuristic (Lin et al. 2022): its share of that light among all the reservoirs, by their
 * confidence and the light's target at their pixels, which keeps a light far brighter here than
 * where it was drawn from swamping the rest. A pixel's own reservoir is trusted for the candidates
 * it stands for; a neighbour's for at most one frame's (`confidence`): its history is for its own
 * pixel. The shared reservoir is what the pixel shades by; its history next frame is its own,
 * unshared. A light's estimate is f(y) × W.
 */

export const NONE = -1;
export const CANDIDATES = 8;
/** The most candidates a history stands for when it is merged: 20 frames' worth. */
export const HISTORY_MAX = 20 * CANDIDATES;

export interface Reservoir {
  light: number;
  /** W: the chosen light's contribution weight. */
  weight: number;
  /** M: the candidates it stands for. */
  count: number;
  /** The chosen light's target where it was chosen. */
  target: number;
}

export const EMPTY: Reservoir = { light: NONE, weight: 0, count: 0, target: 0 };

export interface Pixel {
  /** The lights its cell lists. */
  list: readonly number[];
  /** A light's target here, now (its unshadowed luminance). */
  target: (light: number) => number;
  /** A light's target here last frame, with the lights as they were then. */
  targetBefore: (light: number) => number;
}

/** This frame's reservoir for `pixel`, merging `history` (last frame's, or null), from `random`. */
export function resample(pixel: Pixel, history: Reservoir | null, random: () => number): Reservoir {
  let light = NONE;
  let target = 0;
  let sum = 0;
  let fromHistory = false;
  const count = pixel.list.length;
  const drawn = count > 0 ? CANDIDATES : 0;
  for (let k = 0; k < drawn; k++) {
    const x = pixel.list[Math.min(Math.floor(random() * count), count - 1)];
    const t = pixel.target(x);
    // A candidate's weight: its target over the chance it was drawn, 1 / count.
    const w = t * count;
    const pick = random();
    if (!(w > 0)) continue;
    sum += w;
    if (pick * sum < w) {
      light = x;
      target = t;
    }
  }
  let kept = 0;
  if (history && history.light !== NONE) {
    kept = Math.min(history.count, HISTORY_MAX);
    const t = pixel.target(history.light);
    const w = t * history.weight * kept;
    const pick = random();
    if (w > 0 && Number.isFinite(w)) {
      sum += w;
      if (pick * sum < w) {
        light = history.light;
        target = t;
        fromHistory = true;
      }
    }
  }
  if (light === NONE) return { ...EMPTY, count: drawn + kept };
  const z = (!fromHistory || pixel.list.includes(light) ? drawn : 0) + (pixel.targetBefore(light) > 0 ? kept : 0);
  // No reservoir could have drawn it (a history's light that reached the spot neither then nor in this frame's list).
  if (!(z > 0)) return { ...EMPTY, count: drawn + kept };
  return { light, weight: sum / (z * target), count: drawn + kept, target };
}

/** A neighbour's reservoir, and the target there of any light. */
export interface Neighbour {
  reservoir: Reservoir;
  target: (light: number) => number;
}

/**
 * `own`, this pixel's reservoir, with its neighbours' shared in (the spatial merge), from
 * `random`; each neighbour trusted for at most `confidence` candidates.
 */
export function share(pixel: Pixel, own: Reservoir, neighbours: readonly Neighbour[], random: () => number, confidence = CANDIDATES): Reservoir {
  const all: Neighbour[] = [
    { reservoir: own, target: pixel.target },
    ...neighbours.map((n) => ({ reservoir: { ...n.reservoir, count: Math.min(n.reservoir.count, confidence) }, target: n.target })),
  ];
  let light = NONE;
  let target = 0;
  let sum = 0;
  for (const { reservoir: r, target: there } of all) {
    if (r.light === NONE) continue;
    const t = pixel.target(r.light);
    // This reservoir's share of its light among them all, by their candidates and its target at each pixel.
    const among = all.reduce((d, n) => d + n.reservoir.count * n.target(r.light), 0);
    const w = among > 0 ? ((r.count * there(r.light)) / among) * t * r.weight : 0;
    const pick = random();
    if (!(w > 0) || !Number.isFinite(w)) continue;
    sum += w;
    if (pick * sum < w) {
      light = r.light;
      target = t;
    }
  }
  const count = all.reduce((m, n) => m + n.reservoir.count, 0);
  if (light === NONE) return { ...EMPTY, count };
  return { light, weight: sum / target, count, target };
}
