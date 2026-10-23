/**
 * The rifle in the world's light (spec §4; the C3 plan's ruling 1): the voxel
 * model (combat/rifle-model.ts) drawn in passes of its own after shade and
 * before TAA (rifle.wgsl), not into the G-buffer.
 *
 * Each frame the rig hands over where the model is (model metres to world
 * metres, this frame's and the last's). The box it covers on screen comes from
 * its grid's corners. A workgroup probes how open the sky is along it and
 * whether the eye cell's lights see it; a pass over the box traces and shades
 * it where it is nearer than the world, writing the shaded image and the
 * motion; a last one puts its depth into the G-buffer's. Hidden (null), none
 * of them runs.
 */

import type { RifleModel } from '../combat/rifle-model';
import { projectToPixel, type CameraPose } from './camera';
import { StructWriter, structWgsl, type StructDef } from './layout';
import type { LightCells } from './light-cells';
import { moduleSource } from './shaders';
import mergeSrc from './shaders/rifle-merge.wgsl';
import rifleSrc from './shaders/rifle.wgsl';

/** Model metres to world metres this frame and the last, 3 × 4, column-major: the model's x, y and z axes in the world, then its origin. */
export interface RiflePose {
  toWorld: Float32Array;
  prevToWorld: Float32Array;
}

const RIFLE: StructDef = {
  name: 'Rifle',
  fields: [
    ['x', 'vec3f'],
    ['y', 'vec3f'],
    ['z', 'vec3f'],
    ['t', 'vec3f'],
    ['px', 'vec3f'],
    ['py', 'vec3f'],
    ['pz', 'vec3f'],
    ['pt', 'vec3f'],
    ['dims', 'vec3u'],
    ['voxelM', 'f32'],
    ['origin', 'vec3f'],
    ['specular', 'f32'],
    // The box drawn: its corner and size, in pixels.
    ['box', 'vec4u'],
  ],
};

/** The probe's floats: the sky's openness at 8 points along the rifle, then each of the cell's 32 lights' visibility. */
const PROBE_FLOATS = 8 + 32 + 4;

export interface RiflePipelines {
  probe: GPUComputePipeline;
  main: GPUComputePipeline;
  merge: GPUComputePipeline;
  cells: GPUBindGroupLayout;
  rifle: GPUBindGroupLayout;
  mergeLayout: GPUBindGroupLayout;
}

/** What the last frame drew: whether, the box (corner and size, pixels), and through what. */
export interface RifleDrawn {
  visible: boolean;
  box: [number, number, number, number];
  toWorld: Float32Array | null;
  camera: CameraPose | null;
  res: [number, number];
}

type Writes = (name: 'rifle') => GPUComputePassTimestampWrites | undefined;

/** A model point (metres) through a 3 × 4 column-major transform. */
export function throughPose(m: Float32Array, p: readonly number[]): [number, number, number] {
  return [0, 1, 2].map((k) => m[k] * p[0] + m[3 + k] * p[1] + m[6 + k] * p[2] + m[9 + k]) as [number, number, number];
}

export class Rifle {
  drawn: RifleDrawn = { visible: false, box: [0, 0, 0, 0], toWorld: null, camera: null, res: [0, 0] };
  private readonly writer = new StructWriter(RIFLE);
  private readonly uniform: GPUBuffer;
  private readonly model: GPUBuffer;
  private readonly probe: GPUBuffer;
  private readonly cellsGroup: GPUBindGroup;
  private rifleGroup: GPUBindGroup | null = null;
  private mergeGroup: GPUBindGroup | null = null;
  private rifleDepth: GPUTexture | null = null;
  private pose: RiflePose | null = null;

  static async compile(device: GPUDevice, scene: GPUBindGroupLayout, keyRead: GPUBindGroupLayout): Promise<RiflePipelines> {
    const C = GPUShaderStage.COMPUTE;
    const cells = device.createBindGroupLayout({
      label: 'rifle cells',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'storage' } },
      ],
    });
    const written = (binding: number, format: GPUTextureFormat): GPUBindGroupLayoutEntry => ({ binding, visibility: C, storageTexture: { access: 'write-only', format } });
    const rifle = device.createBindGroupLayout({
      label: 'rifle',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: C, buffer: { type: 'storage' } },
        { binding: 3, visibility: C, texture: { sampleType: 'unfilterable-float' } },
        written(4, 'rgba16float'),
        written(5, 'rgba16float'),
        written(6, 'r32float'),
      ],
    });
    const mergeLayout = device.createBindGroupLayout({
      label: 'rifle merge',
      entries: [{ binding: 0, visibility: C, buffer: { type: 'uniform' } }, { binding: 1, visibility: C, texture: { sampleType: 'unfilterable-float' } }, written(2, 'r32float')],
    });
    const structs = structWgsl(RIFLE);
    const module = device.createShaderModule({ label: 'rifle', code: moduleSource(`${structs}\n\n${rifleSrc}`) });
    const mergeModule = device.createShaderModule({ label: 'rifle merge', code: moduleSource(`${structs}\n\n${mergeSrc}`) });
    for (const [name, m] of [['rifle', module], ['rifle-merge', mergeModule]] as const) {
      const errors = (await m.getCompilationInfo()).messages.filter((x) => x.type === 'error');
      if (errors.length) throw new Error(`${name}.wgsl: ${errors.map((x) => `${x.lineNum}:${x.linePos} ${x.message}`).join('; ')}`);
    }
    const layout = device.createPipelineLayout({ bindGroupLayouts: [scene, cells, keyRead, rifle] });
    const [probe, main, merge] = await Promise.all([
      device.createComputePipelineAsync({ label: 'rifle probe', layout, compute: { module, entryPoint: 'probe' } }),
      device.createComputePipelineAsync({ label: 'rifle', layout, compute: { module, entryPoint: 'main' } }),
      device.createComputePipelineAsync({ label: 'rifle merge', layout: device.createPipelineLayout({ bindGroupLayouts: [mergeLayout] }), compute: { module: mergeModule, entryPoint: 'merge' } }),
    ]);
    return { probe, main, merge, cells, rifle, mergeLayout };
  }

  /** Lit through `cells` and the key light's map's group (key-shadow.ts `group`), its steel shining by `specular`. */
  static create(device: GPUDevice, pipelines: RiflePipelines, model: RifleModel, cells: LightCells, keyGroup: GPUBindGroup, specular: number): Rifle {
    return new Rifle(device, pipelines, model, cells, keyGroup, specular);
  }

  private constructor(
    private readonly device: GPUDevice,
    private readonly pipelines: RiflePipelines,
    private readonly shape: RifleModel,
    cells: LightCells,
    private readonly keyGroup: GPUBindGroup,
    specular: number,
  ) {
    this.uniform = device.createBuffer({ label: 'rifle', size: this.writer.buffer.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const packed = new Uint32Array(Math.ceil(shape.voxels.length / 4));
    new Uint8Array(packed.buffer).set(shape.voxels);
    this.model = device.createBuffer({ label: 'rifle model', size: packed.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.model, 0, packed);
    // Open sky and every light seen, until the probe has looked.
    this.probe = device.createBuffer({ label: 'rifle probe', size: PROBE_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.probe, 0, new Float32Array(PROBE_FLOATS).fill(1));
    this.cellsGroup = device.createBindGroup({
      label: 'rifle cells',
      layout: pipelines.cells,
      entries: [
        { binding: 0, resource: { buffer: cells.grid } },
        { binding: 1, resource: { buffer: cells.cells } },
      ],
    });
    this.writer.set('dims', shape.dims);
    this.writer.set('voxelM', shape.voxelM);
    this.writer.set('origin', shape.origin);
    this.writer.set('specular', specular);
  }

  /** Over the frame's G-buffer and shaded image, `alloc` in size: after each reallocation. */
  bind(gDepth: GPUTexture, gMotion: GPUTexture, colour: GPUTexture, alloc: readonly [number, number]): void {
    this.rifleDepth?.destroy();
    this.rifleDepth = this.device.createTexture({ label: 'rifle depth', size: [alloc[0], alloc[1]], format: 'r32float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    this.rifleGroup = this.device.createBindGroup({
      label: 'rifle',
      layout: this.pipelines.rifle,
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: { buffer: this.model } },
        { binding: 2, resource: { buffer: this.probe } },
        { binding: 3, resource: gDepth.createView() },
        { binding: 4, resource: gMotion.createView() },
        { binding: 5, resource: colour.createView() },
        { binding: 6, resource: this.rifleDepth.createView() },
      ],
    });
    this.mergeGroup = this.device.createBindGroup({
      label: 'rifle merge',
      layout: this.pipelines.mergeLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: this.rifleDepth.createView() },
        { binding: 2, resource: gDepth.createView() },
      ],
    });
  }

  /** Where the rifle is this frame; null hides it. */
  set(pose: RiflePose | null): void {
    this.pose = pose;
  }

  /** The pixels its grid covers seen from `camera` on a `res` image: corner and size, a pixel to spare; the whole image if a corner is behind the eye. */
  box(toWorld: Float32Array, camera: CameraPose, res: readonly [number, number]): [number, number, number, number] {
    const m = this.shape;
    let lo = [Infinity, Infinity];
    let hi = [-Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      const p = [0, 1, 2].map((k) => ((c >> k) & 1 ? m.dims[k] - m.origin[k] : -m.origin[k]) * m.voxelM);
      const px = projectToPixel(camera, res, throughPose(toWorld, p));
      if (!px) {
        lo = [0, 0];
        hi = [res[0], res[1]];
        break;
      }
      lo = [Math.min(lo[0], px[0]), Math.min(lo[1], px[1])];
      hi = [Math.max(hi[0], px[0]), Math.max(hi[1], px[1])];
    }
    const x0 = Math.max(0, Math.floor(lo[0]) - 1);
    const y0 = Math.max(0, Math.floor(lo[1]) - 1);
    const x1 = Math.min(res[0], Math.ceil(hi[0]) + 1);
    const y1 = Math.min(res[1], Math.ceil(hi[1]) + 1);
    return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
  }

  /** Probe, trace and shade, and merge the depth, for a frame seen from `camera` at `res`. */
  encode(encoder: GPUCommandEncoder, scene: GPUBindGroup, camera: CameraPose, res: readonly [number, number], writes: Writes): void {
    const pose = this.pose;
    this.drawn = { visible: false, box: [0, 0, 0, 0], toWorld: null, camera: null, res: [res[0], res[1]] };
    if (!pose || !this.rifleGroup || !this.mergeGroup) return;
    const box = this.box(pose.toWorld, camera, res);
    if (box[2] === 0 || box[3] === 0) return;
    const w = this.writer;
    for (const [name, m, o] of [['x', pose.toWorld, 0], ['y', pose.toWorld, 3], ['z', pose.toWorld, 6], ['t', pose.toWorld, 9], ['px', pose.prevToWorld, 0], ['py', pose.prevToWorld, 3], ['pz', pose.prevToWorld, 6], ['pt', pose.prevToWorld, 9]] as const) {
      w.set(name, [m[o], m[o + 1], m[o + 2]]);
    }
    w.set('box', box);
    this.device.queue.writeBuffer(this.uniform, 0, w.buffer);
    const groups = (p: GPUComputePassEncoder) => {
      p.setBindGroup(0, scene);
      p.setBindGroup(1, this.cellsGroup);
      p.setBindGroup(2, this.keyGroup);
      p.setBindGroup(3, this.rifleGroup!);
    };
    const probe = encoder.beginComputePass({ label: 'rifle probe' });
    probe.setPipeline(this.pipelines.probe);
    groups(probe);
    probe.dispatchWorkgroups(1);
    probe.end();
    const main = encoder.beginComputePass({ label: 'rifle', timestampWrites: writes('rifle') });
    main.setPipeline(this.pipelines.main);
    groups(main);
    main.dispatchWorkgroups(Math.ceil(box[2] / 8), Math.ceil(box[3] / 8));
    main.end();
    const merge = encoder.beginComputePass({ label: 'rifle merge' });
    merge.setPipeline(this.pipelines.merge);
    merge.setBindGroup(0, this.mergeGroup);
    merge.dispatchWorkgroups(Math.ceil(box[2] / 8), Math.ceil(box[3] / 8));
    merge.end();
    this.drawn = { visible: true, box, toWorld: pose.toWorld, camera, res: [res[0], res[1]] };
  }
}
