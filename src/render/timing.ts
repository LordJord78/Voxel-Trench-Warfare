/**
 * Per-pass GPU time from timestamp queries. Every pass writes a timestamp as
 * it begins and ends; the frame resolves them into one of three readback
 * buffers, and the times arrive a frame or two later, smoothed. A frame's GPU
 * time is its first pass's start to its last pass's end. Without timestamp
 * queries nothing is measured here (the frame interval stands in elsewhere).
 */

const RING = 3;

export class GpuTimer {
  readonly enabled: boolean;
  /** Smoothed milliseconds per pass, and for the whole frame. */
  passes: Record<string, number> = {};
  gpuMs: number | null = null;
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
        let first = Infinity;
        let last = -Infinity;
        for (const name of slot.used) {
          const i = this.names.indexOf(name);
          const begin = Number(t[2 * i]);
          const end = Number(t[2 * i + 1]);
          if (!(end > begin)) continue;
          const ms = (end - begin) / 1e6;
          this.passes[name] = this.passes[name] === undefined ? ms : this.passes[name] * 0.9 + ms * 0.1;
          first = Math.min(first, begin);
          last = Math.max(last, end);
        }
        if (last > first) {
          const ms = (last - first) / 1e6;
          this.gpuMs = this.gpuMs === null ? ms : this.gpuMs * 0.9 + ms * 0.1;
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
