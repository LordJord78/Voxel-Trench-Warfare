/**
 * The effects (spec §4): tracers, each shot's flash star and the particles,
 * drawn over the sharpened image before bloom, at the internal resolution, so
 * bloom and the exposure treat them as they treat the world.
 *
 * Two passes. A compute pass lights the billboards that are not emissive —
 * the key through its height map (`keyLit`), the shots' flashes as on a face
 * turned to each, and the rest as the faces near them take it (the denoised
 * light behind them) or, in the open, the sky from all round and their light
 * cell's lights — and gives the emissive their glow, each seen through the
 * haze before it as shade sees the world (froxels.ts `group`). Then one
 * render pass draws billboards and ribbons into `sharp`, each fragment dropped
 * where the G-buffer's depth is nearer, blended premultiplied: light adds,
 * dust covers, and a tracer's light covers what is behind it as much as it
 * shows its colour (effects.wgsl tracerLight), its heads and embers drawn
 * over its ribbons. Neither runs in a frame with nothing to draw, so the
 * standard views are as they were.
 */

import type { Tunables } from '../core/tunables';
import type { LightCells } from './light-cells';
import { moduleSource } from './shaders';
import effectsLightSrc from './shaders/effects-light.wgsl';
import effectsSrc from './shaders/effects.wgsl';

/**
 * A ribbon's floats: tail (3), width (1), head (3), alpha at the tail (1), linear emissive colour (3),
 * alpha at the head (1), metres; then its style (RIBBON_STYLE), and a tracer's core width and glow
 * brightness as shares of its glow's, and how far its core is mixed toward white (0 for a star).
 */
export const RIBBON_FLOATS = 16;
/** A ribbon's look across it (effects.wgsl): a shot's flash star's one soft term, or a tracer's white-hot core in its coloured glow. */
export const RIBBON_STYLE = { star: 0, tracer: 1 } as const;
/**
 * A tracer's head's kind of billboard, after particles.ts's 0 (a lit disc), 1 (emissive) and 2 (a lit
 * square): emissive, and held to the pixels it is drawn over as a tracer's ribbon is (effects.wgsl),
 * no smaller than MIN_HEAD_PX, its light kept, nor wider than its share of a tracer's glow at its
 * widest, narrowed and not brightened; that cap is never under the floor.
 */
export const HEAD_BILLBOARD = 3;
/** A tracer strike's ember: emissive, kept at its hue as a tracer's head is (effects.wgsl keepHue), and held no smaller than MIN_HEAD_PX, its light kept, as a head is; and near the eye no wider than its own cap ([effects.ricochet] ember_max_px), narrowed and not brightened, a cap never under that floor. */
export const EMBER_BILLBOARD = 4;
/** A billboard's floats, as particles.ts writes them. */
const BILLBOARD_FLOATS = 9;
/** A lit billboard (effects-light.wgsl's Lit): centre (3), half its size (1), colour premultiplied (4). */
const LIT_BYTES = 32;
/** effects-light.wgsl's EffectsLight: the count and seven floats. */
const LIGHT_PARAMS_BYTES = 32;
/** effects.wgsl's EffectsDraw: two counts and ten floats, 16 bytes a row. */
const DRAW_PARAMS_BYTES = 48;
/** The particle pool, room for test quads, the battle's allowance (its flares, far shells' flashes and smoke, and fires' flames, embers and smoke), and a head for each tracer drawn. */
export const MAX_BILLBOARDS = 4096 + 64 + 1024 + 2048;
/** Every round in flight a tracer, the battle's nearest, and a few shots' stars. */
export const MAX_RIBBONS = 2048;

export interface EffectsFrame {
  billboards: Float32Array;
  billboardCount: number;
  ribbons: Float32Array;
  ribbonCount: number;
  /** The least a tracer's core is as white as near the eye (0 to 1): by day, white-hot as before. */
  whiteFloor?: number;
  /** The sun's share (0 to 1) of how much a tracer's light covers what is behind it (EffectsLook's tracerCover): none if not given. */
  cover?: number;
  /**
   * The first of the tracers' own billboards (their heads and embers, emissive all after them), drawn
   * after the ribbons: a tracer's light covers what is behind it, and a head is not to be covered by
   * its own ribbon. All the billboards before the ribbons if not given.
   */
  tracerBillboardsFrom?: number;
}

/** The present pass's scale on the sharpened image, as the effects keep the tracers' hue through it: the hour's bias over the exposure, and the image's share beside its bloom. */
export interface EffectsTone {
  bias: number;
  sharpShare: number;
}

/** A light that lives a frame or two, as a shot's flash: added in shade outside the denoiser (Task 6). */
export interface TransientLight {
  position: [number, number, number];
  radiusM: number;
  colour: [number, number, number];
  intensity: number;
}

/** A puff of a shell's smoke in the haze: centre and radius in metres, density per metre at its middle. */
export interface SmokePuff {
  centre: [number, number, number];
  radiusM: number;
  density: number;
}

/**
 * How the billboards are lit: the emissive's glow, and how much of the key's and the sky's light the
 * rest take; the narrowest and the widest a tracer's glow is drawn, in pixels, and the widest its head
 * is (its share of that, as its width is of the glow's) and a strike's ember is ([effects.ricochet]
 * ember_max_px), each across (effects.wgsl never caps either under its MIN_HEAD_PX floor); the
 * distances (m) over which a tracer's core goes from its whiteness near the eye to none; and how much
 * of what is behind it a tracer's light covers where it shows its colour at the tone curve's top while
 * the sun is up ([effects] tracer_cover; the frame's `cover` is its share by the sun). And blood's
 * (particles.ts BLOOD_BILLBOARD): the least light it takes, as a share of what the present pass's
 * exposure shows as 1 through its tone curve (so at dusk and at night it reads dark red, not soot,
 * and lit as dust is above it), and the fewest pixels across it is drawn.
 */
export interface EffectsLook {
  glow: number;
  dustKey: number;
  dustSky: number;
  bloodLightFloor: number;
  bloodMinPx: number;
  tracerGlowMinPx: number;
  tracerGlowMaxPx: number;
  tracerHeadMaxPx: number;
  emberMaxPx: number;
  tracerWhiteNearM: number;
  tracerWhiteFarM: number;
  tracerCover: number;
}

export function effectsLook(tun: Tunables): EffectsLook {
  const glowMaxPx = tun.f('effects.tracer_glow_max_px');
  return {
    glow: tun.f('effects.particle_glow'),
    dustKey: tun.f('effects.dust_key'),
    dustSky: tun.f('effects.dust_sky'),
    bloodLightFloor: tun.f('effects.blood_light_floor'),
    bloodMinPx: tun.f('effects.blood_min_px'),
    tracerGlowMinPx: tun.f('effects.tracer_glow_min_px'),
    tracerGlowMaxPx: glowMaxPx,
    tracerHeadMaxPx: (glowMaxPx * tun.f('effects.tracer_head_m')) / tun.f('effects.tracer_glow_width_m'),
    emberMaxPx: tun.f('effects.ricochet.ember_max_px'),
    tracerWhiteNearM: tun.f('effects.tracer_white_near_m'),
    tracerWhiteFarM: tun.f('effects.tracer_white_far_m'),
    tracerCover: tun.f('effects.tracer_cover'),
  };
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
  private lightGroup: GPUBindGroup | null = null;
  private drawGroup: GPUBindGroup | null = null;
  private target: GPUTextureView | null = null;
  private billboardCount = 0;
  private ribbonCount = 0;
  /** The first of the tracers' own billboards, drawn after the ribbons. */
  private tracerBillboardsFrom = 0;
  /** The draw's parameters (effects.wgsl EffectsDraw), written when the frame is encoded. */
  private readonly draw = new ArrayBuffer(DRAW_PARAMS_BYTES);

  /** Lit over the scene's group, the key light's map's (`keyRead`) and the haze's (`haze`, froxels.ts). */
  static async compile(device: GPUDevice, scene: GPUBindGroupLayout, keyRead: GPUBindGroupLayout, haze: GPUBindGroupLayout): Promise<EffectsPipelines> {
    const C = GPUShaderStage.COMPUTE;
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    // light-cells.wgsl's grid and cells (read and written where they are built), then its own.
    const lightLayout = device.createBindGroupLayout({
      label: 'effects light',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'storage' } },
        { binding: 2, visibility: C, buffer: { type: 'uniform' } },
        { binding: 3, visibility: C, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: C, buffer: { type: 'storage' } },
        { binding: 5, visibility: C, texture: { sampleType: 'unfilterable-float' } },
        { binding: 6, visibility: C, texture: { sampleType: 'unfilterable-float' } },
        // The exposure's state, as a uniform: the stage's storage buffers are all taken.
        { binding: 7, visibility: C, buffer: { type: 'uniform' } },
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
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
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
        layout: device.createPipelineLayout({ bindGroupLayouts: [scene, lightLayout, keyRead, haze] }),
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

  /** Over the frame's uniform, the light cells, the key light's map's group (key-shadow.ts `group`) and the exposure's adaptation (auto-exposure.ts `state`). */
  static create(device: GPUDevice, pipelines: EffectsPipelines, frame: GPUBuffer, cells: LightCells, keyGroup: GPUBindGroup, look: EffectsLook, exposureState: GPUBuffer): Effects {
    return new Effects(device, pipelines, frame, cells, keyGroup, look, exposureState);
  }

  private constructor(
    private readonly device: GPUDevice,
    private readonly pipelines: EffectsPipelines,
    private readonly frame: GPUBuffer,
    private readonly cells: LightCells,
    private readonly keyGroup: GPUBindGroup,
    readonly look: EffectsLook,
    private readonly exposureState: GPUBuffer,
  ) {
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.billboards = device.createBuffer({ label: 'effects billboards', size: MAX_BILLBOARDS * BILLBOARD_FLOATS * 4, usage: storage });
    this.lit = device.createBuffer({ label: 'effects lit', size: MAX_BILLBOARDS * LIT_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.ribbons = device.createBuffer({ label: 'effects ribbons', size: MAX_RIBBONS * RIBBON_FLOATS * 4, usage: storage });
    this.lightParams = device.createBuffer({ label: 'effects light params', size: LIGHT_PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.drawParams = device.createBuffer({ label: 'effects draw params', size: DRAW_PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /**
   * Draw into `target` (sharp, which must allow render attachment), hidden by `gDepth`, lit near the
   * world's faces by `denoised` (shade's light): after each reallocation.
   */
  bind(target: GPUTexture, gDepth: GPUTexture, denoised: GPUTexture): void {
    this.target = target.createView();
    this.lightGroup = this.device.createBindGroup({
      label: 'effects light',
      layout: this.pipelines.lightLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cells.grid } },
        { binding: 1, resource: { buffer: this.cells.cells } },
        { binding: 2, resource: { buffer: this.lightParams } },
        { binding: 3, resource: { buffer: this.billboards } },
        { binding: 4, resource: { buffer: this.lit } },
        { binding: 5, resource: gDepth.createView() },
        { binding: 6, resource: denoised.createView() },
        { binding: 7, resource: { buffer: this.exposureState } },
      ],
    });
    this.drawGroup = this.device.createBindGroup({
      label: 'effects',
      layout: this.pipelines.drawLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frame } },
        { binding: 1, resource: { buffer: this.lit } },
        { binding: 2, resource: { buffer: this.ribbons } },
        { binding: 3, resource: gDepth.createView() },
        { binding: 4, resource: { buffer: this.drawParams } },
        { binding: 5, resource: { buffer: this.exposureState } },
      ],
    });
  }

  /** This frame's billboards and ribbons. */
  set(frame: EffectsFrame): void {
    this.billboardCount = Math.min(frame.billboardCount, MAX_BILLBOARDS);
    this.ribbonCount = Math.min(frame.ribbonCount, MAX_RIBBONS);
    this.tracerBillboardsFrom = Math.max(0, Math.min(frame.tracerBillboardsFrom ?? this.billboardCount, this.billboardCount));
    const queue = this.device.queue;
    if (this.billboardCount > 0) queue.writeBuffer(this.billboards, 0, frame.billboards, 0, this.billboardCount * BILLBOARD_FLOATS);
    if (this.ribbonCount > 0) queue.writeBuffer(this.ribbons, 0, frame.ribbons, 0, this.ribbonCount * RIBBON_FLOATS);
    // effects-light.wgsl's EffectsLight: the count; the glow and the dust's light; blood's floor and
    // its fewest pixels across. The present pass's tone (its bias and the image's share) is encode's.
    const light = new ArrayBuffer(24);
    new Uint32Array(light, 0, 1)[0] = this.billboardCount;
    new Float32Array(light, 4, 5).set([this.look.glow, this.look.dustKey, this.look.dustSky, this.look.bloodLightFloor, this.look.bloodMinPx]);
    queue.writeBuffer(this.lightParams, 0, light);
    // effects.wgsl's EffectsDraw: the counts; the widest a tracer's glow and its head are drawn, and
    // the narrowest its glow is; where its core's whiteness starts to fall and where it is gone; the
    // tone's (encode's), how white a tracer's core is at least, how much its light covers, and the
    // widest a strike's ember is drawn.
    new Uint32Array(this.draw, 0, 2).set([this.billboardCount, this.ribbonCount]);
    new Float32Array(this.draw, 8, 5).set([this.look.tracerGlowMaxPx, this.look.tracerHeadMaxPx, this.look.tracerGlowMinPx, this.look.tracerWhiteNearM, this.look.tracerWhiteFarM]);
    new Float32Array(this.draw, 36, 3).set([frame.whiteFloor ?? 0, this.look.tracerCover * Math.min(1, Math.max(0, frame.cover ?? 0)), this.look.emberMaxPx]);
  }

  /**
   * Light and draw this frame's effects into the image's `res` corner, seen through `haze` (froxels.ts
   * `group`), timing each pass it runs; the tracers lit to keep their hue through the present pass's
   * tone at `tone`.
   */
  encode(encoder: GPUCommandEncoder, scene: GPUBindGroup, haze: GPUBindGroup, res: readonly [number, number], writes: Writes, tone: EffectsTone = { bias: 1, sharpShare: 1 }): void {
    if (!this.target || !this.drawGroup || !this.lightGroup || this.billboardCount + this.ribbonCount === 0) return;
    new Float32Array(this.draw, 28, 2).set([tone.bias, tone.sharpShare]);
    this.device.queue.writeBuffer(this.drawParams, 0, this.draw);
    // Blood's floor is a share of the light the present pass shows as 1: the light pass reckons that
    // scale as the draw does (effects.wgsl presentedScale).
    this.device.queue.writeBuffer(this.lightParams, 24, new Float32Array([tone.bias, tone.sharpShare]));
    if (this.billboardCount > 0) {
      const p = encoder.beginComputePass({ label: 'effects light', timestampWrites: writes('effects-light') });
      p.setPipeline(this.pipelines.light);
      p.setBindGroup(0, scene);
      p.setBindGroup(1, this.lightGroup);
      p.setBindGroup(2, this.keyGroup);
      p.setBindGroup(3, haze);
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
    // The billboards before the tracers' own, then the ribbons, then the tracers' heads and embers over
    // them (the shader tells a billboard from a ribbon by its instance, so each range keeps its own).
    const from = this.tracerBillboardsFrom;
    if (from > 0) p.draw(6, from, 0, 0);
    if (this.ribbonCount > 0) p.draw(6, this.ribbonCount, 0, this.billboardCount);
    if (this.billboardCount > from) p.draw(6, this.billboardCount - from, 0, from);
    p.end();
  }

  /** The last frame's lit billboards `first` to `first + count`: eight floats each, as Lit. */
  async readLit(first: number, count: number): Promise<Float32Array> {
    const n = Math.max(0, Math.min(count, MAX_BILLBOARDS - first));
    const staging = this.device.createBuffer({ size: Math.max(LIT_BYTES, n * LIT_BYTES), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = this.device.createCommandEncoder();
    if (n > 0) encoder.copyBufferToBuffer(this.lit, first * LIT_BYTES, staging, 0, n * LIT_BYTES);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(staging.getMappedRange().slice(0, n * LIT_BYTES));
    staging.destroy();
    return out;
  }

  destroy(): void {
    for (const b of [this.billboards, this.lit, this.ribbons, this.lightParams, this.drawParams]) b.destroy();
  }
}
