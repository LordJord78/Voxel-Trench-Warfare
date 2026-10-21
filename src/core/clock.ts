/**
 * Fixed-timestep simulation clock, decoupled from rendering.
 *
 * The simulation only ever advances in whole 1/60 s ticks. Frames happen at
 * whatever rate the display runs and interpolate with `alpha`. Ported from the
 * Python game's `core/loop.py`, plus one rule browsers need: a negative or NaN
 * frame delta (clock skew, a backgrounded tab) runs nothing.
 */

export const TICK_HZ = 60;
export const TICK_DT = 1 / TICK_HZ;

export class FixedClock {
  readonly tickHz: number;
  /** Ceiling on catch-up ticks per frame, so a stall cannot spiral. */
  readonly maxSubsteps: number;
  private accumulator = 0;
  private _tick = 0;
  private _dropped = 0;
  private _alpha = 0;

  constructor(tickHz = TICK_HZ, maxSubsteps = 5) {
    this.tickHz = tickHz;
    this.maxSubsteps = maxSubsteps;
  }

  get dt(): number {
    return 1 / this.tickHz;
  }

  get tick(): number {
    return this._tick;
  }

  /** Fraction into the next tick, for render interpolation. */
  get alpha(): number {
    return this._alpha;
  }

  get simTime(): number {
    return this._tick * this.dt;
  }

  get droppedTicks(): number {
    return this._dropped;
  }

  /** Feed a frame's wall-clock delta; returns how many ticks to run. */
  advance(realDt: number): number {
    const delta = realDt > 0 ? Math.min(realDt, 0.25) : 0;
    this.accumulator += delta;
    let steps = Math.trunc(this.accumulator / this.dt);
    if (steps > this.maxSubsteps) {
      this._dropped += steps - this.maxSubsteps;
      this.accumulator = this.dt * this.maxSubsteps + (this.accumulator % this.dt);
      steps = this.maxSubsteps;
    }
    this.accumulator -= steps * this.dt;
    this._alpha = this.accumulator / this.dt;
    this._tick += steps;
    return steps;
  }
}

export interface FrameSummary {
  mean: number;
  p50: number;
  p95: number;
  max: number;
  fps: number;
}

/** Rolling frame-time record, in milliseconds. */
export class FrameStats {
  readonly capacity: number;
  private samples: number[] = [];

  constructor(capacity = 240) {
    this.capacity = capacity;
  }

  record(seconds: number): void {
    this.samples.push(seconds * 1000);
    if (this.samples.length > this.capacity) this.samples.splice(0, this.samples.length - this.capacity);
  }

  summary(): FrameSummary {
    if (this.samples.length === 0) return { mean: 0, p50: 0, p95: 0, max: 0, fps: 0 };
    const ordered = [...this.samples].sort((a, b) => a - b);
    const n = ordered.length;
    const mean = ordered.reduce((s, v) => s + v, 0) / n;
    return {
      mean,
      p50: ordered[Math.floor(n / 2)],
      p95: ordered[Math.min(n - 1, Math.floor(n * 0.95))],
      max: ordered[n - 1],
      fps: mean > 0 ? 1000 / mean : 0,
    };
  }
}
