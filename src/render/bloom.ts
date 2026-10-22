/**
 * Bloom: a pyramid of six levels over the HDR image, each half the size of the one before
 * (Jimenez's 13-tap filter going down, a 3 × 3 tent coming back up), brought back into the first
 * as their mean (bloom.wgsl). Each level keeps the image's energy, so their mean does too, and the
 * present pass mixes it into the image at `render.bloom_weight` with no threshold: light is only
 * spread, never made. The one bound on it is `render.bloom_max`, the brightest a tap of the first
 * level is taken in at: it sets how far the sun's disc, at up to 30,000, lights the sky round it.
 *
 * Dynamic resolution renders part of each texture; every level's rendered part is half the one
 * before it (rounded up), and no tap reads outside it.
 */

import { moduleSource } from './shaders';
import bloomSrc from './shaders/bloom.wgsl';

export const BLOOM_LEVELS = 6;

export interface BloomPipelines {
  down: GPUComputePipeline;
  up: GPUComputePipeline;
}

/** Each pass's uniform (bloom.wgsl's Level, 32 bytes), at the 256-byte offsets a uniform binding needs. */
const STRIDE = 256;
const PASSES = 2 * BLOOM_LEVELS - 1;

const half = (n: number) => Math.max(1, Math.ceil(n / 2));

export class Bloom {
  private readonly device: GPUDevice;
  private readonly pipelines: BloomPipelines;
  private readonly sampler: GPUSampler;
  private readonly uniform: GPUBuffer;
  /** Level k + 1 going down, and the mean of levels k + 1 to the last coming back up. */
  private downs: GPUTexture[] = [];
  private ups: GPUTexture[] = [];
  private groups: GPUBindGroup[] = [];
  private alloc: [number, number] = [1, 1];

  static async compile(device: GPUDevice): Promise<BloomPipelines> {
    const module = device.createShaderModule({ label: 'bloom', code: moduleSource(bloomSrc) });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length) throw new Error(`bloom.wgsl: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`);
    const build = (entryPoint: string) => device.createComputePipelineAsync({ label: `bloom ${entryPoint}`, layout: 'auto', compute: { module, entryPoint } });
    const [down, up] = await Promise.all([build('down'), build('up')]);
    return { down, up };
  }

  static create(device: GPUDevice, pipelines: BloomPipelines): Bloom {
    return new Bloom(device, pipelines);
  }

  private constructor(device: GPUDevice, pipelines: BloomPipelines) {
    this.device = device;
    this.pipelines = pipelines;
    this.sampler = device.createSampler({ label: 'bloom', magFilter: 'linear', minFilter: 'linear' });
    this.uniform = device.createBuffer({ label: 'bloom levels', size: STRIDE * PASSES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** The pyramid's top: half the source's size, the mean of its six levels. */
  get output(): GPUTexture {
    return this.ups[0];
  }

  /** Fit the pyramid to a source image allocated at `alloc`, read through `source`. */
  resize(alloc: readonly [number, number], source: GPUTextureView): void {
    const device = this.device;
    for (const t of [...this.downs, ...this.ups]) t.destroy();
    this.alloc = [alloc[0], alloc[1]];
    const sizes: [number, number][] = [];
    let size: [number, number] = this.alloc;
    for (let k = 0; k < BLOOM_LEVELS; k++) sizes.push((size = [half(size[0]), half(size[1])]));
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC;
    const texture = (label: string, s: [number, number]) => device.createTexture({ label, size: s, format: 'rgba16float', usage });
    this.downs = sizes.map((s, k) => texture(`bloom down ${k + 1}`, s));
    this.ups = sizes.slice(0, -1).map((s, k) => texture(`bloom up ${k + 1}`, s));
    const slot = (i: number): GPUBindingResource => ({ buffer: this.uniform, offset: i * STRIDE, size: 32 });
    const group = (pipeline: GPUComputePipeline, entries: [number, GPUBindingResource][]) =>
      device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: entries.map(([binding, resource]) => ({ binding, resource })) });
    this.groups = [];
    // Down: level k + 1 from level k (the source first).
    for (let k = 0; k < BLOOM_LEVELS; k++) {
      const from = k === 0 ? source : this.downs[k - 1].createView();
      this.groups.push(group(this.pipelines.down, [[0, from], [2, this.sampler], [3, this.downs[k].createView()], [4, slot(k)]]));
    }
    // Up, from the top: the mean at level k + 1 from the coarser mean (the last level itself first) and level k + 1's own image.
    for (let k = BLOOM_LEVELS - 2; k >= 0; k--) {
      const coarse = k === BLOOM_LEVELS - 2 ? this.downs[BLOOM_LEVELS - 1] : this.ups[k + 1];
      const pass = BLOOM_LEVELS + (BLOOM_LEVELS - 2 - k);
      this.groups.push(group(this.pipelines.up, [[0, coarse.createView()], [1, this.downs[k].createView()], [2, this.sampler], [3, this.ups[k].createView()], [4, slot(pass)]]));
    }
  }

  /**
   * The pyramid over the source's rendered part, `res`, in one compute pass (timed by
   * `timestampWrites`, if given), no tap of the first level brighter than `cap`.
   */
  encode(encoder: GPUCommandEncoder, res: readonly [number, number], cap: number, timestampWrites?: GPUComputePassTimestampWrites): void {
    // Each level's rendered texels (the source's first) and the size its texture was allocated at.
    const valid: [number, number][] = [[res[0], res[1]]];
    for (let k = 0; k < BLOOM_LEVELS; k++) valid.push([half(valid[k][0]), half(valid[k][1])]);
    const allocs: [number, number][] = [this.alloc, ...this.downs.map((t): [number, number] => [t.width, t.height])];
    const data = new ArrayBuffer(STRIDE * PASSES);
    const write = (pass: number, from: number, to: number, count: number, tapCap: number) => {
      new Float32Array(data, pass * STRIDE, 4).set([...valid[from], ...allocs[from]]);
      new Uint32Array(data, pass * STRIDE + 16, 2).set(valid[to]);
      new Float32Array(data, pass * STRIDE + 24, 2).set([count, tapCap]);
    };
    for (let k = 0; k < BLOOM_LEVELS; k++) write(k, k, k + 1, 0, k === 0 ? cap : 1e30);
    for (let k = BLOOM_LEVELS - 2; k >= 0; k--) write(BLOOM_LEVELS + (BLOOM_LEVELS - 2 - k), k + 2, k + 1, BLOOM_LEVELS - 1 - k, 1e30);
    this.device.queue.writeBuffer(this.uniform, 0, data);
    const pass = encoder.beginComputePass({ label: 'bloom', timestampWrites });
    const dispatch = (pipeline: GPUComputePipeline, group: GPUBindGroup, size: [number, number]) => {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(size[0] / 8), Math.ceil(size[1] / 8));
    };
    for (let k = 0; k < BLOOM_LEVELS; k++) dispatch(this.pipelines.down, this.groups[k], valid[k + 1]);
    for (let k = BLOOM_LEVELS - 2; k >= 0; k--) dispatch(this.pipelines.up, this.groups[BLOOM_LEVELS + (BLOOM_LEVELS - 2 - k)], valid[k + 1]);
    pass.end();
  }

  destroy(): void {
    for (const t of [...this.downs, ...this.ups]) t.destroy();
    this.uniform.destroy();
  }
}
