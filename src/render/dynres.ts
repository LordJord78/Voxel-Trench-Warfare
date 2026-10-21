/**
 * Dynamic resolution: the internal image's scale per axis, from 50% to 100%,
 * chosen to keep the GPU frame under its budget. Frame times are smoothed;
 * every 30 frames the scale drops at once by as much as the overrun calls for
 * (the cost goes with the square of the scale), or creeps back up a step when
 * there is plenty of room. A frame over 250 ms is a hidden tab or a hitch,
 * not the GPU's speed, and is ignored.
 */

export interface DynamicResolutionOptions {
  min: number;
  max: number;
  step: number;
  every: number;
  ignoreOverMs: number;
}

const DEFAULTS: DynamicResolutionOptions = { min: 0.5, max: 1, step: 1 / 32, every: 30, ignoreOverMs: 250 };

export class DynamicResolution {
  scale: number;
  /** The frame time to hold under, in ms. */
  budget: number;
  private readonly options: DynamicResolutionOptions;
  private average: number | null = null;
  private frames = 0;

  constructor(budgetMs: number, options: Partial<DynamicResolutionOptions> = {}) {
    this.budget = budgetMs;
    this.options = { ...DEFAULTS, ...options };
    this.scale = this.options.max;
  }

  /** One frame's GPU time (or frame interval); returns the scale to render the next frame at. */
  update(ms: number): number {
    const o = this.options;
    if (!(ms > 0) || ms > o.ignoreOverMs) return this.scale;
    this.average = this.average === null ? ms : this.average * 0.9 + ms * 0.1;
    if (++this.frames % o.every !== 0) return this.scale;
    if (this.average > this.budget * 1.05) {
      const want = this.scale * Math.sqrt(this.budget / this.average);
      this.scale = Math.max(o.min, Math.floor(want / o.step) * o.step);
    } else if (this.average < this.budget * 0.8) {
      this.scale = Math.min(o.max, this.scale + o.step);
    }
    return this.scale;
  }
}
