/**
 * The effects (spec §4): tracers, each shot's flash star and the particles,
 * drawn over the sharpened image before bloom, at the internal resolution, so
 * bloom and the exposure treat them as they treat the world.
 *
 * Two passes. A compute pass lights the billboards that are not emissive —
 * the key through its height map (`keyLit`) and the sky's irradiance from
 * above, as the world is lit — and gives the emissive their glow. Then one
 * render pass draws billboards and ribbons into `sharp`, each fragment dropped
 * where the G-buffer's depth is nearer, blended premultiplied: light adds,
 * dust covers. Neither runs in a frame with nothing to draw, so the standard
 * views are as they were.
 */

import type { Tunables } from '../core/tunables';
import { moduleSource } from './shaders';
import effectsLightSrc from './shaders/effects-light.wgsl';
import effectsSrc from './shaders/effects.wgsl';

/** A ribbon's floats: tail (3), width (1), head (3), alpha at the tail (1), linear emissive colour (3), alpha at the head (1); metres. */
export const RIBBON_FLOATS = 12;
/** A billboard's floats, as particles.ts writes them. */
const BILLBOARD_FLOATS = 9;
/** The particle pool, and room for test quads. */
export const MAX_BILLBOARDS = 4096 + 64;
/** Every round in flight a tracer, and a few shots' stars. */
export const MAX_RIBBONS = 512;

export interface EffectsFrame {
  billboards: Float32Array;
  billboardCount: number;
  ribbons: Float32Array;
  ribbonCount: number;
}

/** A light that lives a frame or two, as a shot's flash: added in shade outside the denoiser (Task 6). */
export interface TransientLight {
  position: [number, number, number];
  radiusM: number;
  colour: [number, number, number];
  intensity: number;
}

/** How the billboards are lit: the emissive's glow, and how much of the key's and the sky's light the rest take. */
export interface EffectsLook {
  glow: number;
  dustKey: number;
  dustSky: number;
}

export function effectsLook(tun: Tunables): EffectsLook {
  return { glow: tun.f('effects.particle_glow'), dustKey: tun.f('effects.dust_key'), dustSky: tun.f('effects.dust_sky') };
}

export interface EffectsPipelines {
  light: GPUComputePipeline;
  draw: GPURenderPipeline;
  lightLayout: GPUBindGroupLayout;
  drawLayout: GPUBindGroupLayout;
}

type Writes = (name: 'effects-light' | 'effects') => GPUComputePassTimestampWrites | undefined;

export class Effects {
  private readonly billboards: GPUBuffer;
  private readonly lit: GPUBuffer;
  private readonly ribbons: GPUBuffer;
  private readonly lightParams: GPUBuffer;
  private readonly drawParams: GPUBuffer;
  private readonly lightGroup: GPUBindGroup;
  private drawGroup: GPUBindGroup | null = null;
  private target: GPUTextureView | null = null;
  private billboardCount = 0;
  private ribbonCount = 0;

  static async compile(device: GPUDevice, scene: GPUBindGroupLayout, keyRead: GPUBindGroupLayout): Promise<EffectsPipelines> {
    const C = GPUShaderStage.COMPUTE;
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const lightLayout = device.createBindGroupLayout({
      label: 'effects light',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: C, buffer: { type: 'storage' } },
      ],
    });
    const drawLayout = device.createBindGroupLayout({
      label: 'effects',
      entries: [
        { binding: 0, visibility: VF, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 4, visibility: VF, buffer: { type: 'uniform' } },
      ],
    });
    const lightModule = device.createShaderModule({ label: 'effects light', code: moduleSource(effectsLightSrc) });
    const drawModule = device.createShaderModule({ label: 'effects', code: moduleSource(effectsSrc) });
    for (const [name, m] of [['effects-light', lightModule], ['effects', drawModule]] as const) {
      const errors = (await m.getCompilationInfo()).messages.filter((x) => x.type === 'error');
      if (errors.length) throw new Error(`${name}.wgsl: ${errors.map((x) => `${x.lineNum}:${x.linePos} ${x.message}`).join('; ')}`);
    }
    const [light, draw] = await Promise.all([
      device.createComputePipelineAsync({
        label: 'effects light',
        layout: device.createPipelineLayout({ bindGroupLayouts: [scene, lightLayout, keyRead] }),
        compute: { module: lightModule, entryPoint: 'main' },
      }),
      device.createRenderPipelineAsync({
        label: 'effects',
        layout: device.createPipelineLayout({ bindGroupLayouts: [drawLayout] }),
        vertex: { module: drawModule, entryPoint: 'vs' },
        fragment: {
          module: drawModule,
          entryPoint: 'fs',
          targets: [
            {
              format: 'rgba16float',
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              },
            },
          ],
        },
        primitive: { topology: 'triangle-list' },
      }),
    ]);
    return { light, draw, lightLayout, drawLayout };
  }

  /** Over the frame's uniform and the key light's map's group (key-shadow.ts `group`). */
  static create(device: GPUDevice, pipelines: EffectsPipelines, frame: GPUBuffer, keyGroup: GPUBindGroup, look: EffectsLook): Effects {
    return new Effects(device, pipelines, frame, keyGroup, look);
  }

  private constructor(
    private readonly device: GPUDevice,
    private readonly pipelines: EffectsPipelines,
    private readonly frame: GPUBuffer,
    private readonly keyGroup: GPUBindGroup,
    readonly look: EffectsLook,
  ) {
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.billboards = device.createBuffer({ label: 'effects billboards', size: MAX_BILLBOARDS * BILLBOARD_FLOATS * 4, usage: storage });
    this.lit = device.createBuffer({ label: 'effects lit', size: MAX_BILLBOARDS * 32, usage: GPUBufferUsage.STORAGE });
    this.ribbons = device.createBuffer({ label: 'effects ribbons', size: MAX_RIBBONS * RIBBON_FLOATS * 4, usage: storage });
    this.lightParams = device.createBuffer({ label: 'effects light params', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.drawParams = device.createBuffer({ label: 'effects draw params', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.lightGroup = device.createBindGroup({
      label: 'effects light',
      layout: pipelines.lightLayout,
      entries: [
        { binding: 0, resource: { buffer: this.lightParams } },
        { binding: 1, resource: { buffer: this.billboards } },
        { binding: 2, resource: { buffer: this.lit } },
      ],
    });
  }

  /** Draw into `target` (sharp, which must allow render attachment), hidden by `gDepth`: after each reallocation. */
  bind(target: GPUTexture, gDepth: GPUTexture): void {
    this.target = target.createView();
    this.drawGroup = this.device.createBindGroup({
      label: 'effects',
      layout: this.pipelines.drawLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frame } },
        { binding: 1, resource: { buffer: this.lit } },
        { binding: 2, resource: { buffer: this.ribbons } },
        { binding: 3, resource: gDepth.createView() },
        { binding: 4, resource: { buffer: this.drawParams } },
      ],
    });
  }

  /** This frame's billboards and ribbons. */
  set(frame: EffectsFrame): void {
    this.billboardCount = Math.min(frame.billboardCount, MAX_BILLBOARDS);
    this.ribbonCount = Math.min(frame.ribbonCount, MAX_RIBBONS);
    const queue = this.device.queue;
    if (this.billboardCount > 0) queue.writeBuffer(this.billboards, 0, frame.billboards, 0, this.billboardCount * BILLBOARD_FLOATS);
    if (this.ribbonCount > 0) queue.writeBuffer(this.ribbons, 0, frame.ribbons, 0, this.ribbonCount * RIBBON_FLOATS);
    const light = new ArrayBuffer(16);
    new Uint32Array(light, 0, 1)[0] = this.billboardCount;
    new Float32Array(light, 4, 3).set([this.look.glow, this.look.dustKey, this.look.dustSky]);
    queue.writeBuffer(this.lightParams, 0, light);
    queue.writeBuffer(this.drawParams, 0, new Uint32Array([this.billboardCount, this.ribbonCount, 0, 0]));
  }

  /** Light and draw this frame's effects into the image's `res` corner, timing each pass it runs. */
  encode(encoder: GPUCommandEncoder, scene: GPUBindGroup, res: readonly [number, number], writes: Writes): void {
    if (!this.target || !this.drawGroup || this.billboardCount + this.ribbonCount === 0) return;
    if (this.billboardCount > 0) {
      const p = encoder.beginComputePass({ label: 'effects light', timestampWrites: writes('effects-light') });
      p.setPipeline(this.pipelines.light);
      p.setBindGroup(0, scene);
      p.setBindGroup(1, this.lightGroup);
      p.setBindGroup(2, this.keyGroup);
      p.dispatchWorkgroups(Math.ceil(this.billboardCount / 64));
      p.end();
    }
    const p = encoder.beginRenderPass({
      label: 'effects',
      colorAttachments: [{ view: this.target, loadOp: 'load', storeOp: 'store' }],
      timestampWrites: writes('effects'),
    });
    p.setViewport(0, 0, res[0], res[1], 0, 1);
    p.setScissorRect(0, 0, res[0], res[1]);
    p.setPipeline(this.pipelines.draw);
    p.setBindGroup(0, this.drawGroup);
    p.draw(6, this.billboardCount + this.ribbonCount);
    p.end();
  }

  destroy(): void {
    for (const b of [this.billboards, this.lit, this.ribbons, this.lightParams, this.drawParams]) b.destroy();
  }
}
