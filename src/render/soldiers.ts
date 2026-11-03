/**
 * The other players, drawn (the multiplayer spec's §3): each soldier's parts (combat/soldier-model.ts)
 * posed by the rig (combat/soldier-rig.ts), traced and lit after shade and before the rifle
 * (soldiers.wgsl), seen through the haze, their depth then merged into the G-buffer's so the rifle,
 * the effects and TAA take them as the world. Their tape is their team's colour.
 *
 * Each frame the app hands over the soldiers to draw: their parts' frames now and (for the motion)
 * as last drawn, their team and seat. Each one's box on screen comes from its parts' boxes' corners;
 * a probe looks round each one; then, a dispatch a soldier over its box, farthest first: clear their
 * depth, trace and shade, merge.
 *
 * What each one carries (their gear: the gun in their hands with its fit, or the shovel) is a model
 * of its own (combat/gun-models.ts) in one of MAX_SOLDIERS slots after the body's parts, made and
 * written there the first frame it is seen and kept while it is; the shader takes a soldier's
 * slot for their rifle part.
 */

import { gunModel, MODEL_VOXELS_MAX, shovelModel } from '../combat/gun-models';
import { PART_BOX, PARTS, type Frame, type PartName } from '../combat/soldier-rig';
import type { PartGrid } from '../combat/soldier-model';
import { decodeGear } from '../net/gear';
import type { Team } from '../net/protocol';
import { P } from '../world/materials';
import { projectToPixel, type CameraPose } from './camera';
import { StructWriter, structWgsl, type StructDef } from './layout';
import type { LightCells } from './light-cells';
import { moduleSource } from './shaders';
import mergeSrc from './shaders/soldiers-merge.wgsl';
import soldiersSrc from './shaders/soldiers.wgsl';

/** At most this many others are drawn: the room's eight, less this player. */
export const MAX_SOLDIERS = 8;
const PART_COUNT = PARTS.length;
const PROBE_FLOATS = 40;
/** Each soldier's draw record, a dynamic offset apart. */
const DRAW_STRIDE = 256;

const PART: StructDef = { name: 'SoldierPart', fields: [['dims', 'vec3u'], ['offset', 'u32'], ['origin', 'vec3f'], ['voxelM', 'f32']] };
const POSE: StructDef = {
  name: 'SoldierPose',
  fields: [['x', 'vec3f'], ['y', 'vec3f'], ['z', 'vec3f'], ['t', 'vec3f'], ['px', 'vec3f'], ['py', 'vec3f'], ['pz', 'vec3f'], ['pt', 'vec3f']],
};
const INFO: StructDef = { name: 'SoldierInfo', fields: [['feet', 'vec3f'], ['tape', 'u32'], ['slot', 'u32'], ['weapon', 'u32']] };
const SOLDIERS: StructDef = {
  name: 'Soldiers',
  fields: [
    ['count', 'u32'],
    ['parts', { element: PART, count: PART_COUNT }],
    ['info', { element: INFO, count: MAX_SOLDIERS }],
    ['poses', { element: POSE, count: MAX_SOLDIERS * PART_COUNT }],
    // What each weapon slot holds, in the model buffer after the parts.
    ['weapons', { element: PART, count: MAX_SOLDIERS }],
  ],
};
const DRAW: StructDef = { name: 'SoldierDraw', fields: [['soldier', 'u32'], ['box', 'vec4u']] };

const TAPE: Record<Team, number> = { red: P.TAPE_RED, blue: P.TAPE_BLUE };

/** One soldier to draw: their parts' frames, their team, their seat (which keeps their probe), their feet (metres), and their gear (net/gear.ts; none, the bare AK). */
export interface SoldierDraw {
  frames: Record<PartName, Frame>;
  team: Team;
  seat: number;
  feet: readonly [number, number, number];
  gear?: number;
}

export interface SoldierPipelines {
  probe: GPUComputePipeline;
  clear: GPUComputePipeline;
  main: GPUComputePipeline;
  merge: GPUComputePipeline;
  cells: GPUBindGroupLayout;
  soldiers: GPUBindGroupLayout;
  mergeLayout: GPUBindGroupLayout;
}

type Writes = (name: 'soldiers') => GPUComputePassTimestampWrites | undefined;

function header(): string {
  // The Soldiers struct brings its parts', poses' and infos' declarations with it.
  return [structWgsl(SOLDIERS), structWgsl(DRAW), `const SOLDIER_PARTS: u32 = ${PART_COUNT}u;`].join('\n\n');
}

export class Soldiers {
  /** The boxes drawn last frame, farthest first, for tests: [x, y, width, height] each. */
  drawn: [number, number, number, number][] = [];
  private readonly writer = new StructWriter(SOLDIERS);
  private readonly uniform: GPUBuffer;
  private readonly draws: GPUBuffer;
  private readonly model: GPUBuffer;
  private readonly probe: GPUBuffer;
  private readonly cellsGroup: GPUBindGroup;
  private group: GPUBindGroup | null = null;
  private mergeGroup: GPUBindGroup | null = null;
  private depth: GPUTexture | null = null;
  private list: SoldierDraw[] = [];
  /** Each seat's frames as last drawn, for the motion. */
  private readonly before = new Map<number, Record<PartName, Frame>>();
  /** Where the weapon slots start in the model buffer (bytes), what model each holds, and the frame each was last drawn. */
  private weaponBase = 0;
  private readonly slotKeys: (number | null)[] = new Array<number | null>(MAX_SOLDIERS).fill(null);
  private readonly slotSeen = new Array<number>(MAX_SOLDIERS).fill(-1);
  private frameCount = 0;

  static async compile(device: GPUDevice, scene: GPUBindGroupLayout, keyRead: GPUBindGroupLayout): Promise<SoldierPipelines> {
    const C = GPUShaderStage.COMPUTE;
    const cells = device.createBindGroupLayout({
      label: 'soldiers cells',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'storage' } },
      ],
    });
    const written = (binding: number, format: GPUTextureFormat): GPUBindGroupLayoutEntry => ({ binding, visibility: C, storageTexture: { access: 'write-only', format } });
    const soldiers = device.createBindGroupLayout({
      label: 'soldiers',
      entries: [
        // The haze (haze.wgsl's group 3), shared with the soldiers' own.
        { binding: 0, visibility: C, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 1, visibility: C, sampler: { type: 'filtering' } },
        { binding: 2, visibility: C, buffer: { type: 'uniform' } },
        { binding: 3, visibility: C, buffer: { type: 'uniform', hasDynamicOffset: true } },
        { binding: 4, visibility: C, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: C, buffer: { type: 'storage' } },
        { binding: 6, visibility: C, texture: { sampleType: 'unfilterable-float' } },
        written(7, 'rgba16float'),
        written(8, 'rgba16float'),
        written(9, 'r32float'),
      ],
    });
    const mergeLayout = device.createBindGroupLayout({
      label: 'soldiers merge',
      entries: [{ binding: 0, visibility: C, buffer: { type: 'uniform', hasDynamicOffset: true } }, { binding: 1, visibility: C, texture: { sampleType: 'unfilterable-float' } }, written(2, 'r32float')],
    });
    const structs = header();
    const module = device.createShaderModule({ label: 'soldiers', code: moduleSource(`${structs}\n\n${soldiersSrc}`) });
    const mergeModule = device.createShaderModule({ label: 'soldiers merge', code: moduleSource(`${structs}\n\n${mergeSrc}`) });
    for (const [name, m] of [['soldiers', module], ['soldiers-merge', mergeModule]] as const) {
      const errors = (await m.getCompilationInfo()).messages.filter((x) => x.type === 'error');
      if (errors.length) throw new Error(`${name}.wgsl: ${errors.map((x) => `${x.lineNum}:${x.linePos} ${x.message}`).join('; ')}`);
    }
    const layout = device.createPipelineLayout({ bindGroupLayouts: [scene, cells, keyRead, soldiers] });
    const [probe, clear, main, merge] = await Promise.all([
      device.createComputePipelineAsync({ label: 'soldiers probe', layout, compute: { module, entryPoint: 'probe' } }),
      device.createComputePipelineAsync({ label: 'soldiers clear', layout, compute: { module, entryPoint: 'clear' } }),
      device.createComputePipelineAsync({ label: 'soldiers', layout, compute: { module, entryPoint: 'main' } }),
      device.createComputePipelineAsync({ label: 'soldiers merge', layout: device.createPipelineLayout({ bindGroupLayouts: [mergeLayout] }), compute: { module: mergeModule, entryPoint: 'merge' } }),
    ]);
    return { probe, clear, main, merge, cells, soldiers, mergeLayout };
  }

  static create(device: GPUDevice, pipelines: SoldierPipelines, model: Record<PartName, PartGrid>, cells: LightCells, keyGroup: GPUBindGroup): Soldiers {
    return new Soldiers(device, pipelines, model, cells, keyGroup);
  }

  private constructor(
    private readonly device: GPUDevice,
    private readonly pipelines: SoldierPipelines,
    private readonly shape: Record<PartName, PartGrid>,
    cells: LightCells,
    private readonly keyGroup: GPUBindGroup,
  ) {
    this.uniform = device.createBuffer({ label: 'soldiers', size: this.writer.buffer.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.draws = device.createBuffer({ label: 'soldier draws', size: DRAW_STRIDE * MAX_SOLDIERS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // Every part's voxels, one after another; each part's offset in bytes.
    let bytes = 0;
    const offsets = PARTS.map((part) => {
      const at = bytes;
      bytes += shape[part].voxels.length;
      return at;
    });
    // The weapon slots after the parts, each the largest model's size; until one is filled, it is the parts' own rifle.
    this.weaponBase = Math.ceil(bytes / 4) * 4;
    const packed = new Uint32Array((this.weaponBase + MAX_SOLDIERS * MODEL_VOXELS_MAX) / 4);
    const view = new Uint8Array(packed.buffer);
    PARTS.forEach((part, k) => {
      view.set(shape[part].voxels, offsets[k]);
      const g = shape[part];
      this.writer.set(`parts.${k}.dims`, g.dims);
      this.writer.set(`parts.${k}.offset`, offsets[k]);
      this.writer.set(`parts.${k}.origin`, g.origin);
      this.writer.set(`parts.${k}.voxelM`, g.voxelM);
    });
    const rifle = PARTS.indexOf('rifle');
    for (let k = 0; k < MAX_SOLDIERS; k++) {
      const g = shape.rifle;
      this.writer.set(`weapons.${k}.dims`, g.dims);
      this.writer.set(`weapons.${k}.offset`, offsets[rifle]);
      this.writer.set(`weapons.${k}.origin`, g.origin);
      this.writer.set(`weapons.${k}.voxelM`, g.voxelM);
    }
    this.model = device.createBuffer({ label: 'soldier model', size: packed.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.model, 0, packed);
    // Open sky and every light seen, until the probe has looked.
    this.probe = device.createBuffer({ label: 'soldier probe', size: PROBE_FLOATS * MAX_SOLDIERS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.probe, 0, new Float32Array(PROBE_FLOATS * MAX_SOLDIERS).fill(1));
    this.cellsGroup = device.createBindGroup({
      label: 'soldiers cells',
      layout: pipelines.cells,
      entries: [
        { binding: 0, resource: { buffer: cells.grid } },
        { binding: 1, resource: { buffer: cells.cells } },
      ],
    });
  }

  /** Over the frame's G-buffer and shaded image, `alloc` in size, and the haze: after each reallocation. */
  bind(gDepth: GPUTexture, gMotion: GPUTexture, colour: GPUTexture, alloc: readonly [number, number], haze: GPUTexture, hazeSampler: GPUSampler): void {
    this.depth?.destroy();
    this.depth = this.device.createTexture({ label: 'soldier depth', size: [alloc[0], alloc[1]], format: 'r32float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    this.group = this.device.createBindGroup({
      label: 'soldiers',
      layout: this.pipelines.soldiers,
      entries: [
        { binding: 0, resource: haze.createView({ dimension: '3d' }) },
        { binding: 1, resource: hazeSampler },
        { binding: 2, resource: { buffer: this.uniform } },
        { binding: 3, resource: { buffer: this.draws, size: 32 } },
        { binding: 4, resource: { buffer: this.model } },
        { binding: 5, resource: { buffer: this.probe } },
        { binding: 6, resource: gDepth.createView() },
        { binding: 7, resource: gMotion.createView() },
        { binding: 8, resource: colour.createView() },
        { binding: 9, resource: this.depth.createView() },
      ],
    });
    this.mergeGroup = this.device.createBindGroup({
      label: 'soldiers merge',
      layout: this.pipelines.mergeLayout,
      entries: [
        { binding: 0, resource: { buffer: this.draws, size: 32 } },
        { binding: 1, resource: this.depth.createView() },
        { binding: 2, resource: gDepth.createView() },
      ],
    });
  }

  /**
   * The weapon slot holding what `gear` shows (the gun and its fit, or the shovel; its tracers and
   * light change nothing drawn): one already holding it, or the one longest unseen, filled now.
   * `taken`, the slots this frame has already given.
   */
  private slotFor(gear: number, taken: Set<number>): number {
    const key = gear & 0x0fff;
    let slot = this.slotKeys.indexOf(key);
    if (slot < 0) {
      slot = 0;
      for (let k = 0; k < MAX_SOLDIERS; k++) if (!taken.has(k) && (taken.has(slot) || this.slotSeen[k] < this.slotSeen[slot])) slot = k;
      const g = decodeGear(gear);
      const m = g.gun === null ? shovelModel() : gunModel(g.gun, g.fit);
      const bytes = new Uint8Array(Math.ceil(m.voxels.length / 4) * 4);
      bytes.set(m.voxels);
      const offset = this.weaponBase + slot * MODEL_VOXELS_MAX;
      this.device.queue.writeBuffer(this.model, offset, bytes);
      this.writer.set(`weapons.${slot}.dims`, m.dims);
      this.writer.set(`weapons.${slot}.offset`, offset);
      this.writer.set(`weapons.${slot}.origin`, m.origin);
      this.writer.set(`weapons.${slot}.voxelM`, m.voxelM);
      this.slotKeys[slot] = key;
    }
    taken.add(slot);
    this.slotSeen[slot] = this.frameCount;
    return slot;
  }

  /** The soldiers to draw this frame (at most MAX_SOLDIERS are). */
  set(list: readonly SoldierDraw[]): void {
    this.list = list.slice(0, MAX_SOLDIERS);
    const seen = new Set(this.list.map((s) => s.seat));
    for (const seat of [...this.before.keys()]) if (!seen.has(seat)) this.before.delete(seat);
  }

  /** The pixels a soldier's parts cover from `camera` on a `res` image: corner and size, a pixel to spare; the whole image if a corner is behind the eye. */
  box(frames: Record<PartName, Frame>, camera: CameraPose, res: readonly [number, number]): [number, number, number, number] {
    let lo = [Infinity, Infinity];
    let hi = [-Infinity, -Infinity];
    let behind = 0;
    let corners = 0;
    for (const part of PARTS) {
      const f = frames[part];
      const { min, max } = PART_BOX[part];
      for (let c = 0; c < 8; c++) {
        corners++;
        const q = [c & 1 ? max[0] : min[0], c & 2 ? max[1] : min[1], c & 4 ? max[2] : min[2]];
        const w = [0, 1, 2].map((k) => f.t[k] + f.x[k] * q[0] + f.y[k] * q[1] + f.z[k] * q[2]) as [number, number, number];
        const px = projectToPixel(camera, res, w);
        if (!px) {
          behind++;
          continue;
        }
        lo = [Math.min(lo[0], px[0]), Math.min(lo[1], px[1])];
        hi = [Math.max(hi[0], px[0]), Math.max(hi[1], px[1])];
      }
    }
    if (behind === corners) return [0, 0, 0, 0];
    if (behind > 0) return [0, 0, res[0], res[1]];
    const x0 = Math.max(0, Math.floor(lo[0]) - 1);
    const y0 = Math.max(0, Math.floor(lo[1]) - 1);
    const x1 = Math.min(res[0], Math.ceil(hi[0]) + 1);
    const y1 = Math.min(res[1], Math.ceil(hi[1]) + 1);
    return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
  }

  /** Probe, clear, trace and shade, and merge, for a frame seen from `camera` at `res`. */
  encode(encoder: GPUCommandEncoder, scene: GPUBindGroup, camera: CameraPose, res: readonly [number, number], writes: Writes): void {
    this.drawn = [];
    if (this.list.length === 0 || !this.group || !this.mergeGroup) return;
    const eye = camera.position;
    const far = (s: SoldierDraw) => -Math.hypot(s.feet[0] - eye[0], s.feet[1] - eye[1], s.feet[2] - eye[2]);
    const order = this.list
      .map((s) => ({ s, box: this.box(s.frames, camera, res) }))
      .filter(({ box }) => box[2] > 0 && box[3] > 0)
      .sort((a, b) => far(a.s) - far(b.s));
    if (order.length === 0) return;
    const w = this.writer;
    w.set('count', order.length);
    const records = new Uint32Array((DRAW_STRIDE / 4) * MAX_SOLDIERS);
    this.frameCount++;
    const taken = new Set<number>();
    order.forEach(({ s, box }, i) => {
      w.set(`info.${i}.feet`, s.feet);
      w.set(`info.${i}.tape`, TAPE[s.team]);
      w.set(`info.${i}.slot`, s.seat % MAX_SOLDIERS);
      w.set(`info.${i}.weapon`, this.slotFor(s.gear ?? 0, taken));
      const was = this.before.get(s.seat) ?? s.frames;
      PARTS.forEach((part, k) => {
        const now = s.frames[part];
        const then = was[part];
        const at = `poses.${i * PART_COUNT + k}`;
        w.set(`${at}.x`, now.x);
        w.set(`${at}.y`, now.y);
        w.set(`${at}.z`, now.z);
        w.set(`${at}.t`, now.t);
        w.set(`${at}.px`, then.x);
        w.set(`${at}.py`, then.y);
        w.set(`${at}.pz`, then.z);
        w.set(`${at}.pt`, then.t);
      });
      this.before.set(s.seat, s.frames);
      const r = (i * DRAW_STRIDE) / 4;
      records[r] = i;
      records.set(box, r + 4);
    });
    this.device.queue.writeBuffer(this.uniform, 0, w.buffer);
    this.device.queue.writeBuffer(this.draws, 0, records);
    const groups = (p: GPUComputePassEncoder, i: number) => {
      p.setBindGroup(0, scene);
      p.setBindGroup(1, this.cellsGroup);
      p.setBindGroup(2, this.keyGroup);
      p.setBindGroup(3, this.group!, [i * DRAW_STRIDE]);
    };
    const probe = encoder.beginComputePass({ label: 'soldiers probe' });
    probe.setPipeline(this.pipelines.probe);
    groups(probe, 0);
    probe.dispatchWorkgroups(order.length);
    probe.end();
    const clear = encoder.beginComputePass({ label: 'soldiers clear' });
    clear.setPipeline(this.pipelines.clear);
    order.forEach(({ box }, i) => {
      groups(clear, i);
      clear.dispatchWorkgroups(Math.ceil(box[2] / 8), Math.ceil(box[3] / 8));
    });
    clear.end();
    const main = encoder.beginComputePass({ label: 'soldiers', timestampWrites: writes('soldiers') });
    main.setPipeline(this.pipelines.main);
    order.forEach(({ box }, i) => {
      groups(main, i);
      main.dispatchWorkgroups(Math.ceil(box[2] / 8), Math.ceil(box[3] / 8));
    });
    main.end();
    const merge = encoder.beginComputePass({ label: 'soldiers merge' });
    merge.setPipeline(this.pipelines.merge);
    order.forEach(({ box }, i) => {
      merge.setBindGroup(0, this.mergeGroup!, [i * DRAW_STRIDE]);
      merge.dispatchWorkgroups(Math.ceil(box[2] / 8), Math.ceil(box[3] / 8));
    });
    merge.end();
    this.drawn = order.map(({ box }) => box);
  }
}
