/**
 * Group 0, the scene: the frame uniform, the world's buffers, the far field,
 * the lights and the blue noise — the same layout for every pass (see
 * shaders/scene.wgsl), so one bind group serves a whole frame and is rebuilt
 * only when the heap moves.
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
    ],
  });
}

export interface SceneResources {
  frame: GPUBuffer;
  world: GpuWorld;
  far: FarFieldGpu;
  lights: GPUBuffer;
  noise: GPUTexture;
}

/** The lights buffer (room for 64) and the blue-noise texture a scene needs, before any light is set. */
export function sceneExtras(device: GPUDevice): { lights: GPUBuffer; noise: GPUTexture } {
  const lights = device.createBuffer({ label: 'lights', size: 64 * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const noise = device.createTexture({ label: 'blue noise', size: [64, 64], format: 'r16uint', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  device.queue.writeTexture({ texture: noise }, blueNoise(64), { bytesPerRow: 128 }, [64, 64]);
  return { lights, noise };
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
    ],
  });
}
