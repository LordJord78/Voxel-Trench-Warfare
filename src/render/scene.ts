/**
 * Group 0, the scene: the frame uniform and the world's buffers, the same
 * layout for every pass (see shaders/scene.wgsl), so one bind group serves a
 * whole frame and is rebuilt only when the heap moves.
 */

import type { GpuWorld } from './gpu-world';

export function sceneLayout(device: GPUDevice): GPUBindGroupLayout {
  const storage = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } });
  return device.createBindGroupLayout({
    label: 'scene',
    entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }, storage(1), storage(2), storage(3), storage(4), storage(5)],
  });
}

export function sceneGroup(device: GPUDevice, layout: GPUBindGroupLayout, frame: GPUBuffer, world: GpuWorld): GPUBindGroup {
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
    ],
  });
}
