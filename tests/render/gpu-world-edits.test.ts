import { beforeAll, describe, expect, it } from 'vitest';
import { GpuWorld } from '../../src/render/gpu-world';
import { BrickMap, UNIFORM } from '../../src/world/bricks';
import { decodeBrick, HeapMirror, RECORD_UNITS } from '../../src/world/encode';
import { P } from '../../src/world/materials';

interface MemoryBuffer {
  size: number;
  bytes: Uint8Array;
  destroy(): void;
}

/** A device that keeps every buffer's bytes in memory: all GpuWorld asks of one, with no GPU. */
function memoryDevice(): GPUDevice {
  const device = {
    limits: { maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30, maxStorageBuffersPerShaderStage: 8, maxStorageTexturesPerShaderStage: 4, maxSampledTexturesPerShaderStage: 16 },
    createBuffer: ({ size }: { size: number }): MemoryBuffer => ({ size, bytes: new Uint8Array(size), destroy() {} }),
    queue: {
      writeBuffer(buffer: MemoryBuffer, offset: number, data: ArrayBufferView) {
        buffer.bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset);
      },
    },
  };
  return device as unknown as GPUDevice;
}

const held = (b: GPUBuffer) => new Uint32Array((b as unknown as MemoryBuffer).bytes.buffer);

/** 1 + the highest non-air voxel's y in a brick column, as the device's table and heap hold it. */
function gpuColumnTop(world: GpuWorld, map: BrickMap, bx: number, bz: number): number {
  const table = held(world.table);
  const heap = held(world.heap);
  const raw = new Uint8Array(512);
  for (let by = map.bricks.y - 1; by >= 0; by--) {
    const e = table[map.brickIndex(bx, by, bz)];
    if (e === 0) continue;
    if (e & UNIFORM) return by * 8 + 8;
    const unit = e & 0x0fffffff;
    decodeBrick(heap.slice(unit * 4, (unit + RECORD_UNITS[e >>> 28]) * 4), raw);
    for (let ly = 7; ly >= 0; ly--) {
      for (let i = 0; i < 64; i++) if (raw[(i & 7) + ly * 8 + (i >> 3) * 64] !== 0) return by * 8 + ly + 1;
    }
  }
  return 0;
}

/** The pyramid's value over a brick column, as the device holds it. */
function gpuPyramid(world: GpuWorld, bx: number, bz: number): number {
  const l = world.pyramidLevels[0];
  return held(world.pyramid)[l.offset + bz * l.w + bx];
}

/** Ground to y 20 on the device, nothing pending. */
function setup() {
  const map = new BrickMap({ x: 64, y: 64, z: 64 });
  map.fillBox(0, 0, 0, 64, 20, 64, P.SOD);
  map.takeDirty();
  const world = GpuWorld.create(memoryDevice(), { map, mirror: HeapMirror.fromMap(map) });
  return { map, world };
}

beforeAll(() => {
  const g = globalThis as { GPUBufferUsage?: unknown };
  g.GPUBufferUsage ??= { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128 };
});

describe('a world on the GPU', () => {
  it('uploads edits a flush finds in the map, whether or not anyone took them first', () => {
    const { map, world } = setup();
    map.fillBox(8, 20, 8, 9, 40, 9, P.TIMBER);
    for (let i = 0; i < 10; i++) world.flush(1 << 20, [0, 0, 0]);
    expect(gpuColumnTop(world, map, 1, 1)).toBe(40);
    expect(gpuPyramid(world, 1, 1)).toBe(40);
  });

  it('never lets the pyramid fall under what the table holds, flush by flush', () => {
    const { map, world } = setup();
    map.fillBox(8, 20, 8, 9, 40, 9, P.TIMBER);
    world.takeEdits();
    world.flush(1, [0, 0, 0]);
    // Carved before the rest of the post went up, and never handed to takeEdits.
    map.fillBox(8, 20, 8, 9, 40, 9, P.AIR);
    for (let i = 0; i < 20; i++) {
      world.flush(1, [0, 0, 0]);
      expect(gpuPyramid(world, 1, 1), `flush ${i}`).toBeGreaterThanOrEqual(gpuColumnTop(world, map, 1, 1));
    }
    expect(world.stats.pending).toBe(0);
    expect(gpuColumnTop(world, map, 1, 1)).toBe(20);
    expect(gpuPyramid(world, 1, 1)).toBe(20);
  });
});
