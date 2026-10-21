import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { BrickMap, UNIFORM } from '../../src/world/bricks';
import { carveSphere } from '../../src/world/destruction';
import { HeapMirror, RECORD_UNITS, decodeBrick } from '../../src/world/encode';
import { P } from '../../src/world/materials';
import { buildPyramid, type Pyramid } from '../../src/render/pyramid';
import { UploadQueue, type GpuSink } from '../../src/render/uploads';
import { syntheticWorld } from '../support/synthetic';

/** What the GPU would hold, written only through the sink. */
class SimulatedGpu {
  table: Uint32Array;
  heap: Uint32Array;
  sectors: Uint32Array;
  pyramid: Uint32Array;
  /** The record words each dense table entry pointed at when it was written. */
  private readonly snapshot = new Map<number, Uint32Array>();
  readonly sink: GpuSink;

  constructor(map: BrickMap, mirror: HeapMirror, pyramid: Pyramid) {
    this.table = mirror.gpuTable.slice();
    this.heap = mirror.heapView().slice();
    this.sectors = map.sectorMask();
    this.pyramid = pyramid.data.slice();
    for (let bi = 0; bi < this.table.length; bi++) this.remember(bi);
    this.sink = {
      table: (i, entry) => {
        this.table[i] = entry;
        this.remember(i);
      },
      heap: (unit, words) => {
        if ((unit * 4 + words.length) > this.heap.length) {
          const grown = new Uint32Array(Math.max(this.heap.length * 2, unit * 4 + words.length));
          grown.set(this.heap);
          this.heap = grown;
        }
        this.heap.set(words, unit * 4);
      },
      sector: (i, v) => (this.sectors[i] = v),
      pyramid: (i, v) => (this.pyramid[i] = v),
    };
  }

  private record(entry: number): Uint32Array {
    const unit = entry & 0x0fffffff;
    return this.heap.slice(unit * 4, (unit + RECORD_UNITS[entry >>> 28]) * 4);
  }

  private remember(bi: number): void {
    const e = this.table[bi];
    if (e === 0 || e & UNIFORM) this.snapshot.delete(bi);
    else this.snapshot.set(bi, this.record(e));
  }

  /** Bricks whose record was overwritten while the table still pointed at it. */
  dangling(): number {
    let n = 0;
    for (const [bi, words] of this.snapshot) {
      const now = this.record(this.table[bi]);
      if (now.length !== words.length || now.some((w, i) => w !== words[i])) n++;
    }
    return n;
  }

  /** 1 + the highest non-air voxel's y in a brick column, as the GPU's table says. */
  columnTop(map: BrickMap, bx: number, bz: number): number {
    const raw = new Uint8Array(512);
    for (let by = map.bricks.y - 1; by >= 0; by--) {
      const e = this.table[map.brickIndex(bx, by, bz)];
      if (e === 0) continue;
      if (e & UNIFORM) return by * 8 + 8;
      decodeBrick(this.record(e), raw);
      for (let ly = 7; ly >= 0; ly--) {
        for (let i = 0; i < 64; i++) if (raw[(i & 7) + ly * 8 + (i >> 3) * 64] !== 0) return by * 8 + ly + 1;
      }
    }
    return 0;
  }
}

function sectorOf(map: BrickMap, bi: number): number {
  const bx = bi % map.bricks.x;
  const rest = (bi - bx) / map.bricks.x;
  const by = rest % map.bricks.y;
  const bz = (rest - by) / map.bricks.y;
  return ((bz >> 2) * map.sectors.y + (by >> 2)) * map.sectors.x + (bx >> 2);
}

function setup() {
  const map = syntheticWorld(6);
  const mirror = HeapMirror.fromMap(map);
  const pyramid = buildPyramid(map);
  const gpu = new SimulatedGpu(map, mirror, pyramid);
  const queue = new UploadQueue(map, mirror, pyramid, { sectors: gpu.sectors.slice(), pyramid: gpu.pyramid.slice() });
  return { map, mirror, pyramid, gpu, queue };
}

describe('the upload queue', () => {
  it('keeps the GPU consistent through an edit storm and drains to the exact world', () => {
    const { map, mirror, gpu, queue } = setup();
    const rng = Rng.root(11);
    const materials = [P.SANDBAG, P.TIMBER, P.BRICK, P.SPOIL, P.WIRE];
    const check = () => {
      expect(gpu.dangling()).toBe(0);
      for (let bi = 0; bi < gpu.table.length; bi++) if (gpu.table[bi] !== 0) expect(gpu.sectors[sectorOf(map, bi)]).toBe(1);
      for (let bz = 0; bz < map.bricks.z; bz++) {
        for (let bx = 0; bx < map.bricks.x; bx++) expect(gpu.pyramid[bz * map.bricks.x + bx]).toBeGreaterThanOrEqual(gpu.columnTop(map, bx, bz));
      }
    };
    for (let k = 0; k < 200; k++) {
      if (rng.chance(0.6)) {
        carveSphere(map, rng.uniform(8, 248), rng.uniform(36, 70), rng.uniform(8, 248), rng.uniform(3, 12), rng.derive(`carve.${k}`));
      } else {
        const x = rng.randint(0, 240);
        const y = rng.randint(40, 110);
        const z = rng.randint(0, 240);
        map.fillBox(x, y, z, x + rng.randint(2, 10), y + rng.randint(2, 10), z + rng.randint(2, 10), rng.choice(materials));
      }
      mirror.update(map.takeDirty());
      queue.push(mirror.takeEdits());
      if (k % 3 === 2) {
        queue.flush(2048, [rng.uniform(0, 256), 60, rng.uniform(0, 256)], gpu.sink);
        check();
      }
    }
    let guard = 0;
    while (queue.pending > 0 && guard++ < 100_000) queue.flush(2048, [128, 60, 128], gpu.sink);
    expect(queue.pending).toBe(0);
    check();
    expect(Array.from(gpu.table)).toEqual(Array.from(mirror.gpuTable));
    expect(Array.from(gpu.pyramid)).toEqual(Array.from(buildPyramid(map).data));
    const exact = map.sectorMask();
    for (let i = 0; i < exact.length; i++) if (exact[i]) expect(gpu.sectors[i]).toBe(1);
    const raw = new Uint8Array(512);
    let wrong = 0;
    for (let bi = 0; bi < map.table.length; bi++) {
      const e = gpu.table[bi];
      if (e === 0 || e & UNIFORM) continue;
      const unit = e & 0x0fffffff;
      decodeBrick(gpu.heap.subarray(unit * 4, (unit + RECORD_UNITS[e >>> 28]) * 4), raw);
      const want = map.denseView(bi)!;
      if (raw.some((v, i) => v !== want[i])) wrong++;
    }
    expect(wrong).toBe(0);
  });

  it('uploads the nearest edits first', () => {
    const { map, mirror, gpu, queue } = setup();
    map.set(10, 100, 10, P.BRICK);
    map.set(250, 100, 250, P.BRICK);
    mirror.update(map.takeDirty());
    queue.push(mirror.takeEdits());
    const near = map.brickIndex(31, 12, 31);
    const far = map.brickIndex(1, 12, 1);
    queue.flush(1, [250, 100, 250], gpu.sink);
    expect(gpu.table[near]).toBe(mirror.gpuTable[near]);
    expect(gpu.table[far]).toBe(0);
    expect(queue.pending).toBe(1);
  });

  it('moves one edit per flush even when the budget is smaller than an edit', () => {
    const { map, mirror, gpu, queue } = setup();
    for (let k = 0; k < 4; k++) map.set(20 + 16 * k, 100, 20, P.BRICK);
    mirror.update(map.takeDirty());
    queue.push(mirror.takeEdits());
    expect(queue.pending).toBe(4);
    for (let k = 3; k >= 0; k--) {
      queue.flush(1, [0, 0, 0], gpu.sink);
      expect(queue.pending).toBe(k);
    }
  });
});
