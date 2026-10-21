/**
 * The far field on the GPU: its prepared heights (see farfield-mips.ts), their
 * max mips as one texture's mip levels, and its materials. `info` is what the
 * frame uniform carries: origin x and z, cell size and cell count, in voxels.
 * An empty far field (cell count 0) makes every far march miss at once.
 */

import type { FarField } from '../world/generation/farfield';
import { farFieldMips, prepareFarHeights } from './farfield-mips';

export class FarFieldGpu {
  readonly heights: GPUTexture;
  readonly mips: GPUTexture;
  readonly materials: GPUTexture;
  readonly info: [number, number, number, number];

  private constructor(heights: GPUTexture, mips: GPUTexture, materials: GPUTexture, info: [number, number, number, number]) {
    this.heights = heights;
    this.mips = mips;
    this.materials = materials;
    this.info = info;
  }

  static create(device: GPUDevice, ff: FarField): FarFieldGpu {
    const n = ff.size;
    if (n & (n - 1)) throw new RangeError(`a far field of ${n} cells is not a power of two`);
    const prepared = prepareFarHeights(ff.height, n);
    // No ground goes up as -1e30: shader compilers may assume there are no infinities.
    const finite = (a: Float32Array) => a.map((h) => (h === -Infinity ? -1e30 : h));
    const levels = farFieldMips(prepared, n).map(finite);
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    const heights = device.createTexture({ label: 'far heights', size: [n, n], format: 'r32float', usage });
    device.queue.writeTexture({ texture: heights }, finite(prepared), { bytesPerRow: n * 4 }, [n, n]);
    const mips = device.createTexture({ label: 'far mips', size: [n, n], format: 'r32float', usage, mipLevelCount: levels.length });
    levels.forEach((level, k) => {
      const m = n >> k;
      device.queue.writeTexture({ texture: mips, mipLevel: k }, level, { bytesPerRow: m * 4 }, [m, m]);
    });
    const materials = device.createTexture({ label: 'far materials', size: [n, n], format: 'r8uint', usage });
    device.queue.writeTexture({ texture: materials }, ff.material, { bytesPerRow: n }, [n, n]);
    return new FarFieldGpu(heights, mips, materials, [ff.originX, ff.originZ, ff.cell, n]);
  }

  static empty(device: GPUDevice): FarFieldGpu {
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    const heights = device.createTexture({ size: [1, 1], format: 'r32float', usage });
    const mips = device.createTexture({ size: [1, 1], format: 'r32float', usage });
    const materials = device.createTexture({ size: [1, 1], format: 'r8uint', usage });
    return new FarFieldGpu(heights, mips, materials, [0, 0, 1, 0]);
  }

  destroy(): void {
    this.heights.destroy();
    this.mips.destroy();
    this.materials.destroy();
  }
}
