/**
 * Group 0, the scene: the frame uniform, the world's buffers, the far field,
 * the lights, the blue noise and the atmosphere's LUTs — the same layout for
 * every pass (see shaders/scene.wgsl), so one bind group serves a whole frame
 * and is rebuilt only when the heap moves.
 */

import { blueNoise } from './bluenoise';

import type { FarFieldGpu } from './farfield-gpu';
import type { GpuWorld } from './gpu-world';

export function sceneLayout(device: GPUDevice): GPUBindGroupLayout {
  const storage = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } });
  return device.createBindGroupLayout({
    label: 'scene',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      storage(1),
      storage(2),
      storage(3),
      storage(4),
      storage(5),
      storage(6),
      { binding: 7, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 9, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'uint' } },
      { binding: 10, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'uint' } },
      { binding: 11, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      { binding: 12, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 13, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d-array' } },
      { binding: 14, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
      storage(15),
    ],
  });
}

/** The atmosphere's LUTs as shading reads them (see atmosphere.ts), their sampler, and the faces' irradiance. */
export interface SkyLuts {
  transmittance: GPUTextureView;
  scattering: GPUTextureView;
  /** Two layers, as a 2D array: lit by the sun, and by the moon. */
  skyView: GPUTextureView;
  sampler: GPUSampler;
  /** Twelve vec4s: six faces from the sun, six from the moon. */
  irradiance: GPUBuffer;
}

export interface SceneResources {
  frame: GPUBuffer;
  world: GpuWorld;
  far: FarFieldGpu;
  lights: GPUBuffer;
  noise: GPUTexture;
  sky: SkyLuts;
}

/**
 * The lights buffer (room for 64), the blue-noise texture and empty (black) sky LUTs a scene needs
 * before any light or atmosphere is set.
 */
export function sceneExtras(device: GPUDevice): { lights: GPUBuffer; noise: GPUTexture; sky: SkyLuts } {
  const lights = device.createBuffer({ label: 'lights', size: 64 * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const noise = device.createTexture({ label: 'blue noise', size: [64, 64], format: 'r16uint', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  device.queue.writeTexture({ texture: noise }, blueNoise(64), { bytesPerRow: 128 }, [64, 64]);
  const empty = (layers = 1) =>
    device.createTexture({ label: 'empty sky', size: [1, 1, layers], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING }).createView(layers > 1 ? { dimension: '2d-array' } : {});
  const sky = {
    transmittance: empty(),
    scattering: empty(),
    skyView: empty(2),
    sampler: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
    irradiance: device.createBuffer({ label: 'empty sky irradiance', size: 12 * 16, usage: GPUBufferUsage.STORAGE }),
  };
  return { lights, noise, sky };
}

export function sceneGroup(device: GPUDevice, layout: GPUBindGroupLayout, r: SceneResources): GPUBindGroup {
  const { frame, world, far } = r;
  return device.createBindGroup({
    label: 'scene',
    layout,
    entries: [
      { binding: 0, resource: { buffer: frame } },
      { binding: 1, resource: { buffer: world.table } },
      { binding: 2, resource: { buffer: world.sectors } },
      { binding: 3, resource: { buffer: world.heap } },
      { binding: 4, resource: { buffer: world.palette } },
      { binding: 5, resource: { buffer: world.pyramid } },
      { binding: 6, resource: { buffer: r.lights } },
      { binding: 7, resource: far.heights.createView() },
      { binding: 8, resource: far.mips.createView() },
      { binding: 9, resource: far.materials.createView() },
      { binding: 10, resource: r.noise.createView() },
      { binding: 11, resource: r.sky.transmittance },
      { binding: 12, resource: r.sky.scattering },
      { binding: 13, resource: r.sky.skyView },
      { binding: 14, resource: r.sky.sampler },
      { binding: 15, resource: { buffer: r.sky.irradiance } },
    ],
  });
}
