/**
 * The frame: every pass, its textures and bind groups, in order.
 *
 * Compute passes render the internal image:
 *   primary  — one jittered ray per pixel into the G-buffer;
 *   lighting — the light reaching one pixel of each 2 × 2 block;
 *   temporal — that light blended into its reprojected history;
 *   atrous   — three edge-stopping filter passes over it, for display (the
 *              history keeps the plain average, so converged edges stay put);
 *   shade    — the image: upsampled light, materials, water, far field,
 *              sky and height fog.
 * A render pass presents it to the canvas. Pipelines compile in parallel and
 * need only the device (see compileFrame), so they can compile while the
 * world generates.
 *
 * Without a canvas (tests), the renderer draws at a fixed size and its
 * textures can be read back by name.
 */

import type { WorldPlan } from '../world/generation/plan';
import { jitter, type CameraPose } from './camera';
import type { Gpu } from './device';
import { FarFieldGpu } from './farfield-gpu';
import { FLAGS, FRAME, PROBE_DUSK, writeCamera, writeSky, writeWorldInfo, type FrameSky } from './frame-uniforms';
import type { GpuWorld } from './gpu-world';
import { StructWriter } from './layout';
import { lightBuffer, MAX_LIGHTS, type SceneLight } from './lights';
import { sceneExtras, sceneGroup, sceneLayout } from './scene';
import { moduleSource } from './shaders';
import atrousSrc from './shaders/atrous.wgsl';
import lightingSrc from './shaders/lighting.wgsl';
import presentSrc from './shaders/present.wgsl';
import primarySrc from './shaders/primary.wgsl';
import shadeSrc from './shaders/shade.wgsl';
import temporalSrc from './shaders/temporal.wgsl';
import { GpuTimer } from './timing';

const PASSES = ['primary', 'lighting', 'temporal', 'atrous1', 'atrous2', 'atrous3', 'shade', 'present'] as const;
type ComputePass = 'primary' | 'lighting' | 'temporal' | 'atrous' | 'shade';
type Timed = (typeof PASSES)[number];

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
  /** The ground past the map's edge; none if absent. */
  far?: FarFieldGpu;
  /** Pipelines compiled ahead of time (see compileFrame); compiled now if absent. */
  compiled?: CompiledFrame;
  /** The denoiser: frames of history at most, and its filter's edge widths (render.history_max, atrous_sigma_*). */
  denoise?: { historyMax: number; sigmaLuma: number; sigmaPlane: number };
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

function uniform(binding: number): GPUBindGroupLayoutEntry {
  return { binding, visibility: STAGE(), buffer: { type: 'uniform' } };
}

/** Everything the GPU compiles or builds once for a frame, independent of any world. */
export interface CompiledFrame {
  scene: GPUBindGroupLayout;
  layouts: Record<ComputePass | 'present', GPUBindGroupLayout>;
  pipelines: Record<ComputePass, GPUComputePipeline> & { present: GPURenderPipeline };
  lights: GPUBuffer;
  noise: GPUTexture;
}

/** Compile the frame's pipelines, in parallel. Needs only the device, so it can run while the world generates. */
export async function compileFrame(device: GPUDevice): Promise<CompiledFrame> {
  const scene = sceneLayout(device);
  const layouts = {
    primary: device.createBindGroupLayout({
      label: 'primary',
      entries: [storageTexture(0, 'r32float'), storageTexture(1, 'rg32uint'), storageTexture(2, 'rgba16float')],
    }),
    lighting: device.createBindGroupLayout({
      label: 'lighting',
      entries: [sampled(0, 'unfilterable-float'), sampled(1, 'uint'), storageTexture(2, 'rgba16float'), storageTexture(3, 'r32float'), storageTexture(4, 'rg32uint')],
    }),
    temporal: device.createBindGroupLayout({
      label: 'temporal',
      entries: [
        sampled(0, 'float'), sampled(1, 'unfilterable-float'), sampled(2, 'uint'), sampled(3, 'uint'), sampled(4, 'float'), sampled(5, 'float'),
        storageTexture(6, 'rgba16float'), storageTexture(7, 'rgba16float'), storageTexture(8, 'rg32float'), sampled(9, 'unfilterable-float'),
      ],
    }),
    atrous: device.createBindGroupLayout({
      label: 'atrous',
      entries: [sampled(0, 'float'), sampled(1, 'unfilterable-float'), sampled(2, 'uint'), storageTexture(3, 'rgba16float'), storageTexture(4, 'rg32float'), uniform(5)],
    }),
    shade: device.createBindGroupLayout({
      label: 'shade',
      entries: [sampled(0, 'unfilterable-float'), sampled(1, 'uint'), storageTexture(2, 'rgba16float'), sampled(3, 'float'), sampled(4, 'uint')],
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
  const presentModule = device.createShaderModule({ label: 'present', code: presentSrc });
  const [primary, lighting, temporal, atrous, shade, present] = await Promise.all([
    compute(device, 'primary', primarySrc, [scene, layouts.primary]),
    compute(device, 'lighting', lightingSrc, [scene, layouts.lighting]),
    compute(device, 'temporal', temporalSrc, [scene, layouts.temporal]),
    compute(device, 'atrous', atrousSrc, [scene, layouts.atrous]),
    compute(device, 'shade', shadeSrc, [scene, layouts.shade]),
    device.createRenderPipelineAsync({
      label: 'present',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.present] }),
      vertex: { module: presentModule, entryPoint: 'vs' },
      fragment: { module: presentModule, entryPoint: 'fs', targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }] },
      primitive: { topology: 'triangle-list' },
    }),
  ]);
  return { scene, layouts, pipelines: { primary, lighting, temporal, atrous, shade, present }, ...sceneExtras(device) };
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
  private readonly compiled: CompiledFrame;
  private readonly sampler: GPUSampler;
  private readonly far: FarFieldGpu;
  private sceneGroup: GPUBindGroup | null = null;
  private sceneGeneration = -1;
  /** Bind groups by frame parity: histories ping-pong between two sets of textures. */
  private groups: Partial<Record<ComputePass | 'present' | 'atrous1' | 'atrous2' | 'atrous3', GPUBindGroup>>[] = [{}, {}];
  private readonly steps: GPUBuffer[];
  private resetNext = true;
  private textures: Record<string, GPUTexture> = {};
  private res: [number, number] = [0, 0];
  private lightScale = 2;
  private canvasSize: [number, number] = [0, 0];
  private frameIndex = 0;
  private prevPose: CameraPose | null = null;
  private lightCount = 0;

  static async create(gpu: Gpu, canvas: HTMLCanvasElement | null, world: GpuWorld, plan: WorldPlan | null, options: RendererOptions = {}): Promise<Renderer> {
    const compiled = options.compiled ?? (await compileFrame(gpu.device));
    const r = new Renderer(gpu, canvas, world, plan, options, compiled);
    if (canvas) r.resize(canvas.width, canvas.height);
    else r.resize(...(options.size ?? [320, 240]));
    return r;
  }

  private constructor(gpu: Gpu, canvas: HTMLCanvasElement | null, world: GpuWorld, plan: WorldPlan | null, options: RendererOptions, compiled: CompiledFrame) {
    const device = gpu.device;
    this.device = device;
    this.world = world;
    this.plan = plan;
    this.canvas = canvas;
    this.options = options;
    this.compiled = compiled;
    this.context = canvas ? (canvas.getContext('webgpu') as GPUCanvasContext) : null;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.timer = new GpuTimer(device, gpu.timestamps, PASSES);
    this.frameBuffer = device.createBuffer({ label: 'frame', size: this.writer.buffer.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.presentBuffer = device.createBuffer({ label: 'present', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.far = options.far ?? FarFieldGpu.empty(device);
    this.steps = [1, 2, 4].map((step) => {
      const b = device.createBuffer({ label: `atrous step ${step}`, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, new Int32Array([step, 0, 0, 0]));
      return b;
    });
  }

  /** The lighting image's size: the internal image over the lighting scale, rounded up. */
  get lightResolution(): [number, number] {
    return [Math.ceil(this.res[0] / this.lightScale), Math.ceil(this.res[1] / this.lightScale)];
  }

  /** The point lights, with flares burning at `flares` (0 to 1) of their strength. */
  setLights(lights: readonly SceneLight[], flares: number): void {
    if (lights.length > MAX_LIGHTS) throw new RangeError(`${lights.length} lights is over the ${MAX_LIGHTS} a frame samples`);
    this.device.queue.writeBuffer(this.compiled.lights, 0, lightBuffer(lights, flares, this.voxelSize()));
    this.lightCount = lights.length;
  }

  /** Size the canvas (device pixels) and reallocate the internal images to match. */
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
    this.textures = {};
    const make = (name: string, format: GPUTextureFormat, size: [number, number]) => {
      this.textures[name] = this.device.createTexture({
        label: name,
        size,
        format,
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
    };
    make('gDepth', 'r32float', this.res);
    make('gHit', 'rg32uint', this.res);
    make('gMotion', 'rgba16float', this.res);
    make('colour', 'rgba16float', this.res);
    const light = this.lightResolution;
    make('lNoisy', 'rgba16float', light);
    for (const k of [0, 1]) {
      make(`hDepth${k}`, 'r32float', light);
      make(`hHit${k}`, 'rg32uint', light);
      make(`hColour${k}`, 'rgba16float', light);
      make(`hMoments${k}`, 'rgba16float', light);
    }
    make('variance', 'rg32float', light);
    make('varianceA', 'rg32float', light);
    make('varianceB', 'rg32float', light);
    make('filteredA', 'rgba16float', light);
    make('filteredB', 'rgba16float', light);
    make('denoised', 'rgba16float', light);
    const view = (name: string) => this.textures[name].createView();
    const group = (pass: ComputePass | 'present', resources: GPUBindingResource[]) =>
      this.device.createBindGroup({ label: pass, layout: this.compiled.layouts[pass], entries: resources.map((resource, binding) => ({ binding, resource })) });
    this.groups = [0, 1].map((cur) => {
      const prev = 1 - cur;
      return {
        primary: group('primary', [view('gDepth'), view('gHit'), view('gMotion')]),
        lighting: group('lighting', [view('gDepth'), view('gHit'), view('lNoisy'), view(`hDepth${cur}`), view(`hHit${cur}`)]),
        temporal: group('temporal', [
          view('lNoisy'), view(`hDepth${cur}`), view(`hHit${cur}`), view(`hHit${prev}`), view(`hColour${prev}`), view(`hMoments${prev}`),
          view(`hColour${cur}`), view(`hMoments${cur}`), view('variance'), view(`hDepth${prev}`),
        ]),
        atrous1: group('atrous', [view(`hColour${cur}`), view('variance'), view(`hHit${cur}`), view('filteredA'), view('varianceA'), { buffer: this.steps[0] }]),
        atrous2: group('atrous', [view('filteredA'), view('varianceA'), view(`hHit${cur}`), view('filteredB'), view('varianceB'), { buffer: this.steps[1] }]),
        atrous3: group('atrous', [view('filteredB'), view('varianceB'), view(`hHit${cur}`), view('denoised'), view('varianceA'), { buffer: this.steps[2] }]),
        shade: group('shade', [view('gDepth'), view('gHit'), view('colour'), view('denoised'), view(`hHit${cur}`)]),
        present: group('present', [view('colour'), this.sampler, { buffer: this.presentBuffer }]),
      };
    });
    this.resetNext = true;
    this.prevPose = null;
  }

  /** A texture by name; a history (hDepth, hHit, hColour, hMoments) is the one the last frame wrote. */
  texture(name: string): GPUTexture {
    const last = (this.frameIndex + 1) & 1;
    const t = this.textures[name] ?? this.textures[`${name}${last}`];
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
      this.sceneGroup = sceneGroup(device, this.compiled.scene, {
        frame: this.frameBuffer,
        world: this.world,
        far: this.far,
        lights: this.compiled.lights,
        noise: this.compiled.noise,
      });
      this.sceneGeneration = this.world.generation;
    }

    const w = this.writer;
    const j = jitter(this.frameIndex);
    writeWorldInfo(w, this.world);
    writeCamera(w, 'cam', pose, voxel, j);
    writeCamera(w, 'prev', this.prevPose ?? pose, voxel, j);
    w.set('res', this.res);
    w.set('alloc', this.res);
    w.set('lightRes', this.lightResolution);
    w.set('lightScale', this.lightScale);
    w.set('frame', this.frameIndex);
    // A history from before a resize is in textures that no longer exist.
    w.set('flags', this.flags | (this.resetNext ? FLAGS.HISTORY_RESET : 0));
    this.resetNext = false;
    w.set('lightCount', this.lightCount);
    w.set('voxel', voxel);
    w.set('timeOfDay', timeOfDay);
    w.set('lightRays', 3);
    const denoise = this.options.denoise ?? { historyMax: 32, sigmaLuma: 4, sigmaPlane: 1 };
    w.set('historyMax', denoise.historyMax);
    w.set('sigmaLuma', denoise.sigmaLuma);
    w.set('sigmaPlane', denoise.sigmaPlane);
    writeSky(w, this.sky);
    w.set('far', this.far.info);
    device.queue.writeBuffer(this.frameBuffer, 0, w.buffer);

    const encoder = device.createCommandEncoder({ label: `frame ${this.frameIndex}` });
    const groups = this.groups[this.frameIndex & 1];
    const pass = (name: Timed & keyof typeof groups, pipeline: ComputePass, size: readonly [number, number]) => {
      const p = encoder.beginComputePass({ label: name, timestampWrites: this.timer.writes(name) });
      p.setPipeline(this.compiled.pipelines[pipeline]);
      p.setBindGroup(0, this.sceneGroup!);
      p.setBindGroup(1, groups[name]!);
      p.dispatchWorkgroups(Math.ceil(size[0] / 8), Math.ceil(size[1] / 8));
      p.end();
    };
    const light = this.lightResolution;
    pass('primary', 'primary', this.res);
    pass('lighting', 'lighting', light);
    pass('temporal', 'temporal', light);
    pass('atrous1', 'atrous', light);
    pass('atrous2', 'atrous', light);
    pass('atrous3', 'atrous', light);
    pass('shade', 'shade', this.res);
    if (this.context) {
      const present = new Float32Array([this.res[0], this.res[1], this.res[0], this.res[1], this.canvasSize[0], this.canvasSize[1], this.sky.exposure, 0]);
      device.queue.writeBuffer(this.presentBuffer, 0, present);
      const p = encoder.beginRenderPass({
        label: 'present',
        colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        timestampWrites: this.timer.writes('present'),
      });
      p.setPipeline(this.compiled.pipelines.present);
      p.setBindGroup(0, groups.present!);
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
