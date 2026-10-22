/**
 * The key light's height map (key-shadow.wgsl): seen from the light, on a plane square to it
 * through the map's middle, how far along the light a ray from past the map runs before the voxel
 * world blocks it. Whatever asks keyLit learns whether the key light reaches a point: the froxels
 * do, and that is what draws the shafts.
 *
 * Its texels are a quarter metre, or as much more as it takes to cover the map from any side (its
 * diagonal), 2 m at most: so its coverage holds as the key turns, and only its plane turns. A
 * sixteenth of them is traced a frame, in tiles of 8 × 8 (neighbouring rays read the same bricks),
 * a tile of every 4 × 4 block of tiles in turn, each under the key as it then was; all of them at
 * once when the key changes between sun and moon, or has turned more than a degree since a texel
 * was traced (the clock was set).
 *
 * Few of a frame's rays reach the world, and each waits on memory at every step: in a pass of its
 * own the longest would take the time. So the frame traces them in front of its primary rays, in
 * the same dispatch (share); update traces them in a pass of their own.
 */

import { moduleSource } from './shaders';
import shadowSrc from './shaders/key-shadow.wgsl';

export type Vec3 = readonly [number, number, number];
export type Key = 'sun' | 'moon';

/** Texels each way (key-shadow.wgsl's KEY_MAP_SIZE). */
export const KEY_MAP_SIZE = 1024;
/** Frames the map is traced over. */
export const KEY_SLOTS = 16;
const TEXEL_MIN_M = 0.25;
const TEXEL_MAX_M = 2;
/** A turn of the key since a texel was traced past which the whole map is traced again. */
const TURN_MAX = Math.cos((1 * Math.PI) / 180);

/** The map's plane and texels (key-shadow.wgsl's KeyShadowInfo), in voxels. */
export interface KeyShadowInfo {
  /** Across the light, level; across it, square to u; and the way the light runs (away from it). */
  u: Vec3;
  v: Vec3;
  along: Vec3;
  /** The map's middle: the plane through it is the map's, and depths count from it. */
  origin: Vec3;
  texel: number;
  /** How far before the plane the rays start: past the map's farthest corner. */
  reach: number;
}

/** The map's plane and texels over a world `dims` voxels in size, at `voxel` metres a voxel, for a key toward `keyDir`. */
export function keyShadowInfo(dims: { x: number; y: number; z: number }, voxel: number, keyDir: Vec3): KeyShadowInfo {
  const length = Math.hypot(keyDir[0], keyDir[1], keyDir[2]);
  const l = [keyDir[0] / length, keyDir[1] / length, keyDir[2] / length];
  const flat = Math.hypot(l[0], l[2]);
  const u: Vec3 = flat > 1e-6 ? [l[2] / flat, 0, -l[0] / flat] : [1, 0, 0];
  const v: Vec3 = [l[1] * u[2] - l[2] * u[1], l[2] * u[0] - l[0] * u[2], l[0] * u[1] - l[1] * u[0]];
  const reach = Math.hypot(dims.x, dims.y, dims.z) / 2 + 1;
  const texel = Math.min(TEXEL_MAX_M / voxel, Math.max(TEXEL_MIN_M / voxel, (2 * reach) / KEY_MAP_SIZE));
  return { u, v, along: [-l[0], -l[1], -l[2]], origin: [dims.x / 2, dims.y / 2, dims.z / 2], texel, reach };
}

/** The tile of each 4 × 4 block of tiles traced on the k-th frame: in a Bayer matrix's order, so each frame's lie apart. */
const SLOTS: [number, number][] = [
  [0, 0], [2, 2], [2, 0], [0, 2], [1, 1], [3, 3], [3, 1], [1, 3],
  [1, 0], [3, 2], [3, 0], [1, 2], [0, 1], [2, 3], [2, 1], [0, 3],
];

export function keySlot(k: number): [number, number] {
  const [x, y] = SLOTS[((k % KEY_SLOTS) + KEY_SLOTS) % KEY_SLOTS];
  return [x, y];
}

export interface KeyShadowLayouts {
  /** Group 2 of a pass that asks keyLit: the map's plane and texels, and the map. */
  read: GPUBindGroupLayout;
  /** Group 2 of a pass that traces the map's texels: the plane, the map to write, which texels. */
  write: GPUBindGroupLayout;
  none: GPUBindGroupLayout;
}

export function keyShadowLayouts(device: GPUDevice): KeyShadowLayouts {
  const uniform = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } });
  return {
    read: device.createBindGroupLayout({
      label: 'key shadow',
      entries: [uniform(0), { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } }],
    }),
    write: device.createBindGroupLayout({
      label: 'key shadow build',
      entries: [uniform(0), { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r32float' } }, uniform(3)],
    }),
    none: device.createBindGroupLayout({ label: 'key shadow none', entries: [] }),
  };
}

export interface KeyShadowPipelines extends KeyShadowLayouts {
  build: GPUComputePipeline;
}

/** The tiles a frame traces: every `step`th each way from `offset`; `count` texels in all. */
interface Texels {
  step: number;
  offset: [number, number];
  count: number;
}

export class KeyShadow {
  /** Each texel's depth along the light from the plane through the map's middle (voxels); 1e9 where nothing blocks its ray. */
  readonly map: GPUTexture;
  /** The map's plane and texels as keyLit reads them, written each update. */
  readonly info: GPUBuffer;
  /** Group 2 for a pass that asks keyLit. */
  readonly group: GPUBindGroup;
  /** Group 2 for a pass that traces the map's texels (share). */
  readonly buildGroup: GPUBindGroup;
  private readonly device: GPUDevice;
  private readonly pipelines: KeyShadowPipelines;
  private readonly dims: { x: number; y: number; z: number };
  private readonly voxel: number;
  /** Which texels a build traces, and where in a shared dispatch. */
  private readonly params: GPUBuffer;
  private readonly none: GPUBindGroup;
  private key: Key | null = null;
  /** The key each frame's texels were last traced under. */
  private readonly traced: Vec3[] = [];
  private count = 0;

  /** The build's own pipeline, over the scene's group 0 (`scene`, scene.ts), with the map's groups' layouts. */
  static async compile(device: GPUDevice, scene: GPUBindGroupLayout, layouts: KeyShadowLayouts = keyShadowLayouts(device)): Promise<KeyShadowPipelines> {
    const module = device.createShaderModule({ label: 'key shadow', code: moduleSource(shadowSrc) });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length) throw new Error(`key-shadow.wgsl: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`);
    const build = await device.createComputePipelineAsync({
      label: 'key shadow',
      layout: device.createPipelineLayout({ bindGroupLayouts: [scene, layouts.none, layouts.write] }),
      compute: { module, entryPoint: 'buildMap' },
    });
    return { ...layouts, build };
  }

  /** The map over a world `dims` voxels in size, at `voxel` metres a voxel. */
  static create(device: GPUDevice, pipelines: KeyShadowPipelines, dims: { x: number; y: number; z: number }, voxel: number): KeyShadow {
    return new KeyShadow(device, pipelines, dims, voxel);
  }

  private constructor(device: GPUDevice, pipelines: KeyShadowPipelines, dims: { x: number; y: number; z: number }, voxel: number) {
    this.device = device;
    this.pipelines = pipelines;
    this.dims = { x: dims.x, y: dims.y, z: dims.z };
    this.voxel = voxel;
    this.map = device.createTexture({
      label: 'key shadow',
      size: [KEY_MAP_SIZE, KEY_MAP_SIZE],
      format: 'r32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    this.info = device.createBuffer({ label: 'key shadow', size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.params = device.createBuffer({ label: 'key shadow build', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const view = this.map.createView();
    this.group = device.createBindGroup({
      label: 'key shadow',
      layout: pipelines.read,
      entries: [
        { binding: 0, resource: { buffer: this.info } },
        { binding: 1, resource: view },
      ],
    });
    this.buildGroup = device.createBindGroup({
      label: 'key shadow build',
      layout: pipelines.write,
      entries: [
        { binding: 0, resource: { buffer: this.info } },
        { binding: 2, resource: view },
        { binding: 3, resource: { buffer: this.params } },
      ],
    });
    this.none = device.createBindGroup({ label: 'key shadow none', layout: pipelines.none, entries: [] });
  }

  /**
   * Trace this frame's sixteenth of the map for a key toward `keyDir`, through the world in the
   * scene's group 0 (`scene`), in a pass of its own; or all of it, on a change between sun and moon
   * or a turn over a degree. It writes the map's plane for this key, which keyLit reads: submit
   * before the next update.
   */
  update(encoder: GPUCommandEncoder, scene: GPUBindGroup, keyDir: Vec3, key: Key, timestampWrites?: GPUComputePassTimestampWrites): void {
    const texels = this.next(keyDir, key);
    this.place(texels, 0, 0);
    const pass = encoder.beginComputePass({ label: 'key shadow', timestampWrites });
    pass.setPipeline(this.pipelines.build);
    pass.setBindGroup(0, scene);
    pass.setBindGroup(1, this.none);
    pass.setBindGroup(2, this.buildGroup);
    pass.dispatchWorkgroups(texels.count / 64);
    pass.end();
  }

  /**
   * As update, but for another pass to trace in front of its own work: one whose dispatch is
   * `width` workgroups of 64 across, with the rows this returns put first; which binds buildGroup
   * as its group 2 and asks keyShare (key-shadow.wgsl) at each workgroup, as primary.wgsl does.
   */
  share(keyDir: Vec3, key: Key, width: number): number {
    const texels = this.next(keyDir, key);
    const rows = Math.ceil(texels.count / 64 / width);
    this.place(texels, rows, width);
    return rows;
  }

  /** This frame's texels for a key toward `keyDir`, and the map's plane for it written. */
  private next(keyDir: Vec3, key: Key): Texels {
    const info = keyShadowInfo(this.dims, this.voxel, keyDir);
    const toward: Vec3 = [-info.along[0], -info.along[1], -info.along[2]];
    const dot = (a: Vec3) => a[0] * toward[0] + a[1] * toward[1] + a[2] * toward[2];
    const outright = key !== this.key || this.traced.some((d) => dot(d) < TURN_MAX);
    let texels: Texels = { step: 1, offset: [0, 0], count: KEY_MAP_SIZE * KEY_MAP_SIZE };
    if (outright) {
      this.key = key;
      this.traced.length = 0;
      for (let k = 0; k < KEY_SLOTS; k++) this.traced.push(toward);
    } else {
      const k = this.count++ % KEY_SLOTS;
      texels = { step: 4, offset: keySlot(k), count: (KEY_MAP_SIZE * KEY_MAP_SIZE) / KEY_SLOTS };
      this.traced[k] = toward;
    }
    const data = new Float32Array(16);
    data.set(info.u, 0);
    data[3] = info.texel;
    data.set(info.v, 4);
    data[7] = info.reach;
    data.set(info.along, 8);
    data.set(info.origin, 12);
    this.device.queue.writeBuffer(this.info, 0, data);
    return texels;
  }

  /** Which texels the build traces, and where in a shared dispatch (none if `rows` is 0). */
  private place(texels: Texels, rows: number, width: number): void {
    this.device.queue.writeBuffer(this.params, 0, new Uint32Array([texels.offset[0], texels.offset[1], texels.step, texels.count, rows, width, 0, 0]));
  }

  destroy(): void {
    this.map.destroy();
    this.info.destroy();
    this.params.destroy();
  }
}
