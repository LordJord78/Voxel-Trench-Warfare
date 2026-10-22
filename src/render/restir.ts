/**
 * ReSTIR DI (restir.wgsl): each lighting pixel's reservoir, the point light it shades by this
 * frame and that light's weight, resampled from eight candidates drawn from its light cell, merged
 * with last frame's reservoir for the same spot, then shared with three neighbours on the same
 * plane. The temporal reservoirs ping-pong between two buffers, each frame merging the last
 * frame's into its own; the shared ones, which the lighting pass shades by, go into a third (a
 * pixel's history is its own, unshared). The lights the last frame had are kept too: a history's
 * light counts toward the chosen light's weight only if it reached the spot then.
 */

import type { LightCells } from './light-cells';
import { MAX_LIGHTS } from './lights';
import { moduleSource } from './shaders';
import restirSrc from './shaders/restir.wgsl';

export interface RestirPipelines {
  candidates: GPUComputePipeline;
  spatial: GPUComputePipeline;
}

/** A reservoir (reservoir.wgsl): light, W, M, target; and as `candidates` leaves it, with its point and surface (restir.wgsl's Drawn). */
const RESERVOIR_BYTES = 16;
const DRAWN_BYTES = 32;

/** The renderer's textures the reservoirs are built over. */
export interface RestirTextures {
  gDepth: GPUTextureView;
  gHit: GPUTextureView;
  /** The lighting pixels' depths and hits, by frame parity: frame k's lighting pass writes [k & 1]. */
  hDepth: readonly [GPUTextureView, GPUTextureView];
  hHit: readonly [GPUTextureView, GPUTextureView];
}

export class Restir {
  /** The lights as the last frame had them. */
  readonly lightsBefore: GPUBuffer;
  private readonly device: GPUDevice;
  private readonly pipelines: RestirPipelines;
  private readonly shared: GPUBindGroup[];
  /** The spatial pass's: the frame's uniform and lights, and its (empty) group 1. */
  private readonly spatialShared: GPUBindGroup[];
  /** The temporal merge's by frame parity (with where each was drawn), then the shared ones. */
  private reservoirs: GPUBuffer[] = [];
  /** Group 2 of each pass, by frame parity. */
  private candidatesGroups: GPUBindGroup[] = [];
  private spatialGroups: GPUBindGroup[] = [];
  private stride = 0;

  static async compile(device: GPUDevice): Promise<RestirPipelines> {
    const module = device.createShaderModule({ label: 'restir', code: moduleSource(restirSrc) });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length) throw new Error(`restir.wgsl: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`);
    const build = (entryPoint: string) => device.createComputePipelineAsync({ label: `restir ${entryPoint}`, layout: 'auto', compute: { module, entryPoint } });
    const [candidates, spatial] = await Promise.all([build('candidates'), build('spatial')]);
    return { candidates, spatial };
  }

  /** Over the frame's uniform, its lights and their cells. */
  static create(device: GPUDevice, pipelines: RestirPipelines, frame: GPUBuffer, lights: GPUBuffer, cells: LightCells): Restir {
    return new Restir(device, pipelines, frame, lights, cells);
  }

  private constructor(device: GPUDevice, pipelines: RestirPipelines, frame: GPUBuffer, lights: GPUBuffer, cells: LightCells) {
    this.device = device;
    this.pipelines = pipelines;
    this.lightsBefore = device.createBuffer({ label: 'lights before', size: MAX_LIGHTS * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const layout = (i: number) => pipelines.candidates.getBindGroupLayout(i);
    this.spatialShared = [
      device.createBindGroup({
        label: 'restir spatial frame',
        layout: pipelines.spatial.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: frame } },
          { binding: 6, resource: { buffer: lights } },
        ],
      }),
      device.createBindGroup({ label: 'restir spatial none', layout: pipelines.spatial.getBindGroupLayout(1), entries: [] }),
    ];
    this.shared = [
      device.createBindGroup({
        label: 'restir frame',
        layout: layout(0),
        entries: [
          { binding: 0, resource: { buffer: frame } },
          { binding: 6, resource: { buffer: lights } },
        ],
      }),
      device.createBindGroup({
        label: 'restir cells',
        layout: layout(1),
        entries: [
          { binding: 0, resource: { buffer: cells.grid } },
          { binding: 1, resource: { buffer: cells.cells } },
        ],
      }),
    ];
  }

  /** The reservoirs' row stride, in reservoirs: the lighting grid's width as allocated. */
  get rowStride(): number {
    return this.stride;
  }

  /** The reservoirs the lighting pass shades by (the shared ones, every frame's). */
  get shaded(): GPUBuffer {
    return this.reservoirs[2];
  }

  /** Fit the reservoirs to a lighting grid allocated at `size`, over the renderer's textures. */
  resize(size: readonly [number, number], textures: RestirTextures): void {
    for (const b of this.reservoirs) b.destroy();
    this.stride = size[0];
    const pixels = size[0] * size[1];
    this.reservoirs = (
      [
        ['temporal 0', DRAWN_BYTES],
        ['temporal 1', DRAWN_BYTES],
        ['shared', RESERVOIR_BYTES],
      ] as const
    ).map(([k, bytes]) => this.device.createBuffer({ label: `reservoirs ${k}`, size: pixels * bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }));
    const group = (pipeline: GPUComputePipeline, label: string, entries: [number, GPUBindingResource][]) =>
      this.device.createBindGroup({ label, layout: pipeline.getBindGroupLayout(2), entries: entries.map(([binding, resource]) => ({ binding, resource })) });
    this.candidatesGroups = [0, 1].map((cur) => {
      const prev = 1 - cur;
      return group(this.pipelines.candidates, `restir candidates ${cur}`, [
        [0, textures.gDepth],
        [1, textures.gHit],
        [2, textures.hDepth[prev]],
        [3, textures.hHit[prev]],
        [4, { buffer: this.lightsBefore }],
        [5, { buffer: this.reservoirs[prev] }],
        [8, { buffer: this.reservoirs[cur] }],
      ]);
    });
    this.spatialGroups = [0, 1].map((cur) =>
      group(this.pipelines.spatial, `restir spatial ${cur}`, [
        [6, { buffer: this.shaded }],
        [7, { buffer: this.reservoirs[cur] }],
      ]),
    );
  }

  /**
   * Frame `parity`'s reservoirs over the lighting grid's rendered part, `lightRes`: the candidates
   * and temporal merge in one compute pass, the spatial in another (each timed by its writes, if given).
   */
  encode(
    encoder: GPUCommandEncoder,
    parity: number,
    lightRes: readonly [number, number],
    timestampWrites: { candidates?: GPUComputePassTimestampWrites; spatial?: GPUComputePassTimestampWrites } = {},
  ): void {
    const run = (label: string, pipeline: GPUComputePipeline, groups: GPUBindGroup[], writes?: GPUComputePassTimestampWrites) => {
      const pass = encoder.beginComputePass({ label, timestampWrites: writes });
      pass.setPipeline(pipeline);
      groups.forEach((g, i) => pass.setBindGroup(i, g));
      pass.dispatchWorkgroups(Math.ceil(lightRes[0] / 8), Math.ceil(lightRes[1] / 8));
      pass.end();
    };
    run('restir', this.pipelines.candidates, [...this.shared, this.candidatesGroups[parity & 1]], timestampWrites.candidates);
    run('spatial', this.pipelines.spatial, [...this.spatialShared, this.spatialGroups[parity & 1]], timestampWrites.spatial);
  }

  /** At the frame's end: keep its lights, which the next frame's histories were drawn under. */
  keep(encoder: GPUCommandEncoder, lights: GPUBuffer): void {
    encoder.copyBufferToBuffer(lights, 0, this.lightsBefore, 0, MAX_LIGHTS * 32);
  }

  destroy(): void {
    for (const b of [...this.reservoirs, this.lightsBefore]) b.destroy();
  }
}
