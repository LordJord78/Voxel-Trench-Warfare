/**
 * The froxels (froxels.wgsl): the haze over the view in 160 × 90 × 64 froxels (80 × 45 × 64 on low) out to 120 m
 * (haze.wgsl's grid), each glowing with what reaches it: the key light as far as its height map
 * lets it (key-shadow.ts), the sky's and the front's light, and its light cell's point lights
 * (light-cells.ts). Each frame, `inject` samples how much of the key light reaches each froxel and
 * the point lights' glow there, blended into last frame's for the same place, and `integrate`
 * lights the froxels by this frame's key and sky and adds them up, front to back, into the haze
 * that shading reads (hazeAt). The samples ping-pong between two volumes by frame parity.
 */

import type { KeyShadow, KeyShadowLayouts } from './key-shadow';
import type { LightCells } from './light-cells';
import { moduleSource } from './shaders';
import froxelsSrc from './shaders/froxels.wgsl';

/** The slices of each froxel column, out from the eye (haze.wgsl's FROXEL_SLICES); the columns are the preset's (quality.ts). */
export const FROXEL_SLICES = 64;

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
  /** The haze from the eye to each slice's far side: the light it scatters toward the eye (rgb), and what shows through it (a). A new texture on resize. */
  haze!: GPUTexture;
  /** Group 3 for a pass that reads the haze (a new one on resize); and an empty group, for its groups between. */
  group!: GPUBindGroup;
  readonly none: GPUBindGroup;
  private readonly device: GPUDevice;
  private readonly pipelines: FroxelPipelines;
  private readonly sampler: GPUSampler;
  /** Each froxel's samples, blended over frames (the point lights' glow, and how much of the key reaches it): frame k writes [k & 1] from the other. */
  private glow: GPUTexture[] = [];
  private readonly cells: GPUBindGroup;
  private readonly keyShadow: KeyShadow;
  private injectGroups: GPUBindGroup[] = [];
  private integrateGroups: GPUBindGroup[] = [];
  private columns: [number, number] = [0, 0];

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

  /** `columns` across and down the view (quality.ts's FROXEL_COLUMNS), lit by the frame's point lights through `cells` and the key light through `keyShadow`'s map. */
  static create(device: GPUDevice, pipelines: FroxelPipelines, cells: LightCells, keyShadow: KeyShadow, columns: readonly [number, number]): Froxels {
    return new Froxels(device, pipelines, cells, keyShadow, columns);
  }

  private constructor(device: GPUDevice, pipelines: FroxelPipelines, cells: LightCells, keyShadow: KeyShadow, columns: readonly [number, number]) {
    this.device = device;
    this.pipelines = pipelines;
    this.keyShadow = keyShadow;
    this.sampler = device.createSampler({ label: 'haze', magFilter: 'linear', minFilter: 'linear' });
    const { layouts } = pipelines;
    this.cells = device.createBindGroup({
      label: 'froxel cells',
      layout: layouts.cells,
      entries: [
        { binding: 0, resource: { buffer: cells.grid } },
        { binding: 1, resource: { buffer: cells.cells } },
      ],
    });
    this.none = device.createBindGroup({ label: 'froxels none', layout: layouts.none, entries: [] });
    this.resize(columns);
  }

  /**
   * The grid at `columns` across and down the view: new volumes and groups (the haze's `group`
   * included, which its readers take again); the samples' history starts afresh with the frame's.
   */
  resize(columns: readonly [number, number]): void {
    if (columns[0] === this.columns[0] && columns[1] === this.columns[1]) return;
    this.destroy();
    this.columns = [columns[0], columns[1]];
    const device = this.device;
    const volume = (label: string) =>
      device.createTexture({
        label,
        size: [columns[0], columns[1], FROXEL_SLICES],
        dimension: '3d',
        format: 'rgba16float',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
    this.haze = volume('haze');
    this.glow = [volume('froxel glow 0'), volume('froxel glow 1')];
    const { layouts } = this.pipelines;
    this.group = device.createBindGroup({
      label: 'haze',
      layout: layouts.haze,
      entries: [
        { binding: 0, resource: this.haze.createView() },
        { binding: 1, resource: this.sampler },
      ],
    });
    this.injectGroups = [0, 1].map((k) =>
      device.createBindGroup({
        label: `froxel inject ${k}`,
        layout: layouts.inject,
        entries: [
          { binding: 1, resource: this.sampler },
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
    pass.dispatchWorkgroups(Math.ceil(this.columns[0] / 8), Math.ceil(this.columns[1] / 8), FROXEL_SLICES);
    pass.setPipeline(this.pipelines.integrate);
    pass.setBindGroup(1, this.none);
    pass.setBindGroup(2, this.none);
    pass.setBindGroup(3, this.integrateGroups[parity]);
    pass.dispatchWorkgroups(Math.ceil(this.columns[0] / 8), Math.ceil(this.columns[1] / 8));
    pass.end();
  }

  destroy(): void {
    this.haze?.destroy();
    for (const t of this.glow) t.destroy();
  }
}
