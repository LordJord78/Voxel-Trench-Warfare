/**
 * The frame: every pass, its textures and bind groups, in order. Compute
 * passes render the internal image (primary visibility into a G-buffer, then
 * shading); a render pass presents it to the canvas. Pipelines are compiled
 * in parallel when the renderer is created, so a visitor waits for the
 * slowest one, not the sum.
 *
 * Without a canvas (tests), the renderer draws at a fixed size and its
 * textures can be read back by name.
 */

import type { WorldPlan } from '../world/generation/plan';
import { jitter, type CameraPose } from './camera';
import type { Gpu } from './device';
import { FRAME, PROBE_DUSK, writeCamera, writeSky, writeWorldInfo, type FrameSky } from './frame-uniforms';
import type { GpuWorld } from './gpu-world';
import { StructWriter } from './layout';
import { sceneGroup, sceneLayout } from './scene';
import { moduleSource } from './shaders';
import debugSrc from './shaders/debug.wgsl';
import presentSrc from './shaders/present.wgsl';
import primarySrc from './shaders/primary.wgsl';
import { GpuTimer } from './timing';

const PASSES = ['primary', 'shade', 'present'] as const;

export interface RenderStats {
  gpuMs: number | null;
  passes: Record<string, number>;
  res: [number, number];
  frame: number;
}

export interface RendererOptions {
  /** The internal size when there is no canvas. */
  size?: [number, number];
  /** The internal image's target size, in megapixels: 1.5 for the "high" preset. */
  megapixels?: number;
  /** Bytes of world edits uploaded per frame. */
  uploadBudget?: number;
}

/** The internal image for a canvas: the canvas itself, or `megapixels` at its aspect if that is smaller. */
export function internalSize(width: number, height: number, megapixels: number): [number, number] {
  if (width * height <= megapixels * 1e6) return [width, height];
  const aspect = width / height;
  const w = Math.round(Math.sqrt(megapixels * 1e6 * aspect));
  return [w, Math.round(w / aspect)];
}

async function compute(device: GPUDevice, label: string, source: string, layouts: GPUBindGroupLayout[]): Promise<GPUComputePipeline> {
  const module = device.createShaderModule({ label, code: moduleSource(source) });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length) throw new Error(`${label}.wgsl: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`);
  return device.createComputePipelineAsync({
    label,
    layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
    compute: { module, entryPoint: 'main' },
  });
}

const STAGE = () => GPUShaderStage.COMPUTE;

function storageTexture(binding: number, format: GPUTextureFormat): GPUBindGroupLayoutEntry {
  return { binding, visibility: STAGE(), storageTexture: { access: 'write-only', format } };
}

function sampled(binding: number, sampleType: GPUTextureSampleType): GPUBindGroupLayoutEntry {
  return { binding, visibility: STAGE(), texture: { sampleType } };
}

export class Renderer {
  readonly device: GPUDevice;
  readonly world: GpuWorld;
  readonly plan: WorldPlan | null;
  /** Extra frame flags (see FLAGS), for tests and debugging. */
  flags = 0;
  /** What the frame is lit by. */
  sky: FrameSky = PROBE_DUSK;
  stats: RenderStats = { gpuMs: null, passes: {}, res: [0, 0], frame: 0 };

  private readonly canvas: HTMLCanvasElement | null;
  private readonly context: GPUCanvasContext | null;
  private readonly format: GPUTextureFormat;
  private readonly options: RendererOptions;
  private readonly timer: GpuTimer;
  private readonly writer = new StructWriter(FRAME);
  private readonly frameBuffer: GPUBuffer;
  private readonly presentBuffer: GPUBuffer;
  private readonly scene: GPUBindGroupLayout;
  private readonly layouts: Record<'primary' | 'shade' | 'present', GPUBindGroupLayout>;
  private readonly sampler: GPUSampler;
  private pipelines!: { primary: GPUComputePipeline; shade: GPUComputePipeline; present: GPURenderPipeline };
  private sceneGroup: GPUBindGroup | null = null;
  private sceneGeneration = -1;
  private groups: Partial<Record<'primary' | 'shade' | 'present', GPUBindGroup>> = {};
  private textures: Record<string, GPUTexture> = {};
  private res: [number, number] = [0, 0];
  private canvasSize: [number, number] = [0, 0];
  private frameIndex = 0;
  private prevPose: CameraPose | null = null;

  static async create(gpu: Gpu, canvas: HTMLCanvasElement | null, world: GpuWorld, plan: WorldPlan | null, options: RendererOptions = {}): Promise<Renderer> {
    const r = new Renderer(gpu, canvas, world, plan, options);
    await r.compile();
    if (canvas) r.resize(canvas.width, canvas.height);
    else r.resize(...(options.size ?? [320, 240]));
    return r;
  }

  private constructor(gpu: Gpu, canvas: HTMLCanvasElement | null, world: GpuWorld, plan: WorldPlan | null, options: RendererOptions) {
    const device = gpu.device;
    this.device = device;
    this.world = world;
    this.plan = plan;
    this.canvas = canvas;
    this.options = options;
    this.context = canvas ? (canvas.getContext('webgpu') as GPUCanvasContext) : null;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.timer = new GpuTimer(device, gpu.timestamps, PASSES);
    this.frameBuffer = device.createBuffer({ label: 'frame', size: this.writer.buffer.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.presentBuffer = device.createBuffer({ label: 'present', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.scene = sceneLayout(device);
    this.layouts = {
      primary: device.createBindGroupLayout({
        label: 'primary',
        entries: [storageTexture(0, 'r32float'), storageTexture(1, 'rg32uint'), storageTexture(2, 'rgba16float')],
      }),
      shade: device.createBindGroupLayout({
        label: 'shade',
        entries: [sampled(0, 'unfilterable-float'), sampled(1, 'uint'), storageTexture(2, 'rgba16float')],
      }),
      present: device.createBindGroupLayout({
        label: 'present',
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        ],
      }),
    };
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }

  private async compile(): Promise<void> {
    const device = this.device;
    const presentModule = device.createShaderModule({ label: 'present', code: presentSrc });
    const [primary, shade, present] = await Promise.all([
      compute(device, 'primary', primarySrc, [this.scene, this.layouts.primary]),
      compute(device, 'shade', debugSrc, [this.scene, this.layouts.shade]),
      device.createRenderPipelineAsync({
        label: 'present',
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.layouts.present] }),
        vertex: { module: presentModule, entryPoint: 'vs' },
        fragment: { module: presentModule, entryPoint: 'fs', targets: [{ format: this.format }] },
        primitive: { topology: 'triangle-list' },
      }),
    ]);
    this.pipelines = { primary, shade, present };
  }

  /** Size the canvas (device pixels) and reallocate the internal image to match. */
  resize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    this.canvasSize = [w, h];
    if (this.canvas && this.context) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });
      this.res = internalSize(w, h, this.options.megapixels ?? 1.5);
    } else {
      this.res = [w, h];
    }
    for (const t of Object.values(this.textures)) t.destroy();
    const make = (name: string, format: GPUTextureFormat) => {
      this.textures[name] = this.device.createTexture({
        label: name,
        size: this.res,
        format,
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
    };
    make('gDepth', 'r32float');
    make('gHit', 'rg32uint');
    make('gMotion', 'rgba16float');
    make('colour', 'rgba16float');
    const view = (name: string) => this.textures[name].createView();
    this.groups = {
      primary: this.device.createBindGroup({
        layout: this.layouts.primary,
        entries: [{ binding: 0, resource: view('gDepth') }, { binding: 1, resource: view('gHit') }, { binding: 2, resource: view('gMotion') }],
      }),
      shade: this.device.createBindGroup({
        layout: this.layouts.shade,
        entries: [{ binding: 0, resource: view('gDepth') }, { binding: 1, resource: view('gHit') }, { binding: 2, resource: view('colour') }],
      }),
      present: this.device.createBindGroup({
        layout: this.layouts.present,
        entries: [{ binding: 0, resource: view('colour') }, { binding: 1, resource: this.sampler }, { binding: 2, resource: { buffer: this.presentBuffer } }],
      }),
    };
    this.prevPose = null;
  }

  texture(name: string): GPUTexture {
    const t = this.textures[name];
    if (!t) throw new Error(`no texture '${name}'`);
    return t;
  }

  /** Draw one frame from `pose` (metres, degrees) at a time of day (0 dusk, 1 night). */
  render(pose: CameraPose, timeOfDay: number, now: number): void {
    const device = this.device;
    const voxel = this.voxelSize();
    const eye: [number, number, number] = [pose.position[0] / voxel, pose.position[1] / voxel, pose.position[2] / voxel];
    this.world.flush(this.options.uploadBudget ?? 1 << 20, eye);
    // A grown heap is a new buffer: the scene group follows it.
    if (this.world.generation !== this.sceneGeneration || !this.sceneGroup) {
      this.sceneGroup = sceneGroup(device, this.scene, this.frameBuffer, this.world);
      this.sceneGeneration = this.world.generation;
    }

    const w = this.writer;
    const j = jitter(this.frameIndex);
    writeWorldInfo(w, this.world);
    writeCamera(w, 'cam', pose, voxel, j);
    writeCamera(w, 'prev', this.prevPose ?? pose, voxel, j);
    w.set('res', this.res);
    w.set('alloc', this.res);
    w.set('lightRes', [Math.ceil(this.res[0] / 2), Math.ceil(this.res[1] / 2)]);
    w.set('lightScale', 2);
    w.set('frame', this.frameIndex);
    w.set('flags', this.flags);
    w.set('voxel', voxel);
    w.set('timeOfDay', timeOfDay);
    writeSky(w, this.sky);
    device.queue.writeBuffer(this.frameBuffer, 0, w.buffer);

    const encoder = device.createCommandEncoder({ label: `frame ${this.frameIndex}` });
    const groups = [Math.ceil(this.res[0] / 8), Math.ceil(this.res[1] / 8)] as const;
    const pass = (name: 'primary' | 'shade', pipeline: GPUComputePipeline) => {
      const p = encoder.beginComputePass({ label: name, timestampWrites: this.timer.writes(name) });
      p.setPipeline(pipeline);
      p.setBindGroup(0, this.sceneGroup!);
      p.setBindGroup(1, this.groups[name]!);
      p.dispatchWorkgroups(groups[0], groups[1]);
      p.end();
    };
    pass('primary', this.pipelines.primary);
    pass('shade', this.pipelines.shade);
    if (this.context) {
      const present = new Float32Array([this.res[0], this.res[1], this.res[0], this.res[1], this.canvasSize[0], this.canvasSize[1], this.sky.exposure, 0]);
      device.queue.writeBuffer(this.presentBuffer, 0, present);
      const target = this.context.getCurrentTexture();
      const p = encoder.beginRenderPass({
        label: 'present',
        colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        timestampWrites: this.timer.writes('present'),
      });
      p.setPipeline(this.pipelines.present);
      p.setBindGroup(0, this.groups.present!);
      p.draw(3);
      p.end();
    }
    this.timer.resolve(encoder);
    device.queue.submit([encoder.finish()]);
    this.timer.collect();

    this.prevPose = { position: [...pose.position], yaw: pose.yaw, pitch: pose.pitch };
    this.frameIndex++;
    this.stats = { gpuMs: this.timer.gpuMs, passes: { ...this.timer.passes }, res: [...this.res], frame: this.frameIndex };
    void now;
  }

  private voxelSize(): number {
    return this.plan?.params.voxel ?? 0.1;
  }
}
