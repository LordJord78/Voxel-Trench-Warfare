/**
 * The light cells: a grid of 8 m squares over the map's x and z, built on the GPU every frame from
 * the frame's lights (light-cells.wgsl, a workgroup a block of 2 × 2 cells). Each lists the lights whose sphere reaches its square, at most 32,
 * nearest its middle first; a point off the map is in no cell. ReSTIR draws
 * a lighting pixel's candidate lights from its cell's list, so a light costs only the pixels it can
 * reach.
 */

import { moduleSource } from './shaders';
import cellsSrc from './shaders/light-cells.wgsl';

export const CELL_METRES = 8;
/** The most lights a cell lists (light-cells.wgsl's CELL_LIGHTS). */
export const CELL_LIGHTS = 32;
/** A cell in the buffer: its count, then CELL_LIGHTS light indices, as u32s. */
const CELL_BYTES = 4 * (1 + CELL_LIGHTS);

/** The grid's cells across x and z over a map `dims` voxels in size, at `voxel` metres a voxel. */
export function cellGrid(dims: { x: number; z: number }, voxel: number): [number, number] {
  return [Math.ceil((dims.x * voxel) / CELL_METRES), Math.ceil((dims.z * voxel) / CELL_METRES)];
}

export class LightCells {
  /** The cells, in rows of x: a count and CELL_LIGHTS indices each. */
  readonly cells: GPUBuffer;
  /** The grid's uniform (light-cells.wgsl's CellGrid), which the passes reading the cells bind too. */
  readonly grid: GPUBuffer;
  private readonly device: GPUDevice;
  private readonly pipeline: GPUComputePipeline;
  private readonly size: [number, number];
  private readonly side: number;
  private readonly groups: GPUBindGroup[];

  static async compile(device: GPUDevice): Promise<GPUComputePipeline> {
    const module = device.createShaderModule({ label: 'light cells', code: moduleSource(cellsSrc) });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length) throw new Error(`light-cells.wgsl: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`);
    return device.createComputePipelineAsync({ label: 'light cells', layout: 'auto', compute: { module, entryPoint: 'build' } });
  }

  /** Cells `size` across x and z over the lights in `lights` (positions in voxels of `voxel` metres). */
  static create(device: GPUDevice, pipeline: GPUComputePipeline, lights: GPUBuffer, size: readonly [number, number], voxel: number): LightCells {
    return new LightCells(device, pipeline, lights, size, voxel);
  }

  private constructor(device: GPUDevice, pipeline: GPUComputePipeline, lights: GPUBuffer, size: readonly [number, number], voxel: number) {
    this.device = device;
    this.pipeline = pipeline;
    this.size = [size[0], size[1]];
    this.side = CELL_METRES / voxel;
    this.cells = device.createBuffer({ label: 'light cells', size: size[0] * size[1] * CELL_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.grid = device.createBuffer({ label: 'light cell grid', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.groups = [
      device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 6, resource: { buffer: lights } }] }),
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: { buffer: this.grid } },
          { binding: 1, resource: { buffer: this.cells } },
        ],
      }),
    ];
  }

  /** Build the cells over the first `lightCount` lights, in one compute pass (timed by `timestampWrites`, if given). */
  encode(encoder: GPUCommandEncoder, lightCount: number, timestampWrites?: GPUComputePassTimestampWrites): void {
    const data = new ArrayBuffer(16);
    new Uint32Array(data, 0, 2).set(this.size);
    new Float32Array(data, 8, 1)[0] = this.side;
    new Uint32Array(data, 12, 1)[0] = lightCount;
    this.device.queue.writeBuffer(this.grid, 0, data);
    const pass = encoder.beginComputePass({ label: 'light cells', timestampWrites });
    pass.setPipeline(this.pipeline);
    this.groups.forEach((g, i) => pass.setBindGroup(i, g));
    // A workgroup a block of 2 × 2 cells (light-cells.wgsl).
    pass.dispatchWorkgroups(Math.ceil(this.size[0] / 2), Math.ceil(this.size[1] / 2));
    pass.end();
  }

  destroy(): void {
    this.cells.destroy();
    this.grid.destroy();
  }
}
