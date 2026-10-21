/**
 * The world as the GPU holds it: the brick table, the sector mask, the record
 * heap, the palette and the max-height pyramid, each a storage buffer.
 *
 * The whole world goes up once, behind the loading screen. After that only
 * edits move, through the upload queue, and each frame's writes are merged
 * into runs so a crater costs a handful of buffer writes rather than one per
 * brick. The heap is allocated with headroom and grows by reallocating and
 * copying; `generation` counts those moves so bind groups can follow.
 */

import type { BrickMap } from '../world/bricks';
import type { HeapMirror } from '../world/encode';
import { paletteData } from '../world/materials';
import { GpuUnavailable } from './device';
import { buildPyramid, type Pyramid, type PyramidLevel } from './pyramid';
import { UploadQueue, type GpuSink } from './uploads';

/** Read lazily: GPUBufferUsage only exists where WebGPU does. */
const usage = () => GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;

export interface GpuWorldStats {
  denseBricks: number;
  heapUsedBytes: number;
  heapCapacityBytes: number;
  tableBytes: number;
  pending: number;
}

export class GpuWorld {
  readonly device: GPUDevice;
  readonly map: BrickMap;
  readonly mirror: HeapMirror;
  readonly table: GPUBuffer;
  readonly sectors: GPUBuffer;
  readonly palette: GPUBuffer;
  readonly pyramid: GPUBuffer;
  readonly pyramidLevels: readonly PyramidLevel[];
  readonly queue: UploadQueue;
  heap: GPUBuffer;
  generation = 0;
  private heapUnits: number;
  private readonly tableWrites = new Map<number, number>();
  private readonly heapWrites: { unit: number; words: Uint32Array }[] = [];
  private readonly sectorWrites = new Map<number, number>();
  private readonly pyramidWrites = new Map<number, number>();

  static create(device: GPUDevice, world: { map: BrickMap; mirror: HeapMirror; pyramid?: Pyramid }, opts: { headroom?: number } = {}): GpuWorld {
    const { dims } = world.map;
    if (dims.x > 4096 || dims.z > 4096 || dims.y > 65536) {
      throw new GpuUnavailable('limits', `a ${dims.x} × ${dims.y} × ${dims.z} world does not fit the G-buffer's voxel coordinates`);
    }
    return new GpuWorld(device, world.map, world.mirror, world.pyramid ?? buildPyramid(world.map), opts.headroom ?? 0.25);
  }

  private constructor(device: GPUDevice, map: BrickMap, mirror: HeapMirror, pyramid: Pyramid, headroom: number) {
    this.device = device;
    this.map = map;
    this.mirror = mirror;
    this.pyramidLevels = pyramid.levels;
    const upload = (data: Uint32Array | Float32Array, size = data.byteLength) => {
      if (size > device.limits.maxStorageBufferBindingSize) {
        throw new GpuUnavailable('limits', `a ${size}-byte buffer is over this GPU's ${device.limits.maxStorageBufferBindingSize}-byte binding limit`);
      }
      const buffer = device.createBuffer({ size: Math.max(16, Math.ceil(size / 16) * 16), usage: usage() });
      device.queue.writeBuffer(buffer, 0, data);
      return buffer;
    };
    this.table = upload(mirror.gpuTable);
    const sectors = map.sectorMask();
    this.sectors = upload(sectors);
    this.palette = upload(paletteData());
    this.pyramid = upload(pyramid.data);
    this.heapUnits = Math.max(1, Math.ceil(mirror.usedUnits * (1 + headroom)));
    this.heap = upload(mirror.heapView(), this.heapUnits * 16);
    this.queue = new UploadQueue(map, mirror, pyramid, { sectors: sectors.slice(), pyramid: pyramid.data.slice() });
  }

  get stats(): GpuWorldStats {
    return {
      denseBricks: this.map.denseCount,
      heapUsedBytes: this.mirror.usedUnits * 16,
      heapCapacityBytes: this.heapUnits * 16,
      tableBytes: this.map.table.length * 4,
      pending: this.queue.pending,
    };
  }

  /** Take the map's dirty bricks into the queue. */
  takeEdits(): void {
    const dirty = this.map.takeDirty();
    if (dirty.length === 0) return;
    this.mirror.update(dirty);
    this.queue.push(this.mirror.takeEdits());
  }

  /** Upload up to `budgetBytes` of edits, nearest `eye` (voxels) first. */
  flush(budgetBytes: number, eye: readonly [number, number, number]): number {
    const sink: GpuSink = {
      table: (i, e) => this.tableWrites.set(i, e),
      heap: (unit, words) => this.heapWrites.push({ unit, words }),
      sector: (i, v) => this.sectorWrites.set(i, v),
      pyramid: (i, v) => this.pyramidWrites.set(i, v),
    };
    const bytes = this.queue.flush(budgetBytes, eye, sink);
    let end = 0;
    for (const w of this.heapWrites) end = Math.max(end, w.unit + w.words.length / 4);
    if (end > this.heapUnits) this.grow(end);
    this.heapWrites.sort((a, b) => a.unit - b.unit);
    let k = 0;
    while (k < this.heapWrites.length) {
      let j = k + 1;
      let next = this.heapWrites[k].unit + this.heapWrites[k].words.length / 4;
      while (j < this.heapWrites.length && this.heapWrites[j].unit === next) next += this.heapWrites[j++].words.length / 4;
      const run = new Uint32Array((next - this.heapWrites[k].unit) * 4);
      let at = 0;
      for (let i = k; i < j; i++) {
        run.set(this.heapWrites[i].words, at);
        at += this.heapWrites[i].words.length;
      }
      this.device.queue.writeBuffer(this.heap, this.heapWrites[k].unit * 16, run);
      k = j;
    }
    this.heapWrites.length = 0;
    this.writeRuns(this.table, this.tableWrites);
    this.writeRuns(this.sectors, this.sectorWrites);
    this.writeRuns(this.pyramid, this.pyramidWrites);
    return bytes;
  }

  private writeRuns(buffer: GPUBuffer, writes: Map<number, number>): void {
    const indices = [...writes.keys()].sort((a, b) => a - b);
    let k = 0;
    while (k < indices.length) {
      let j = k + 1;
      while (j < indices.length && indices[j] === indices[j - 1] + 1) j++;
      const run = Uint32Array.from(indices.slice(k, j), (i) => writes.get(i)!);
      this.device.queue.writeBuffer(buffer, indices[k] * 4, run);
      k = j;
    }
    writes.clear();
  }

  private grow(units: number): void {
    const next = Math.max(units, Math.ceil(this.heapUnits * 1.5));
    if (next * 16 > this.device.limits.maxStorageBufferBindingSize) {
      throw new GpuUnavailable('limits', `the brick heap needs ${next * 16} bytes, over this GPU's binding limit`);
    }
    const heap = this.device.createBuffer({ size: next * 16, usage: usage() });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.heap, 0, heap, 0, this.heapUnits * 16);
    this.device.queue.submit([encoder.finish()]);
    this.heap.destroy();
    this.heap = heap;
    this.heapUnits = next;
    this.generation++;
  }
}
