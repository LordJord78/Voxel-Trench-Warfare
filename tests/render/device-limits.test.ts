import { describe, expect, it } from 'vitest';
import { checkLimits } from '../../src/render/device';

const roomy = {
  maxStorageBufferBindingSize: 4 * 2 ** 30,
  maxBufferSize: 4 * 2 ** 30,
  maxStorageBuffersPerShaderStage: 10,
  maxStorageTexturesPerShaderStage: 8,
  maxSampledTexturesPerShaderStage: 48,
};

describe('the GPU limits the renderer needs', () => {
  it('are met by an adapter with room', () => {
    expect(checkLimits(roomy, { storageBinding: 80e6 })).toEqual([]);
  });
  it('name a heap too big to bind', () => {
    const small = { ...roomy, maxStorageBufferBindingSize: 128 * 2 ** 20, maxBufferSize: 256 * 2 ** 20 };
    const short = checkLimits(small, { storageBinding: 200e6 });
    expect(short.join('\n')).toMatch(/maxStorageBufferBindingSize/);
  });
  it('name too few storage textures or buffers per stage', () => {
    const short = checkLimits({ ...roomy, maxStorageTexturesPerShaderStage: 2, maxStorageBuffersPerShaderStage: 4 }, { storageBinding: 1e6 });
    expect(short.join('\n')).toMatch(/maxStorageTexturesPerShaderStage/);
    expect(short.join('\n')).toMatch(/maxStorageBuffersPerShaderStage/);
  });
});
