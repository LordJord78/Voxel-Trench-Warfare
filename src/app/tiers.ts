/**
 * Quality tiers (the showcase spec's §4): the presets that exist, high and low, with dynamic resolution
 * between 50% and 100% of the image per axis holding the frame under the budget within either. A first
 * visit at the high preset is warmed up as the world is first drawn: when even dynamic resolution's
 * floor could not hold the budget, it moves to low (for the visit; a preset the visitor chose is never
 * moved). This is the judgement; main.ts runs it.
 */

/** Frames drawn after the world is first drawn that the warm-up runs over, and the last of them it judges. */
export const WARMUP_FRAMES = 120;
export const JUDGED_FRAMES = 60;
/** Frames with a GPU time the judgement needs. */
const COUNTED = 30;
/** Frames a GPU time can be late (the timestamps' readback ring, render/timing.ts). */
const LAG_MAX = 3;

/**
 * Over the judged frames (their dynamic-resolution scale, and their GPU time where one was measured):
 * low when the floor could not hold the budget. Each time is counted down to the floor's pixels, which
 * it cannot be less than (some of a frame's work does not shrink with them), and their median is
 * compared with the budget. Else none.
 */
export function pickPreset(frames: readonly { gpuMs: number | null; scale: number }[], budgetMs: number, floor = 0.5): 'low' | null {
  const atFloor = frames.flatMap((f) => (f.gpuMs === null ? [] : [f.gpuMs * (floor / f.scale) * (floor / f.scale)])).sort((a, b) => a - b);
  if (atFloor.length < COUNTED) return null;
  return atFloor[Math.floor(atFloor.length / 2)] > budgetMs ? 'low' : null;
}

/**
 * The warm-up's frames as they are drawn: each frame's scale, and the GPU time newly measured with it.
 * That time is a few frames old, so it counts only where the scale held over those frames, and so is
 * the scale it was drawn at.
 */
export class Warmup {
  readonly frames: { gpuMs: number | null; scale: number }[] = [];
  private drawn = 0;
  private readonly recent: number[] = [];

  frame(scale: number, gpuMs: number | null): void {
    this.recent.push(scale);
    if (this.recent.length > LAG_MAX + 1) this.recent.shift();
    if (this.drawn++ < WARMUP_FRAMES - JUDGED_FRAMES) return;
    const held = this.recent.length === LAG_MAX + 1 && this.recent.every((s) => s === scale);
    this.frames.push({ gpuMs: held ? gpuMs : null, scale });
  }

  get done(): boolean {
    return this.drawn >= WARMUP_FRAMES;
  }

  pick(budgetMs: number, floor = 0.5): 'low' | null {
    return pickPreset(this.frames, budgetMs, floor);
  }
}
