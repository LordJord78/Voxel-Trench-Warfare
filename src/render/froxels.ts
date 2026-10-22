/**
 * The froxels (froxels.wgsl): the haze over the view in 160 × 90 × 64 froxels out to 120 m
 * (haze.wgsl's grid), each glowing with what reaches it: the key light as far as its height map
 * lets it (key-shadow.ts), the sky's and the front's light, and its light cell's point lights
 * (light-cells.ts). Each frame, `inject` finds each froxel's glow and blends it into last frame's
 * for the same place, and `integrate` adds the froxels up, front to back, into the haze that
 * shading reads (hazeAt). The glow ping-pongs between two volumes by frame parity.
 */

import type { KeyShadow, KeyShadowLayouts } from './key-shadow';
import type { LightCells } from './light-cells';
import { moduleSource } from './shaders';
import froxelsSrc from './shaders/froxels.wgsl';

/** The froxels across the view, down it, and out from the eye (haze.wgsl's FROXELS). */
export const FROXELS: readonly [number, number, number] = [160, 90, 64];

export interface FroxelLayouts {
  /** Group 3 of a pass that reads the haze (hazeAt): the haze, and its sampler. */
  haze: GPUBindGroupLayout;
  /** The light cells, as inject reads them (group 1). */
  cells: GPUBindGroupLayout;
  /** Group 3 of inject and of integrate. */
  inject: GPUBindGroupLayout;
  integrate: GPUBindGroupLayout;
  none: GPUBindGroupLayout;
}

export function froxelLayouts(device: GPUDevice): FroxelLayouts {
  const COMPUTE = GPUShaderStage.COMPUTE;
  const volume = (binding: number, sampleType: GPUTextureSampleType): GPUBindGroupLayoutEntry => ({ binding, visibility: COMPUTE, texture: { sampleType, viewDimension: '3d' } });
  const written = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '3d' } });
  const sampler: GPUBindGroupLayoutEntry = { binding: 1, visibility: COMPUTE, sampler: { type: 'filtering' } };
  return {
    haze: device.createBindGroupLayout({ label: 'haze', entries: [volume(0, 'float'), sampler] }),
    cells: device.createBindGroupLayout({
      label: 'froxel cells',
      entries: [
        { binding: 0, visibility: COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: COMPUTE, buffer: { type: 'storage' } },
      ],
    }),
    inject: device.createBindGroupLayout({ label: 'froxel inject', entries: [sampler, volume(2, 'float'), written(3)] }),
    integrate: device.createBindGroupLayout({ label: 'froxel integrate', entries: [volume(4, 'unfilterable-float'), written(5)] }),
    none: device.createBindGroupLayout({ label: 'froxels none', entries: [] }),
  };
}

export interface FroxelPipelines {
  layouts: FroxelLayouts;
  inject: GPUComputePipeline;
  integrate: GPUComputePipeline;
}

export class Froxels {
  /** The haze from the eye to each slice's far side: the light it scatters toward the eye (rgb), and what shows through it (a). */
  readonly haze: GPUTexture;
  /** Group 3 for a pass that reads the haze. */
  readonly group: GPUBindGroup;
  private readonly pipelines: FroxelPipelines;
  /** Each froxel's glow, blended over frames: frame k writes [k & 1] from the other. */
  private readonly glow: GPUTexture[];
  private readonly cells: GPUBindGroup;
  private readonly keyShadow: KeyShadow;
  private readonly none: GPUBindGroup;
  private readonly injectGroups: GPUBindGroup[];
  private readonly integrateGroups: GPUBindGroup[];

  /** Over the scene's group 0 (`scene`, scene.ts), asking keyLit through the height map's group (`key`). */
  static async compile(device: GPUDevice, scene: GPUBindGroupLayout, key: KeyShadowLayouts, layouts: FroxelLayouts = froxelLayouts(device)): Promise<FroxelPipelines> {
    const module = device.createShaderModule({ label: 'froxels', code: moduleSource(froxelsSrc) });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length) throw new Error(`froxels.wgsl: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`);
    const build = (entryPoint: string, groups: GPUBindGroupLayout[]) =>
      device.createComputePipelineAsync({ label: `froxels ${entryPoint}`, layout: device.createPipelineLayout({ bindGroupLayouts: groups }), compute: { module, entryPoint } });
    const [inject, integrate] = await Promise.all([
      build('inject', [scene, layouts.cells, key.read, layouts.inject]),
      build('integrate', [scene, layouts.none, layouts.none, layouts.integrate]),
    ]);
    return { layouts, inject, integrate };
  }

  /** Lit by the frame's point lights through `cells`, and the key light through `keyShadow`'s map. */
  static create(device: GPUDevice, pipelines: FroxelPipelines, cells: LightCells, keyShadow: KeyShadow): Froxels {
    return new Froxels(device, pipelines, cells, keyShadow);
  }

  private constructor(device: GPUDevice, pipelines: FroxelPipelines, cells: LightCells, keyShadow: KeyShadow) {
    this.pipelines = pipelines;
    this.keyShadow = keyShadow;
    const volume = (label: string) =>
      device.createTexture({
        label,
        size: [...FROXELS],
        dimension: '3d',
        format: 'rgba16float',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
    this.haze = volume('haze');
    this.glow = [volume('froxel glow 0'), volume('froxel glow 1')];
    const sampler = device.createSampler({ label: 'haze', magFilter: 'linear', minFilter: 'linear' });
    const { layouts } = pipelines;
    this.group = device.createBindGroup({
      label: 'haze',
      layout: layouts.haze,
      entries: [
        { binding: 0, resource: this.haze.createView() },
        { binding: 1, resource: sampler },
      ],
    });
    this.cells = device.createBindGroup({
      label: 'froxel cells',
      layout: layouts.cells,
      entries: [
        { binding: 0, resource: { buffer: cells.grid } },
        { binding: 1, resource: { buffer: cells.cells } },
      ],
    });
    this.none = device.createBindGroup({ label: 'froxels none', layout: layouts.none, entries: [] });
    this.injectGroups = [0, 1].map((k) =>
      device.createBindGroup({
        label: `froxel inject ${k}`,
        layout: layouts.inject,
        entries: [
          { binding: 1, resource: sampler },
          { binding: 2, resource: this.glow[1 - k].createView() },
          { binding: 3, resource: this.glow[k].createView() },
        ],
      }),
    );
    this.integrateGroups = [0, 1].map((k) =>
      device.createBindGroup({
        label: `froxel integrate ${k}`,
        layout: layouts.integrate,
        entries: [
          { binding: 4, resource: this.glow[k].createView() },
          { binding: 5, resource: this.haze.createView() },
        ],
      }),
    );
  }

  /** This frame's glow (blended into last frame's, by frame `parity`) and the haze from it, in one pass. */
  encode(encoder: GPUCommandEncoder, scene: GPUBindGroup, parity: number, timestampWrites?: GPUComputePassTimestampWrites): void {
    const pass = encoder.beginComputePass({ label: 'froxels', timestampWrites });
    pass.setPipeline(this.pipelines.inject);
    pass.setBindGroup(0, scene);
    pass.setBindGroup(1, this.cells);
    pass.setBindGroup(2, this.keyShadow.group);
    pass.setBindGroup(3, this.injectGroups[parity]);
    // Workgroups of 8 × 8 froxels, a slice deep.
    pass.dispatchWorkgroups(Math.ceil(FROXELS[0] / 8), Math.ceil(FROXELS[1] / 8), FROXELS[2]);
    pass.setPipeline(this.pipelines.integrate);
    pass.setBindGroup(1, this.none);
    pass.setBindGroup(2, this.none);
    pass.setBindGroup(3, this.integrateGroups[parity]);
    pass.dispatchWorkgroups(Math.ceil(FROXELS[0] / 8), Math.ceil(FROXELS[1] / 8));
    pass.end();
  }

  destroy(): void {
    this.haze.destroy();
    for (const t of this.glow) t.destroy();
  }
}
