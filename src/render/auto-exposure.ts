/**
 * The exposure that adapts to the frame (histogram.wgsl). exposure.wgsl reckons a base exposure from
 * the light, as milestone 2 did; this meters the frame under it, and where a view's metered mean
 * lies beyond a zone round the norm the approved views sit in (a lantern-lit dugout at night, say),
 * corrects the exposure by the excess, adapting as the eye does: quickly to a brighter scene, slowly
 * to a darker. Inside the zone the reckoned exposure stands, so the approved views keep theirs.
 */

import { moduleSource } from './shaders';
import histogramSrc from './shaders/histogram.wgsl';

export interface AutoExposurePipelines {
  count: GPUComputePipeline;
  adapt: GPUComputePipeline;
}

/** What one frame's adaptation needs: seconds since the last, the hour's bias, the norm and zone (stops), the rates (stops a second) and whether to land at once. */
export interface ExposureParams {
  dt: number;
  bias: number;
  target: number;
  zone: number;
  rise: number;
  fall: number;
  reset: boolean;
}

/** The adaptation's state: the exposure reckoned from the light, the correction (stops) and the correction wanted, and the frame's metered mean (stops). */
export interface ExposureState {
  base: number;
  correction: number;
  want: number;
  metered: number;
}

const BINS = 128;

export class AutoExposure {
  /** Eight floats: the base exposure (written by exposure.wgsl), the correction, its want, the metered mean. */
  readonly state: GPUBuffer;
  private readonly device: GPUDevice;
  private readonly pipelines: AutoExposurePipelines;
  private readonly bins: GPUBuffer;
  private readonly uniform: GPUBuffer;
  private readonly adaptGroup: GPUBindGroup;
  private countGroup: GPUBindGroup | null = null;

  static async compile(device: GPUDevice): Promise<AutoExposurePipelines> {
    const module = device.createShaderModule({ label: 'histogram', code: moduleSource(histogramSrc) });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length) throw new Error(`histogram.wgsl: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`);
    const build = (entryPoint: string) => device.createComputePipelineAsync({ label: `exposure ${entryPoint}`, layout: 'auto', compute: { module, entryPoint } });
    const [count, adapt] = await Promise.all([build('count'), build('adapt')]);
    return { count, adapt };
  }

  /** The meter, writing the presented exposure into `present` (the present pass's uniform, at 6). */
  static create(device: GPUDevice, pipelines: AutoExposurePipelines, present: GPUBuffer): AutoExposure {
    return new AutoExposure(device, pipelines, present);
  }

  private constructor(device: GPUDevice, pipelines: AutoExposurePipelines, present: GPUBuffer) {
    this.device = device;
    this.pipelines = pipelines;
    this.state = device.createBuffer({ label: 'exposure state', size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.bins = device.createBuffer({ label: 'exposure histogram', size: BINS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.uniform = device.createBuffer({ label: 'exposure params', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.adaptGroup = device.createBindGroup({
      label: 'exposure adapt',
      layout: pipelines.adapt.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 2, resource: { buffer: this.bins } },
        { binding: 3, resource: { buffer: this.state } },
        { binding: 4, resource: { buffer: present } },
      ],
    });
  }

  /** Meter `frame` from now on (the image the frame is presented from, at its allocated size). */
  bind(frame: GPUTextureView): void {
    this.countGroup = this.device.createBindGroup({
      label: 'exposure count',
      layout: this.pipelines.count.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: frame },
        { binding: 2, resource: { buffer: this.bins } },
        { binding: 3, resource: { buffer: this.state } },
      ],
    });
  }

  /** Meter the frame's rendered part `res` and adapt, in one compute pass (timed by `timestampWrites`, if given). */
  encode(encoder: GPUCommandEncoder, res: readonly [number, number], params: ExposureParams, timestampWrites?: GPUComputePassTimestampWrites): void {
    if (!this.countGroup) throw new Error('the exposure meter has no frame to meter (bind one)');
    const data = new ArrayBuffer(48);
    new Uint32Array(data, 0, 2).set(res);
    new Float32Array(data, 8, 6).set([params.dt, params.bias, params.target, params.zone, params.rise, params.fall]);
    new Uint32Array(data, 32, 1).set([params.reset ? 1 : 0]);
    this.device.queue.writeBuffer(this.uniform, 0, data);
    encoder.clearBuffer(this.bins);
    const pass = encoder.beginComputePass({ label: 'expose', timestampWrites });
    pass.setPipeline(this.pipelines.count);
    pass.setBindGroup(0, this.countGroup);
    pass.dispatchWorkgroups(Math.ceil(res[0] / 64), Math.ceil(res[1] / 64));
    pass.setPipeline(this.pipelines.adapt);
    pass.setBindGroup(0, this.adaptGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
  }

  /** The state after the frames submitted so far. */
  async read(): Promise<ExposureState> {
    const [base, correction, want, metered] = new Float32Array(await this.readBack(this.state, 16));
    return { base, correction, want, metered };
  }

  /** The last frame's counts, bin by bin. */
  async counts(): Promise<number[]> {
    return Array.from(new Uint32Array(await this.readBack(this.bins, BINS * 4)));
  }

  destroy(): void {
    for (const b of [this.state, this.bins, this.uniform]) b.destroy();
  }

  private async readBack(buffer: GPUBuffer, bytes: number): Promise<ArrayBuffer> {
    const staging = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, bytes);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = staging.getMappedRange().slice(0);
    staging.destroy();
    return out;
  }
}
