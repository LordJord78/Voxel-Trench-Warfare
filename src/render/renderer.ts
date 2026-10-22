/**
 * The frame: every pass, its textures and bind groups, in order.
 *
 * Compute passes render the internal image:
 *   sky      — the atmosphere's sky view for this frame's sun and camera height
 *              (see atmosphere.ts);
 *   beam     — per 8 × 8 tile, how far its rays can go before meeting anything;
 *   primary  — one jittered ray per pixel into the G-buffer, from its tile's beam;
 *   lighting — the light reaching one pixel of each 2 × 2 block (the sky's
 *              ray in half of them, by turns, each frame);
 *   temporal — that light blended into its reprojected history;
 *   atrous   — three edge-stopping filter passes over it, for display (the
 *              history keeps the plain average, so converged edges stay put);
 *   shade    — the image: upsampled light, materials, water, far field,
 *              sky and height fog;
 *   taa      — blended into its own reprojected history, which smooths the
 *              jitter into anti-aliased edges;
 *   cas      — sharpened back.
 * A render pass presents it to the canvas: upscaled, tonemapped, dithered. Pipelines compile in parallel and
 * need only the device (see compileFrame), so they can compile while the
 * world generates.
 *
 * Textures are allocated for the preset's internal image; dynamic resolution
 * renders a scaled part of them (50 to 100% per axis), and the passes that
 * read last frame's images rescale to the size it had, so a scale change
 * keeps the histories. A resize, a preset change or a gap of over half a
 * second between frames starts them afresh.
 *
 * Without a canvas (tests), the renderer draws at a fixed size, at full scale
 * unless told otherwise, and its textures can be read back by name.
 */

import { loadTunables } from '../core/tunables';
import type { WorldPlan } from '../world/generation/plan';
import { Atmosphere, atmosphereModel, type AtmospherePipelines } from './atmosphere';
import { jitter, type CameraPose } from './camera';
import type { Gpu } from './device';
import { DynamicResolution } from './dynres';
import { FarFieldGpu } from './farfield-gpu';
import { FLAGS, FRAME, PROBE_DUSK, writeCamera, writeSky, writeWorldInfo, type FrameSky } from './frame-uniforms';
import type { GpuWorld } from './gpu-world';
import { StructWriter } from './layout';
import { lightBuffer, MAX_LIGHTS, type SceneLight } from './lights';
import { LIGHT_SCALE, scaledSize, type Preset, type RenderSettings } from './quality';
import { sceneExtras, sceneGroup, sceneLayout, type SkyLuts } from './scene';
import { moduleSource } from './shaders';
import atrousSrc from './shaders/atrous.wgsl';
import beamSrc from './shaders/beam.wgsl';
import casSrc from './shaders/cas.wgsl';
import lightingSrc from './shaders/lighting.wgsl';
import presentSrc from './shaders/present.wgsl';
import primarySrc from './shaders/primary.wgsl';
import shadeSrc from './shaders/shade.wgsl';
import taaSrc from './shaders/taa.wgsl';
import temporalSrc from './shaders/temporal.wgsl';
import { frameBudget, GpuTimer } from './timing';

const PASSES = ['sky', 'beam', 'primary', 'lighting', 'temporal', 'atrous1', 'atrous2', 'atrous3', 'shade', 'taa', 'cas', 'present'] as const;
type ComputePass = 'beam' | 'primary' | 'lighting' | 'temporal' | 'atrous' | 'shade' | 'taa' | 'cas';
type Timed = (typeof PASSES)[number];

/** A gap between frames longer than this (a hidden tab, a debugger) leaves histories too stale to blend. */
const GAP_MS = 500;

export interface RenderStats {
  gpuMs: number | null;
  passes: Record<string, number>;
  /** The internal image this frame, the size its textures hold, and the canvas (device pixels). */
  res: [number, number];
  alloc: [number, number];
  canvas: [number, number];
  scale: number;
  preset: Preset;
  dynres: boolean;
  /** Whether this frame started its histories afresh. */
  reset: boolean;
  frame: number;
}

export interface Quality {
  preset: Preset;
  /** Whether dynamic resolution chooses the scale. */
  dynres: boolean;
  /** The internal image per axis, 0.5 to 1, in steps of 1/32. */
  scale: number;
}

export interface RendererOptions extends Partial<RenderSettings> {
  /** The internal size when there is no canvas. */
  size?: [number, number];
  /** The ground past the map's edge; none if absent. */
  far?: FarFieldGpu;
  /** Pipelines compiled ahead of time (see compileFrame); compiled now if absent. */
  compiled?: CompiledFrame;
  preset?: Preset;
  /** Start with dynamic resolution on (the game); off, the image stays at full scale (tests). */
  dynres?: boolean;
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
  atmosphere: AtmospherePipelines;
  lights: GPUBuffer;
  noise: GPUTexture;
  /** Empty sky LUTs, for scenes built without an atmosphere. */
  sky: SkyLuts;
}

/** Compile the frame's pipelines, in parallel. Needs only the device, so it can run while the world generates. */
export async function compileFrame(device: GPUDevice): Promise<CompiledFrame> {
  const scene = sceneLayout(device);
  const layouts = {
    beam: device.createBindGroupLayout({ label: 'beam', entries: [storageTexture(0, 'r32float')] }),
    primary: device.createBindGroupLayout({
      label: 'primary',
      entries: [storageTexture(0, 'r32float'), storageTexture(1, 'rg32uint'), storageTexture(2, 'rgba16float'), sampled(3, 'unfilterable-float')],
    }),
    lighting: device.createBindGroupLayout({
      label: 'lighting',
      entries: [
        sampled(0, 'unfilterable-float'), sampled(1, 'uint'), storageTexture(2, 'rgba16float'), storageTexture(3, 'r32float'), storageTexture(4, 'rg32uint'),
        storageTexture(5, 'r32float'),
      ],
    }),
    temporal: device.createBindGroupLayout({
      label: 'temporal',
      entries: [
        sampled(0, 'float'), sampled(1, 'unfilterable-float'), sampled(2, 'uint'), sampled(3, 'uint'), sampled(4, 'float'), sampled(5, 'float'),
        storageTexture(6, 'rgba16float'), storageTexture(7, 'rgba16float'), storageTexture(8, 'rg32float'), sampled(9, 'unfilterable-float'),
        sampled(10, 'unfilterable-float'),
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
    taa: device.createBindGroupLayout({
      label: 'taa',
      entries: [
        sampled(0, 'float'), sampled(1, 'float'), sampled(2, 'float'), storageTexture(3, 'rgba16float'),
        { binding: 4, visibility: STAGE(), sampler: { type: 'filtering' } },
      ],
    }),
    cas: device.createBindGroupLayout({
      label: 'cas',
      entries: [sampled(0, 'float'), storageTexture(1, 'rgba16float')],
    }),
    present: device.createBindGroupLayout({
      label: 'present',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'uint' } },
      ],
    }),
  };
  const presentModule = device.createShaderModule({ label: 'present', code: presentSrc });
  const [beam, primary, lighting, temporal, atrous, shade, taa, cas, present, atmosphere] = await Promise.all([
    compute(device, 'beam', beamSrc, [scene, layouts.beam]),
    compute(device, 'primary', primarySrc, [scene, layouts.primary]),
    compute(device, 'lighting', lightingSrc, [scene, layouts.lighting]),
    compute(device, 'temporal', temporalSrc, [scene, layouts.temporal]),
    compute(device, 'atrous', atrousSrc, [scene, layouts.atrous]),
    compute(device, 'shade', shadeSrc, [scene, layouts.shade]),
    compute(device, 'taa', taaSrc, [scene, layouts.taa]),
    compute(device, 'cas', casSrc, [scene, layouts.cas]),
    device.createRenderPipelineAsync({
      label: 'present',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.present] }),
      vertex: { module: presentModule, entryPoint: 'vs' },
      fragment: { module: presentModule, entryPoint: 'fs', targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }] },
      primitive: { topology: 'triangle-list' },
    }),
    Atmosphere.compile(device),
  ]);
  return { scene, layouts, pipelines: { beam, primary, lighting, temporal, atrous, shade, taa, cas, present }, atmosphere, ...sceneExtras(device) };
}

export class Renderer {
  readonly device: GPUDevice;
  readonly world: GpuWorld;
  readonly plan: WorldPlan | null;
  /** Extra frame flags (see FLAGS), for tests and debugging. */
  flags = 0;
  /** What the frame is lit by. */
  sky: FrameSky = PROBE_DUSK;
  stats: RenderStats = { gpuMs: null, passes: {}, res: [0, 0], alloc: [0, 0], canvas: [0, 0], scale: 1, preset: 'high', dynres: false, reset: false, frame: 0 };

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
  /** The sky's LUTs and the faces' irradiance, built each frame for the frame's sky. */
  readonly atmosphere: Atmosphere;
  private sceneGroup: GPUBindGroup | null = null;
  private sceneGeneration = -1;
  /** Bind groups by frame parity: histories ping-pong between two sets of textures. */
  private groups: Partial<Record<ComputePass | 'present' | 'atrous1' | 'atrous2' | 'atrous3', GPUBindGroup>>[] = [{}, {}];
  private readonly steps: GPUBuffer[];
  private resetNext = true;
  private textures: Record<string, GPUTexture> = {};
  /** The size the internal images are allocated at, and the scaled part of it this frame renders. */
  private alloc: [number, number] = [0, 0];
  private res: [number, number] = [0, 0];
  /** What the last frame rendered: its histories cover that much of their textures. */
  private prevRes: [number, number] | null = null;
  private preset: Preset;
  private lightScale: number;
  private scale = 1;
  private budgetMs: number;
  private dynres: DynamicResolution | null = null;
  private timerSamples = 0;
  private lastNow: number | null = null;
  private canvasSize: [number, number] = [0, 0];
  private frameIndex = 0;
  private prevPose: CameraPose | null = null;
  /** The jitter the last frame applied (none if it turned jitter off): its history was rendered through it. */
  private prevJitter: [number, number] = [0, 0];
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
    this.atmosphere = Atmosphere.create(device, compiled.atmosphere, options.atmosphere ?? atmosphereModel(loadTunables()));
    this.preset = options.preset ?? 'high';
    this.lightScale = LIGHT_SCALE[this.preset];
    this.budgetMs = options.budgetMs ?? 14;
    if (options.dynres) this.dynres = new DynamicResolution(frameBudget(this.timer.enabled, this.budgetMs));
    this.steps = [1, 2, 4].map((step) => {
      const b = device.createBuffer({ label: `atrous step ${step}`, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, new Int32Array([step, 0, 0, 0]));
      return b;
    });
  }

  /** The lighting image's size this frame: the internal image over the lighting scale, rounded up. */
  get lightResolution(): [number, number] {
    return this.lightSize(this.res);
  }

  private lightSize(size: readonly [number, number]): [number, number] {
    return [Math.ceil(size[0] / this.lightScale), Math.ceil(size[1] / this.lightScale)];
  }

  get quality(): Quality {
    return { preset: this.preset, dynres: this.dynres !== null, scale: this.scale };
  }

  /**
   * Change the preset (which reallocates the lighting images and starts the
   * histories afresh), turn dynamic resolution on or off (off returns to full
   * scale unless a scale is given), set the scale, or the GPU budget.
   */
  setQuality(q: Partial<Quality> & { budgetMs?: number }): void {
    if (q.budgetMs !== undefined) this.budgetMs = q.budgetMs;
    if (q.dynres !== undefined) {
      this.dynres = q.dynres ? new DynamicResolution(frameBudget(this.timer.enabled, this.budgetMs)) : null;
      if (!q.dynres && q.scale === undefined) this.scale = 1;
    }
    if (q.scale !== undefined) this.scale = Math.min(1, Math.max(0.5, Math.round(q.scale * 32) / 32));
    if (this.dynres) this.dynres.scale = this.scale;
    this.res = scaledSize(this.alloc, this.scale);
    if (q.preset !== undefined && q.preset !== this.preset) {
      this.preset = q.preset;
      this.lightScale = LIGHT_SCALE[q.preset];
      this.allocate();
    }
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
      this.alloc = internalSize(w, h, this.options.megapixels ?? 1.5);
    } else {
      this.alloc = [w, h];
    }
    this.allocate();
  }

  /** (Re)create the internal images at the allocated size, and the bind groups over them. */
  private allocate(): void {
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
    make('beam', 'r32float', [Math.ceil(this.alloc[0] / 8), Math.ceil(this.alloc[1] / 8)]);
    make('gDepth', 'r32float', this.alloc);
    make('gHit', 'rg32uint', this.alloc);
    make('gMotion', 'rgba16float', this.alloc);
    make('colour', 'rgba16float', this.alloc);
    make('taa0', 'rgba16float', this.alloc);
    make('taa1', 'rgba16float', this.alloc);
    make('sharp', 'rgba16float', this.alloc);
    const light = this.lightSize(this.alloc);
    make('lNoisy', 'rgba16float', light);
    make('lSky', 'r32float', light);
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
        beam: group('beam', [view('beam')]),
        primary: group('primary', [view('gDepth'), view('gHit'), view('gMotion'), view('beam')]),
        lighting: group('lighting', [view('gDepth'), view('gHit'), view('lNoisy'), view(`hDepth${cur}`), view(`hHit${cur}`), view('lSky')]),
        temporal: group('temporal', [
          view('lNoisy'), view(`hDepth${cur}`), view(`hHit${cur}`), view(`hHit${prev}`), view(`hColour${prev}`), view(`hMoments${prev}`),
          view(`hColour${cur}`), view(`hMoments${cur}`), view('variance'), view(`hDepth${prev}`), view('lSky'),
        ]),
        atrous1: group('atrous', [view(`hColour${cur}`), view('variance'), view(`hHit${cur}`), view('filteredA'), view('varianceA'), { buffer: this.steps[0] }]),
        atrous2: group('atrous', [view('filteredA'), view('varianceA'), view(`hHit${cur}`), view('filteredB'), view('varianceB'), { buffer: this.steps[1] }]),
        atrous3: group('atrous', [view('filteredB'), view('varianceB'), view(`hHit${cur}`), view('denoised'), view('varianceA'), { buffer: this.steps[2] }]),
        shade: group('shade', [view('gDepth'), view('gHit'), view('colour'), view('denoised'), view(`hHit${cur}`)]),
        taa: group('taa', [view('colour'), view('gMotion'), view(`taa${prev}`), view(`taa${cur}`), this.sampler]),
        cas: group('cas', [view(`taa${cur}`), view('sharp')]),
        present: group('present', [view('sharp'), this.sampler, { buffer: this.presentBuffer }, this.compiled.noise.createView()]),
      };
    });
    this.res = scaledSize(this.alloc, this.scale);
    this.resetNext = true;
    this.prevPose = null;
    this.prevRes = null;
  }

  /** Start every history afresh next frame: the camera jumped, and what it saw before is no guide. */
  resetHistory(): void {
    this.resetNext = true;
  }

  /** A copy of the frame uniform's bytes as the last frame wrote them (see FRAME's layout). */
  frameUniform(): ArrayBuffer {
    return this.writer.buffer.slice(0);
  }

  /** The scene bind group the last frame used, for running a single pass in tests. */
  sceneBindGroup(): GPUBindGroup {
    if (!this.sceneGroup) throw new Error('no frame rendered yet');
    return this.sceneGroup;
  }

  /** A texture by name; a history (hDepth, hHit, hColour, hMoments, taa) is the one the last frame wrote. */
  texture(name: string): GPUTexture {
    const last = (this.frameIndex + 1) & 1;
    const t = this.textures[name] ?? this.textures[`${name}${last}`];
    if (!t) throw new Error(`no texture '${name}'`);
    return t;
  }

  /** Draw one frame from `pose` (metres, degrees) at a time of day (0 dusk, 1 night), at `now` (ms). */
  render(pose: CameraPose, timeOfDay: number, now: number): void {
    const device = this.device;
    const gap = this.lastNow !== null && now - this.lastNow > GAP_MS;
    if (this.dynres) {
      // Each frame the GPU timed, once; without timestamps, the interval since the last frame.
      this.dynres.budget = frameBudget(this.timer.enabled, this.budgetMs);
      if (this.timer.enabled) {
        if (this.timer.samples !== this.timerSamples && this.timer.lastMs !== null) {
          this.timerSamples = this.timer.samples;
          this.dynres.update(this.timer.lastMs);
        }
      } else if (this.lastNow !== null) {
        this.dynres.update(now - this.lastNow);
      }
      this.scale = this.dynres.scale;
    }
    this.lastNow = now;
    this.res = scaledSize(this.alloc, this.scale);
    const reset = this.resetNext || gap;
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
        sky: this.atmosphere.views(),
      });
      this.sceneGeneration = this.world.generation;
    }

    const w = this.writer;
    const j = jitter(this.frameIndex);
    const applied: [number, number] = this.flags & FLAGS.JITTER_OFF ? [0, 0] : j;
    writeWorldInfo(w, this.world);
    writeCamera(w, 'cam', pose, voxel, j);
    writeCamera(w, 'prev', this.prevPose ?? pose, voxel, reset || !this.prevPose ? applied : this.prevJitter);
    w.set('res', this.res);
    w.set('alloc', this.alloc);
    w.set('prevRes', reset || !this.prevRes ? this.res : this.prevRes);
    w.set('lightRes', this.lightResolution);
    w.set('lightScale', this.lightScale);
    w.set('frame', this.frameIndex);
    // A history from before a resize is in textures that no longer exist.
    w.set('flags', this.flags | (reset ? FLAGS.HISTORY_RESET : 0));
    this.resetNext = false;
    w.set('lightCount', this.lightCount);
    w.set('voxel', voxel);
    w.set('timeOfDay', timeOfDay);
    w.set('lightRays', 3);
    const denoise = this.options.denoise ?? { historyMax: 32, sigmaLuma: 4, sigmaPlane: 1 };
    w.set('historyMax', denoise.historyMax);
    w.set('sigmaLuma', denoise.sigmaLuma);
    w.set('sigmaPlane', denoise.sigmaPlane);
    w.set('casSharpness', this.options.sharpness ?? 0.4);
    writeSky(w, this.sky);
    w.set('far', this.far.info);
    const encoder = device.createCommandEncoder({ label: `frame ${this.frameIndex}` });
    // The sky views for this frame's sun and moon (the moon's while its light counts), from the
    // camera's height over the ground (none in a trench).
    const moonDir = this.sky.moonLight.some((c) => c > 0) ? this.sky.moonDir : null;
    this.atmosphere.update(encoder, { sunDir: this.sky.sunDir, moonDir }, pose.position[1] - this.sky.fogBase, this.timer.writes('sky'));
    this.atmosphere.writeTo(w, 'atmosphere');
    device.queue.writeBuffer(this.frameBuffer, 0, w.buffer);

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
    pass('beam', 'beam', [Math.ceil(this.res[0] / 8), Math.ceil(this.res[1] / 8)]);
    pass('primary', 'primary', this.res);
    pass('lighting', 'lighting', light);
    pass('temporal', 'temporal', light);
    pass('atrous1', 'atrous', light);
    pass('atrous2', 'atrous', light);
    pass('atrous3', 'atrous', light);
    pass('shade', 'shade', this.res);
    pass('taa', 'taa', this.res);
    pass('cas', 'cas', this.res);
    if (this.context) {
      const present = new Float32Array([this.res[0], this.res[1], this.alloc[0], this.alloc[1], this.canvasSize[0], this.canvasSize[1], this.sky.exposure, 0]);
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

    this.prevPose = { position: [...pose.position], yaw: pose.yaw, pitch: pose.pitch, fov: pose.fov };
    this.prevJitter = applied;
    this.prevRes = [...this.res];
    this.frameIndex++;
    this.stats = {
      gpuMs: this.timer.gpuMs,
      passes: { ...this.timer.passes },
      res: [...this.res],
      alloc: [...this.alloc],
      canvas: [...this.canvasSize],
      scale: this.scale,
      preset: this.preset,
      dynres: this.dynres !== null,
      reset: reset || (this.flags & FLAGS.HISTORY_RESET) !== 0,
      frame: this.frameIndex,
    };
  }

  private voxelSize(): number {
    return this.plan?.params.voxel ?? 0.1;
  }
}
