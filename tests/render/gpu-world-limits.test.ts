import { expect, it } from 'vitest';
import { GpuUnavailable } from '../../src/render/device';
import { GpuWorld } from '../../src/render/gpu-world';
import { BrickMap } from '../../src/world/bricks';
import { HeapMirror } from '../../src/world/encode';
import { P } from '../../src/world/materials';

it('refuses a world bigger than the GPU can bind, naming the limit, before allocating anything', () => {
  const map = new BrickMap({ x: 64, y: 64, z: 64 });
  map.fillBox(0, 0, 0, 64, 20, 64, P.SOD);
  const mirror = HeapMirror.fromMap(map);
  // The table fits and the heap does not: the world must be refused before the table is uploaded.
  expect(map.table.length * 4).toBeLessThanOrEqual(4096);
  expect(mirror.usedUnits * 16).toBeGreaterThan(4096);
  const limits = {
    maxStorageBufferBindingSize: 4096,
    maxBufferSize: 1 << 30,
    maxStorageBuffersPerShaderStage: 8,
    maxStorageTexturesPerShaderStage: 4,
    maxSampledTexturesPerShaderStage: 16,
  };
  // Only limits: creating a buffer on it would throw a TypeError instead.
  const device = { limits } as unknown as GPUDevice;
  let error: unknown;
  try {
    GpuWorld.create(device, { map, mirror });
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(GpuUnavailable);
  expect((error as GpuUnavailable).reason).toBe('limits');
  expect((error as Error).message).toContain('maxStorageBufferBindingSize');
});
