/**
 * Per-pass GPU time from timestamp queries. Every pass writes a timestamp as
 * it begins and ends; the frame resolves them into one of three readback
 * buffers, and the times arrive a frame or two later, smoothed. A frame's GPU
 * time is its first pass's start to its last pass's end. Without timestamp
 * queries nothing is measured here: the renderer measures the interval
 * between frames instead, against frameBudget's allowance for the display.
 */

const RING = 3;

/** 60 Hz with a third to spare. */
const INTERVAL_BUDGET_MS = (1000 / 60) * (4 / 3);

/**
 * The time dynamic resolution holds a frame to. With timestamps that is GPU
 * time, against `gpuBudgetMs`. Without them it is the interval between
 * frames, which the display paces: a frame that keeps up with 60 Hz must read
 * as room to grow, and one that misses every other refresh as over budget.
 */
export function frameBudget(timestamps: boolean, gpuBudgetMs: number): number {
  return timestamps ? gpuBudgetMs : Math.max(gpuBudgetMs, INTERVAL_BUDGET_MS);
}

export interface PassStamps {
  name: string;
  /** Nanoseconds; a pass the GPU did not time has end <= begin. */
  begin: number;
  end: number;
}

/**
 * Milliseconds per pass, in submission order, and for the frame (first start
 * to last end). A pass is timed from the later of its own start and the
 * previous pass's end: on a tile-based GPU a render pass's vertex work starts
 * while the compute passes it waits on still run, and that wait is theirs.
 */
export function passTimes(stamps: readonly PassStamps[]): { passes: Record<string, number>; frameMs: number | null } {
  const passes: Record<string, number> = {};
  let first = Infinity;
  let last = -Infinity;
  for (const { name, begin, end } of stamps) {
    if (!(end > begin)) continue;
    passes[name] = (end - Math.max(begin, last)) / 1e6;
    first = Math.min(first, begin);
    last = Math.max(last, end);
  }
  return { passes, frameMs: last > first ? (last - first) / 1e6 : null };
}

export class GpuTimer {
  readonly enabled: boolean;
  /** Smoothed milliseconds per pass, and for the whole frame. */
  passes: Record<string, number> = {};
  gpuMs: number | null = null;
  /** The latest measured frame, unsmoothed, and how many frames have been measured. */
  lastMs: number | null = null;
  samples = 0;
  private readonly names: readonly string[];
  private readonly querySet: GPUQuerySet | null = null;
  private readonly resolveBuffer: GPUBuffer | null = null;
  private readonly ring: { buffer: GPUBuffer; free: boolean; used: string[] }[] = [];
  private used: string[] = [];
  private pending: { buffer: GPUBuffer; free: boolean; used: string[] } | null = null;

  constructor(device: GPUDevice, enabled: boolean, names: readonly string[]) {
    this.enabled = enabled;
    this.names = names;
    if (!enabled) return;
    const count = names.length * 2;
    this.querySet = device.createQuerySet({ type: 'timestamp', count });
    this.resolveBuffer = device.createBuffer({ size: count * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    for (let i = 0; i < RING; i++) {
      this.ring.push({ buffer: device.createBuffer({ size: count * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), free: true, used: [] });
    }
  }

  /** The timestamp writes for a pass, if timing is on. */
  writes(name: string): GPUComputePassTimestampWrites | undefined {
    if (!this.querySet) return undefined;
    const i = this.names.indexOf(name);
    if (i < 0) throw new Error(`no timer slot for pass '${name}'`);
    this.used.push(name);
    return { querySet: this.querySet, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 };
  }

  /** After the frame's passes are encoded: copy their timestamps toward a free readback buffer. */
  resolve(encoder: GPUCommandEncoder): void {
    const used = this.used;
    this.used = [];
    if (!this.querySet || !this.resolveBuffer || used.length === 0) return;
    const slot = this.ring.find((r) => r.free);
    if (!slot) return;
    encoder.resolveQuerySet(this.querySet, 0, this.names.length * 2, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, slot.buffer, 0, this.names.length * 16);
    slot.free = false;
    slot.used = used;
    this.pending = slot;
  }

  /** After submit: read this frame's timestamps when the GPU has them. */
  collect(): void {
    const slot = this.pending;
    this.pending = null;
    if (!slot) return;
    slot.buffer.mapAsync(GPUMapMode.READ).then(
      () => {
        const t = new BigUint64Array(slot.buffer.getMappedRange());
        const { passes, frameMs } = passTimes(
          slot.used.map((name) => {
            const i = this.names.indexOf(name);
            return { name, begin: Number(t[2 * i]), end: Number(t[2 * i + 1]) };
          }),
        );
        for (const [name, ms] of Object.entries(passes)) {
          this.passes[name] = this.passes[name] === undefined ? ms : this.passes[name] * 0.9 + ms * 0.1;
        }
        if (frameMs !== null) {
          this.gpuMs = this.gpuMs === null ? frameMs : this.gpuMs * 0.9 + frameMs * 0.1;
          this.lastMs = frameMs;
          this.samples++;
        }
        slot.buffer.unmap();
        slot.free = true;
      },
      () => {
        slot.free = true;
      },
    );
  }
}
