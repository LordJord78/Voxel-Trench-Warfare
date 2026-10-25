/**
 * Quality tiers (the showcase spec's §4): the presets that exist, high and low, with dynamic resolution
 * between 50% and 100% of the image per axis holding the frame under the budget within either. A first
 * visit at the high preset is warmed up as the world is first drawn: when even dynamic resolution's
 * floor cannot hold the budget, it moves to low (for the visit; a preset the visitor chose is never
 * moved). This is the judgement; main.ts runs it.
 */

/** Frames drawn after the world is first drawn that the warm-up runs over, and the last of them it judges. */
export const WARMUP_FRAMES = 120;
export const JUDGED_FRAMES = 60;
/** Frames with a GPU time the judgement needs. */
const COUNTED = 30;

/**
 * Over the judged frames (their dynamic-resolution scale, and their GPU time where one was measured):
 * low when every one sat at the floor and the median of the measured is over the budget; else none.
 */
export function pickPreset(frames: readonly { gpuMs: number | null; scale: number }[], budgetMs: number, floor = 0.5): 'low' | null {
  const measured = frames.flatMap((f) => (f.gpuMs === null ? [] : [f.gpuMs])).sort((a, b) => a - b);
  if (measured.length < COUNTED) return null;
  if (!frames.every((f) => f.scale <= floor)) return null;
  return measured[Math.floor(measured.length / 2)] > budgetMs ? 'low' : null;
}
