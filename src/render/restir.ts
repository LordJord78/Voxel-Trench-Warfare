/**
 * ReSTIR DI (restir.wgsl): each lighting pixel's reservoir, the point light it shades by this
 * frame and that light's weight, resampled from eight candidates drawn from its light cell and
 * merged with last frame's reservoir for the same spot. The reservoirs ping-pong between two
 * buffers: a frame merges the last frame's and writes its own, which the lighting pass reads.
 * The lights the last frame had are kept too: a history's light counts toward the chosen light's
 * weight only if it reached the spot then.
 */

import type { LightCells } from './light-cells';
import { MAX_LIGHTS } from './lights';
import { moduleSource } from './shaders';
import restirSrc from './shaders/restir.wgsl';

export interface RestirPipelines {
  candidates: GPUComputePipeline;
}

/** A reservoir (reservoir.wgsl): light, W, M, target. */
const RESERVOIR_BYTES = 16;

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
  private reservoirs: GPUBuffer[] = [];
  /** Group 2 by frame parity. */
  private own: GPUBindGroup[] = [];
  private stride = 0;

  static async compile(device: GPUDevice): Promise<RestirPipelines> {
    const module = device.createShaderModule({ label: 'restir', code: moduleSource(restirSrc) });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length) throw new Error(`restir.wgsl: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`);
    const candidates = await device.createComputePipelineAsync({ label: 'restir candidates', layout: 'auto', compute: { module, entryPoint: 'candidates' } });
    return { candidates };
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

  /** The reservoirs frame `parity` writes, which its lighting pass reads. */
  written(parity: number): GPUBuffer {
    return this.reservoirs[parity & 1];
  }

  /** Fit the reservoirs to a lighting grid allocated at `size`, over the renderer's textures. */
  resize(size: readonly [number, number], textures: RestirTextures): void {
    for (const b of this.reservoirs) b.destroy();
    this.stride = size[0];
    this.reservoirs = [0, 1].map((k) =>
      this.device.createBuffer({ label: `reservoirs ${k}`, size: size[0] * size[1] * RESERVOIR_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
    );
    const layout = this.pipelines.candidates.getBindGroupLayout(2);
    this.own = [0, 1].map((cur) => {
      const prev = 1 - cur;
      const entries: GPUBindingResource[] = [
        textures.gDepth,
        textures.gHit,
        textures.hDepth[prev],
        textures.hHit[prev],
        { buffer: this.lightsBefore },
        { buffer: this.reservoirs[prev] },
        { buffer: this.reservoirs[cur] },
      ];
      return this.device.createBindGroup({ label: `restir ${cur}`, layout, entries: entries.map((resource, binding) => ({ binding, resource })) });
    });
  }

  /** Frame `parity`'s reservoirs over the lighting grid's rendered part, `lightRes`, in one compute pass. */
  encode(encoder: GPUCommandEncoder, parity: number, lightRes: readonly [number, number], timestampWrites?: GPUComputePassTimestampWrites): void {
    const pass = encoder.beginComputePass({ label: 'restir', timestampWrites });
    pass.setPipeline(this.pipelines.candidates);
    pass.setBindGroup(0, this.shared[0]);
    pass.setBindGroup(1, this.shared[1]);
    pass.setBindGroup(2, this.own[parity & 1]);
    pass.dispatchWorkgroups(Math.ceil(lightRes[0] / 8), Math.ceil(lightRes[1] / 8));
    pass.end();
  }

  /** At the frame's end: keep its lights, which the next frame's histories were drawn under. */
  keep(encoder: GPUCommandEncoder, lights: GPUBuffer): void {
    encoder.copyBufferToBuffer(lights, 0, this.lightsBefore, 0, MAX_LIGHTS * 32);
  }

  destroy(): void {
    for (const b of [...this.reservoirs, this.lightsBefore]) b.destroy();
  }
}
