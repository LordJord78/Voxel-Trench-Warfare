/**
 * The frame: every pass, its textures and bind groups, in order.
 *
 * Compute passes render the internal image:
 *   sky      — the atmosphere's sky views for this frame's sun, moon and camera
 *              height, and the faces' irradiance from them (see atmosphere.ts);
 *              then the exposure reckoned from the light they and the key light
 *              give (exposure.wgsl);
 *   beam     — per 8 × 8 tile, how far its rays can go before meeting anything;
 *   primary  — one jittered ray per pixel into the G-buffer, from its tile's beam;
 *              and in front of them, on a frame whose key or world has moved, the
 *              same dispatch traces a sixteenth of the key light's height map,
 *              seen from the light (key-shadow.ts);
 *   cells    — the frame's point lights gridded over the map, the nearest 32 a
 *              cell (light-cells.ts);
 *   restir   — the point light each lighting pixel shades by, resampled from
 *              its cell's and carried from frame to frame (restir.ts);
 *   spatial  — shared between neighbours on the same plane;
 *   lighting — the light reaching one pixel of each 2 × 2 block (the sky's
 *              ray in half of them, by turns, each frame), with one shadow ray
 *              to its chosen point light;
 *   temporal — that light blended into its reprojected history;
 *   atrous   — three edge-stopping filter passes over it, for display (the
 *              history keeps the plain average, so converged edges stay put);
 *   froxels  — the haze over the view out to 120 m, lit by the key light as far
 *              as its height map lets it and by the point lights, then added up
 *              front to back (froxels.ts);
 *   shade    — the image: upsampled light, materials, water, far field,
 *              sky, seen through the froxels' haze and the height fog past it;
 *   taa      — blended into its own reprojected history, which smooths the
 *              jitter into anti-aliased edges;
 *   cas      — sharpened back;
 *   bloom    — a pyramid of six levels over that, their mean (bloom.ts);
 *   expose   — the frame metered under the reckoned exposure, which is corrected
 *              where the view leaves the norm (auto-exposure.ts).
 * A render pass presents it to the canvas: upscaled, its bloom mixed in, tonemapped, dithered. Pipelines compile in parallel and
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
import { AutoExposure, type AutoExposurePipelines, type ExposureState } from './auto-exposure';
import { Bloom, type BloomPipelines } from './bloom';
import { copyPose, jitter, type CameraPose } from './camera';
import type { Gpu } from './device';
import { DynamicResolution } from './dynres';
import { Effects, effectsLook, type EffectsFrame, type EffectsPipelines } from './effects';
import { FarFieldGpu } from './farfield-gpu';
import { FlareShadows } from './flare-shadows';
import { froxelLayouts, Froxels, type FroxelPipelines } from './froxels';
import { FLAGS, FRAME, PROBE_DUSK, writeCamera, writeSky, writeWorldInfo, type FrameSky } from './frame-uniforms';
import type { GpuWorld } from './gpu-world';
import { StructWriter } from './layout';
import { KeyShadow, keyShadowLayouts, type Key, type KeyShadowPipelines } from './key-shadow';
import { cellGrid, LightCells } from './light-cells';
import { lightBuffer, type SceneLight } from './lights';
import { Restir, type RestirPipelines } from './restir';
import { FROXEL_COLUMNS, LIGHT_SCALE, scaledSize, SKY_VIEW_SIZE, type Preset, type RenderSettings } from './quality';
import { sceneExtras, sceneGroup, sceneLayout, type SkyLuts } from './scene';
import { moduleSource } from './shaders';
import atrousSrc from './shaders/atrous.wgsl';
import beamSrc from './shaders/beam.wgsl';
import casSrc from './shaders/cas.wgsl';
import exposureSrc from './shaders/exposure.wgsl';
import lightingSrc from './shaders/lighting.wgsl';
import presentSrc from './shaders/present.wgsl';
import primarySrc from './shaders/primary.wgsl';
import shadeSrc from './shaders/shade.wgsl';
import taaSrc from './shaders/taa.wgsl';
import temporalSrc from './shaders/temporal.wgsl';
import { frameBudget, GpuTimer } from './timing';

const PASSES = ['sky', 'beam', 'maps', 'primary', 'cells', 'restir', 'spatial', 'lighting', 'temporal', 'atrous1', 'atrous2', 'atrous3', 'froxels', 'shade', 'taa', 'cas', 'effects-light', 'effects', 'bloom', 'expose', 'present'] as const;
type ComputePass = 'beam' | 'primary' | 'lighting' | 'temporal' | 'atrous' | 'shade' | 'taa' | 'cas' | 'exposure';
type Timed = (typeof PASSES)[number];

/** A gap between frames longer than this (a hidden tab, a debugger) leaves histories too stale to blend. */
const GAP_MS = 500;

export interface RenderStats {
  gpuMs: number | null;
  /** Each pass's share of the frame, and its own time (timing.ts's passTimes), smoothed. */
  passes: Record<string, number>;
  own: Record<string, number>;
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

async function compute(device: GPUDevice, label: string, source: string, layouts: GPUBindGroupLayout[], entryPoint = 'main'): Promise<GPUComputePipeline> {
  const module = device.createShaderModule({ label, code: moduleSource(source) });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length) throw new Error(`${label}.wgsl: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`);
  return device.createComputePipelineAsync({
    label,
    layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
    compute: { module, entryPoint },
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
  /** And primary's `keyed`, for frames that trace texels of the key light's height map in front of the pixels. */
  pipelines: Record<ComputePass, GPUComputePipeline> & { present: GPURenderPipeline; primaryKeyed: GPUComputePipeline };
  atmosphere: AtmospherePipelines;
  bloom: BloomPipelines;
  autoExposure: AutoExposurePipelines;
  cells: GPUComputePipeline;
  restir: RestirPipelines;
  keyShadow: KeyShadowPipelines;
  froxels: FroxelPipelines;
  effects: EffectsPipelines;
  lights: GPUBuffer;
  noise: GPUTexture;
  /** Empty sky LUTs, for scenes built without an atmosphere. */
  sky: SkyLuts;
}

/** Compile the frame's pipelines, in parallel. Needs only the device, so it can run while the world generates. */
export async function compileFrame(device: GPUDevice): Promise<CompiledFrame> {
  const scene = sceneLayout(device);
  const keyLayouts = keyShadowLayouts(device);
  const froxelLayout = froxelLayouts(device);
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
        // This frame's reservoirs (restir.ts).
        { binding: 6, visibility: STAGE(), buffer: { type: 'read-only-storage' } },
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
      entries: [sampled(0, 'float'), sampled(1, 'unfilterable-float'), sampled(2, 'uint'), storageTexture(3, 'rgba16float'), storageTexture(4, 'rg32float'), uniform(5), sampled(6, 'unfilterable-float')],
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
    // The adaptation's state, which the reckoned exposure is written into.
    exposure: device.createBindGroupLayout({
      label: 'exposure',
      entries: [{ binding: 0, visibility: STAGE(), buffer: { type: 'storage' } }],
    }),
    present: device.createBindGroupLayout({
      label: 'present',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'uint' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    }),
  };
  const presentModule = device.createShaderModule({ label: 'present', code: presentSrc });
  const [beam, primary, primaryKeyed, lighting, temporal, atrous, shade, taa, cas, exposure, present, atmosphere, bloom, autoExposure, cells, restir, keyShadow, froxels, effects] = await Promise.all([
    compute(device, 'beam', beamSrc, [scene, layouts.beam]),
    compute(device, 'primary', primarySrc, [scene, layouts.primary]),
    compute(device, 'primary keyed', primarySrc, [scene, layouts.primary, keyLayouts.write], 'keyed'),
    compute(device, 'lighting', lightingSrc, [scene, layouts.lighting]),
    compute(device, 'temporal', temporalSrc, [scene, layouts.temporal]),
    compute(device, 'atrous', atrousSrc, [scene, layouts.atrous]),
    compute(device, 'shade', shadeSrc, [scene, layouts.shade, froxelLayout.none, froxelLayout.haze]),
    compute(device, 'taa', taaSrc, [scene, layouts.taa]),
    compute(device, 'cas', casSrc, [scene, layouts.cas]),
    compute(device, 'exposure', exposureSrc, [scene, layouts.exposure]),
    device.createRenderPipelineAsync({
      label: 'present',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.present] }),
      vertex: { module: presentModule, entryPoint: 'vs' },
      fragment: { module: presentModule, entryPoint: 'fs', targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }] },
      primitive: { topology: 'triangle-list' },
    }),
    Atmosphere.compile(device),
    Bloom.compile(device),
    AutoExposure.compile(device),
    LightCells.compile(device),
    Restir.compile(device),
    KeyShadow.compile(device, scene, keyLayouts),
    Froxels.compile(device, scene, keyLayouts, froxelLayout),
    Effects.compile(device, scene, keyLayouts.read),
  ]);
  return { scene, layouts, pipelines: { beam, primary, primaryKeyed, lighting, temporal, atrous, shade, taa, cas, exposure, present }, atmosphere, bloom, autoExposure, cells, restir, keyShadow, froxels, effects, ...sceneExtras(device) };
}

export class Renderer {
  readonly device: GPUDevice;
  readonly world: GpuWorld;
  readonly plan: WorldPlan | null;
  /** Extra frame flags (see FLAGS), for tests and debugging. */
  flags = 0;
  /** What the frame is lit by. */
  sky: FrameSky = PROBE_DUSK;
  stats: RenderStats = { gpuMs: null, passes: {}, own: {}, res: [0, 0], alloc: [0, 0], canvas: [0, 0], scale: 1, preset: 'high', dynres: false, reset: false, frame: 0 };

  private readonly canvas: HTMLCanvasElement | null;
  private readonly context: GPUCanvasContext | null;
  private readonly format: GPUTextureFormat;
  private readonly options: RendererOptions;
  private readonly timer: GpuTimer;
  private readonly writer = new StructWriter(FRAME);
  private readonly frameBuffer: GPUBuffer;
  private readonly presentBuffer: GPUBuffer;
  private readonly exposureGroup: GPUBindGroup;
  private readonly compiled: CompiledFrame;
  private readonly sampler: GPUSampler;
  private readonly far: FarFieldGpu;
  /** The sky's LUTs and the faces' irradiance, built each frame for the frame's sky. */
  readonly atmosphere: Atmosphere;
  private readonly bloom: Bloom;
  private readonly autoExposure: AutoExposure;
  /** The frame's lights gridded over the map, and each lighting pixel's light drawn from them. */
  private readonly cells: LightCells;
  private readonly restir: Restir;
  /** Where the key light is blocked, seen from its side, and the flares' light, seen from theirs; and the haze they shine through. */
  private readonly flareShadows: FlareShadows;
  private readonly keyShadow: KeyShadow;
  private readonly froxels: Froxels;
  /** Tracers, the flash's star and the particles, over the sharpened image. */
  private readonly effects: Effects;
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
    // The present pass's uniform: the image's sizes, the exposure, the bloom's weight, the grain (12 floats).
    this.presentBuffer = device.createBuffer({
      label: 'present',
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.autoExposure = AutoExposure.create(device, compiled.autoExposure, this.presentBuffer);
    this.exposureGroup = device.createBindGroup({ label: 'exposure', layout: compiled.layouts.exposure, entries: [{ binding: 0, resource: { buffer: this.autoExposure.state } }] });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.far = options.far ?? FarFieldGpu.empty(device);
    this.preset = options.preset ?? 'high';
    this.atmosphere = Atmosphere.create(device, compiled.atmosphere, options.atmosphere ?? atmosphereModel(loadTunables()));
    this.atmosphere.resizeSkyView(SKY_VIEW_SIZE[this.preset]);
    this.bloom = Bloom.create(device, compiled.bloom);
    this.cells = LightCells.create(device, compiled.cells, compiled.lights, cellGrid(world.map.dims, this.voxelSize()), this.voxelSize());
    this.restir = Restir.create(device, compiled.restir, this.frameBuffer, compiled.lights, this.cells);
    this.flareShadows = FlareShadows.create(device);
    this.keyShadow = KeyShadow.create(device, compiled.keyShadow, world.map.dims, this.voxelSize(), this.flareShadows);
    this.froxels = Froxels.create(device, compiled.froxels, this.cells, this.keyShadow, FROXEL_COLUMNS[this.preset]);
    this.effects = Effects.create(device, compiled.effects, this.frameBuffer, this.keyShadow.group, effectsLook(loadTunables()));
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
      // The preset's froxel grid and sky view: new textures, so the scene group is built again.
      this.froxels.resize(FROXEL_COLUMNS[q.preset]);
      this.atmosphere.resizeSkyView(SKY_VIEW_SIZE[q.preset]);
      this.sceneGroup = null;
      this.allocate();
    }
  }

  /** The point lights, with flares burning at `flares` (0 to 1) of their strength. */
  setLights(lights: readonly SceneLight[], flares: number): void {
    this.device.queue.writeBuffer(this.compiled.lights, 0, lightBuffer(lights, flares, this.voxelSize()));
    this.lightCount = lights.length;
    this.flareShadows.setFlares(lights, flares, this.voxelSize());
  }

  /** This frame's tracers, flash stars and particles (effects.ts). */
  setEffects(frame: EffectsFrame): void {
    this.effects.set(frame);
  }

  /** The G-buffer's depth the last frame left at pixels of the internal image, in metres along each pixel's ray. */
  async readDepth(points: readonly [number, number][]): Promise<number[]> {
    const staging = this.device.createBuffer({ size: Math.max(1, points.length) * 256, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = this.device.createCommandEncoder();
    points.forEach(([x, y], i) => {
      encoder.copyTextureToBuffer({ texture: this.textures.gDepth, origin: { x, y } }, { buffer: staging, offset: i * 256, bytesPerRow: 256 }, { width: 1, height: 1 });
    });
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const data = new Float32Array(staging.getMappedRange().slice(0));
    staging.destroy();
    return points.map((_, i) => data[i * 64] * this.voxelSize());
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
    const make = (name: string, format: GPUTextureFormat, size: [number, number], more = 0) => {
      this.textures[name] = this.device.createTexture({
        label: name,
        size,
        format,
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | more,
      });
    };
    make('beam', 'r32float', [Math.ceil(this.alloc[0] / 8), Math.ceil(this.alloc[1] / 8)]);
    make('gDepth', 'r32float', this.alloc);
    make('gHit', 'rg32uint', this.alloc);
    make('gMotion', 'rgba16float', this.alloc);
    make('colour', 'rgba16float', this.alloc);
    make('taa0', 'rgba16float', this.alloc);
    make('taa1', 'rgba16float', this.alloc);
    // The effects are drawn into it, by a render pass.
    make('sharp', 'rgba16float', this.alloc, GPUTextureUsage.RENDER_ATTACHMENT);
    this.effects.bind(this.textures.sharp, this.textures.gDepth);
    this.bloom.resize(this.alloc, this.textures.sharp.createView());
    this.autoExposure.bind(this.textures.sharp.createView());
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
    this.restir.resize(light, { gDepth: view('gDepth'), gHit: view('gHit'), hDepth: [view('hDepth0'), view('hDepth1')], hHit: [view('hHit0'), view('hHit1')] });
    const group = (pass: ComputePass | 'present', resources: GPUBindingResource[]) =>
      this.device.createBindGroup({ label: pass, layout: this.compiled.layouts[pass], entries: resources.map((resource, binding) => ({ binding, resource })) });
    this.groups = [0, 1].map((cur) => {
      const prev = 1 - cur;
      return {
        beam: group('beam', [view('beam')]),
        primary: group('primary', [view('gDepth'), view('gHit'), view('gMotion'), view('beam')]),
        lighting: group('lighting', [view('gDepth'), view('gHit'), view('lNoisy'), view(`hDepth${cur}`), view(`hHit${cur}`), view('lSky'), { buffer: this.restir.shaded }]),
        temporal: group('temporal', [
          view('lNoisy'), view(`hDepth${cur}`), view(`hHit${cur}`), view(`hHit${prev}`), view(`hColour${prev}`), view(`hMoments${prev}`),
          view(`hColour${cur}`), view(`hMoments${cur}`), view('variance'), view(`hDepth${prev}`), view('lSky'),
        ]),
        atrous1: group('atrous', [view(`hColour${cur}`), view('variance'), view(`hHit${cur}`), view('filteredA'), view('varianceA'), { buffer: this.steps[0] }, view(`hDepth${cur}`)]),
        atrous2: group('atrous', [view('filteredA'), view('varianceA'), view(`hHit${cur}`), view('filteredB'), view('varianceB'), { buffer: this.steps[1] }, view(`hDepth${cur}`)]),
        atrous3: group('atrous', [view('filteredB'), view('varianceB'), view(`hHit${cur}`), view('denoised'), view('varianceA'), { buffer: this.steps[2] }, view(`hDepth${cur}`)]),
        shade: group('shade', [view('gDepth'), view('gHit'), view('colour'), view('denoised'), view(`hHit${cur}`)]),
        taa: group('taa', [view('colour'), view('gMotion'), view(`taa${prev}`), view(`taa${cur}`), this.sampler]),
        cas: group('cas', [view(`taa${cur}`), view('sharp')]),
        present: group('present', [view('sharp'), this.sampler, { buffer: this.presentBuffer }, this.compiled.noise.createView(), this.bloom.output.createView()]),
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

  /** The reservoirs the last frame shaded by (restir.ts), in rows of `lightStride`. */
  reservoirs(): GPUBuffer {
    return this.restir.shaded;
  }

  /** The reservoirs' row stride, in reservoirs. */
  get lightStride(): number {
    return this.restir.rowStride;
  }

  /** A texture by name; a history (hDepth, hHit, hColour, hMoments, taa) is the one the last frame wrote. */
  texture(name: string): GPUTexture {
    // The bloom's top, half the image's size; the key light's height map; the haze, a 3D texture.
    if (name === 'bloom0') return this.bloom.output;
    if (name === 'keyShadow') return this.keyShadow.map;
    if (name === 'froxels') return this.froxels.haze;
    const last = (this.frameIndex + 1) & 1;
    const t = this.textures[name] ?? this.textures[`${name}${last}`];
    if (!t) throw new Error(`no texture '${name}'`);
    return t;
  }

  /** Draw one frame from `pose` (metres, degrees) at a time of day (0 dusk, 1 night), at `now` (ms). */
  render(pose: CameraPose, timeOfDay: number, now: number): void {
    const device = this.device;
    const gap = this.lastNow !== null && now - this.lastNow > GAP_MS;
    // Real seconds since the last frame, for the exposure's adaptation (a stall counts as a tenth).
    const dt = this.lastNow === null ? 1 / 60 : Math.min(0.1, Math.max(0, (now - this.lastNow) / 1000));
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
    // An edit uploaded changes what the key light's height map saw.
    if (this.world.flush(this.options.uploadBudget ?? 1 << 20, eye) > 0) {
      this.keyShadow.worldChanged();
      this.flareShadows.worldChanged();
    }
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
    // The low preset drops ReSTIR's spatial reuse.
    w.set('flags', this.flags | (reset ? FLAGS.HISTORY_RESET : 0) | (this.preset === 'low' ? FLAGS.SPATIAL_OFF : 0));
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
    // The exposure, from the light the sky views and the key give: into the present pass's uniform.
    const exposure = encoder.beginComputePass({ label: 'exposure' });
    exposure.setPipeline(this.compiled.pipelines.exposure);
    exposure.setBindGroup(0, this.sceneGroup!);
    exposure.setBindGroup(1, this.exposureGroup);
    exposure.dispatchWorkgroups(1);
    exposure.end();

    const groups = this.groups[this.frameIndex & 1];
    const pass = (name: Timed & keyof typeof groups, pipeline: ComputePass, size: readonly [number, number], more: GPUBindGroup[] = []) => {
      const p = encoder.beginComputePass({ label: name, timestampWrites: this.timer.writes(name) });
      p.setPipeline(this.compiled.pipelines[pipeline]);
      p.setBindGroup(0, this.sceneGroup!);
      p.setBindGroup(1, groups[name]!);
      more.forEach((g, k) => p.setBindGroup(2 + k, g));
      p.dispatchWorkgroups(Math.ceil(size[0] / 8), Math.ceil(size[1] / 8));
      p.end();
    };
    const light = this.lightResolution;
    pass('beam', 'beam', [Math.ceil(this.res[0] / 8), Math.ceil(this.res[1] / 8)]);
    // The pixels' rays, with this frame's texels of the key light's height map in front of them
    // (if any: none while the key and the world stand still). The key is the sun while it gives the
    // light (sky-state.ts), and the moon after.
    const key: Key = this.sky.keyDir.every((c, k) => c === this.sky.sunDir[k]) ? 'sun' : 'moon';
    const across = Math.ceil(this.res[0] / 8);
    const keyRows = this.keyShadow.share([this.sky.keyDir[0], this.sky.keyDir[1], this.sky.keyDir[2]], key, across, this.flareShadows.next());
    // The flares' texels, if the key has none to share them with. (Timed only when it runs: a slot
    // not written this frame would hold another frame's times.)
    if (this.keyShadow.alone) this.keyShadow.traceAlone(encoder, this.sceneGroup!, this.timer.writes('maps'));
    if (keyRows > 0) {
      const primary = encoder.beginComputePass({ label: 'primary', timestampWrites: this.timer.writes('primary') });
      primary.setPipeline(this.compiled.pipelines.primaryKeyed);
      primary.setBindGroup(0, this.sceneGroup!);
      primary.setBindGroup(1, groups.primary!);
      primary.setBindGroup(2, this.keyShadow.buildGroup);
      primary.dispatchWorkgroups(across, Math.ceil(this.res[1] / 8) + keyRows);
      primary.end();
    } else {
      pass('primary', 'primary', this.res);
    }
    this.cells.encode(encoder, this.lightCount, this.timer.writes('cells'));
    this.restir.encode(encoder, this.frameIndex & 1, light, { candidates: this.timer.writes('restir'), spatial: this.timer.writes('spatial') });
    pass('lighting', 'lighting', light);
    pass('temporal', 'temporal', light);
    pass('atrous1', 'atrous', light);
    pass('atrous2', 'atrous', light);
    pass('atrous3', 'atrous', light);
    this.froxels.encode(encoder, this.sceneGroup!, this.frameIndex & 1, this.timer.writes('froxels'));
    pass('shade', 'shade', this.res, [this.froxels.none, this.froxels.group]);
    pass('taa', 'taa', this.res);
    pass('cas', 'cas', this.res);
    // Timed only when they run (a slot not written this frame would hold another frame's times).
    this.effects.encode(encoder, this.sceneGroup!, this.res, (name) => this.timer.writes(name));
    this.bloom.encode(encoder, this.res, this.options.bloomMax ?? 999, this.timer.writes('bloom'));
    // Without settings (tests), the zone is wide enough that nothing is ever corrected.
    this.autoExposure.encode(
      encoder,
      this.res,
      {
        dt,
        bias: this.sky.exposure,
        target: this.options.exposureTarget ?? 0,
        zone: this.options.exposureZone ?? 1e9,
        rise: this.options.adaptToDarker ?? 1,
        fall: this.options.adaptToBrighter ?? 3,
        reset,
      },
      this.timer.writes('expose'),
    );
    if (this.context) {
      const bloomWeight = this.options.bloomWeight ?? 0.04;
      // The grain's shift into the 64 × 64 noise tile: an R2 sequence, so each frame's grain is unlike the last's.
      const shift = [0.7548776662466927, 0.5698402909980532].map((a) => Math.floor(((0.5 + this.frameIndex * a) % 1) * 64));
      const present = new Float32Array([this.res[0], this.res[1], this.alloc[0], this.alloc[1], this.canvasSize[0], this.canvasSize[1], this.sky.exposure, bloomWeight, this.sky.grain, shift[0], shift[1], 0]);
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
    this.restir.keep(encoder, this.compiled.lights);
    this.timer.resolve(encoder);
    device.queue.submit([encoder.finish()]);
    this.timer.collect();

    this.prevPose = copyPose(pose);
    this.prevJitter = applied;
    this.prevRes = [...this.res];
    this.frameIndex++;
    this.stats = {
      gpuMs: this.timer.gpuMs,
      passes: { ...this.timer.passes },
      own: { ...this.timer.own },
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

  /** The exposure's adaptation after the last frame: the base reckoned from the light, the correction and its want, the metered mean (stops). */
  exposureState(): Promise<ExposureState> {
    return this.autoExposure.read();
  }

  /** The exposure the last frame was presented at, read back from the GPU. */
  async exposure(): Promise<number> {
    const staging = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.presentBuffer, 0, staging, 0, 32);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const value = new Float32Array(staging.getMappedRange())[6];
    staging.destroy();
    return value;
  }

  private voxelSize(): number {
    return this.plan?.params.voxel ?? 0.1;
  }
}
