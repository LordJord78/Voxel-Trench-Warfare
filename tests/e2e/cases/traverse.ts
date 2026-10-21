import { Rng } from '../../../src/core/rng';
import { HeapMirror } from '../../../src/world/encode';
import { FLAGS, FRAME, writeWorldInfo } from '../../../src/render/frame-uniforms';
import { GpuWorld } from '../../../src/render/gpu-world';
import { StructWriter } from '../../../src/render/layout';
import { sceneGroup, sceneLayout } from '../../../src/render/scene';
import { moduleSource } from '../../../src/render/shaders';
import traceTest from '../shaders/trace-test.wgsl';
import { gpu, readBuffer } from '../support/gpu';
import { syntheticWorld, SYNTHETIC } from '../../support/synthetic';
import { traceRef, type Vec3 } from '../../support/trace-ref';

type Kind = 'open' | 'axis' | 'outside' | 'grazing' | 'plane';
interface Ray {
  o: Vec3;
  d: Vec3;
  kind: Kind;
}

function unit(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** The ray mix the plan names, with origins and directions rounded to f32 as the GPU sees them. */
function makeRays(count: number): Ray[] {
  const rng = Rng.root(9).derive('traverse');
  const sphere = (): [number, number, number] => {
    const u = rng.uniform(-1, 1);
    const phi = rng.uniform(0, 2 * Math.PI);
    const s = Math.sqrt(1 - u * u);
    return [s * Math.cos(phi), u, s * Math.sin(phi)];
  };
  const axes: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const { x: X, y: Y, z: Z } = SYNTHETIC;
  const rays: Ray[] = [];
  const planes = [0, 32, 64, 96, 128, 160, 192, 224];
  for (let i = 0; i < 64; i++) {
    const o: [number, number, number] = [rng.choice(planes), rng.choice([48, 56, 64, 72]), rng.choice(planes) + 0.5];
    rays.push({ o, d: i % 2 ? rng.choice(axes) : unit([rng.uniform(-1, 1), rng.uniform(-1, 0.2), rng.uniform(-1, 1)]), kind: 'plane' });
  }
  while (rays.length < count) {
    const r = rng.float();
    if (r < 0.5) {
      rays.push({ o: [rng.uniform(1, X - 1), rng.uniform(50, Y - 2), rng.uniform(1, Z - 1)], d: sphere(), kind: 'open' });
    } else if (r < 0.7) {
      rays.push({ o: [rng.uniform(0, X), rng.uniform(40, Y - 1), rng.uniform(0, Z)], d: rng.choice(axes), kind: 'axis' });
    } else if (r < 0.85) {
      const side = rng.randint(0, 5);
      const o: [number, number, number] = [rng.uniform(0, X), rng.uniform(40, Y), rng.uniform(0, Z)];
      if (side === 0) o[1] = rng.uniform(Y + 1, Y + 80);
      else if (side === 1) o[0] = rng.uniform(-80, -1);
      else if (side === 2) o[0] = rng.uniform(X + 1, X + 80);
      else if (side === 3) o[2] = rng.uniform(-80, -1);
      else o[2] = rng.uniform(Z + 1, Z + 80);
      const target: [number, number, number] = [rng.uniform(0, X), rng.uniform(30, 60), rng.uniform(0, Z)];
      const inward = unit([target[0] - o[0], target[1] - o[1], target[2] - o[2]]);
      rays.push({ o, d: rng.chance(0.8) ? inward : sphere(), kind: 'outside' });
    } else {
      const a = rng.uniform(0, 2 * Math.PI);
      const dy = rng.uniform(-0.05, 0.05);
      rays.push({ o: [rng.uniform(1, X - 1), rng.uniform(45, 55), rng.uniform(1, Z - 1)], d: unit([Math.cos(a), dy, Math.sin(a)]), kind: 'grazing' });
    }
  }
  const f = Math.fround;
  return rays.map((r) => ({ o: [f(r.o[0]), f(r.o[1]), f(r.o[2])], d: [f(r.d[0]), f(r.d[1]), f(r.d[2])], kind: r.kind }));
}

interface Result {
  hit: boolean;
  t: number;
  face: number;
  mat: number;
  steps: number;
  cell: [number, number, number];
}

export const cases = {
  async traverse(args?: { count?: number }) {
    const { device, errors } = await gpu();
    const count = args?.count ?? 8192;
    const map = syntheticWorld(4);
    const world = GpuWorld.create(device, { map, mirror: HeapMirror.fromMap(map) });
    const rays = makeRays(count);
    const rayData = new ArrayBuffer(count * 32);
    const rf = new Float32Array(rayData);
    const ru = new Uint32Array(rayData);
    const results = device.createBuffer({ size: count * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const rayBuffer = device.createBuffer({ size: count * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const frameBuffer = device.createBuffer({ size: new StructWriter(FRAME).buffer.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const scene = sceneLayout(device);
    const local = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const module = device.createShaderModule({ code: moduleSource(traceTest) });
    const info = await module.getCompilationInfo();
    const messages = info.messages.filter((m) => m.type === 'error').map((m) => `${m.lineNum}:${m.linePos} ${m.message}`);
    if (messages.length) return { compileErrors: messages };
    const pipeline = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [scene, local] }),
      compute: { module, entryPoint: 'main' },
    });
    const run = async (flags: number, wantMaterial: boolean): Promise<Result[]> => {
      rays.forEach((r, i) => {
        rf.set([r.o[0], r.o[1], r.o[2], 1e6, r.d[0], r.d[1], r.d[2]], i * 8);
        ru[i * 8 + 7] = wantMaterial ? 1 : 0;
      });
      device.queue.writeBuffer(rayBuffer, 0, rayData);
      const frame = new StructWriter(FRAME);
      writeWorldInfo(frame, world);
      frame.set('flags', flags);
      device.queue.writeBuffer(frameBuffer, 0, frame.buffer);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, sceneGroup(device, scene, frameBuffer, world));
      pass.setBindGroup(1, device.createBindGroup({ layout: local, entries: [{ binding: 0, resource: { buffer: rayBuffer } }, { binding: 1, resource: { buffer: results } }] }));
      pass.dispatchWorkgroups(Math.ceil(count / 64));
      pass.end();
      device.queue.submit([encoder.finish()]);
      const out = await readBuffer(results, count * 32);
      const of = new Float32Array(out);
      const ou = new Uint32Array(out);
      const oi = new Int32Array(out);
      return rays.map((_, i) => ({
        t: of[i * 8], face: ou[i * 8 + 1], mat: ou[i * 8 + 2], steps: ou[i * 8 + 3],
        cell: [oi[i * 8 + 4], oi[i * 8 + 5], oi[i * 8 + 6]], hit: ou[i * 8 + 7] === 1,
      }));
    };
    const on = await run(0, true);
    const off = await run(FLAGS.PYRAMID_OFF, true);
    const occupancy = await run(0, false);

    const same = (a: Result, b: { hit: boolean; cell: readonly number[]; face: number; mat: number }) =>
      a.hit === b.hit && (!a.hit || (a.cell[0] === b.cell[0] && a.cell[1] === b.cell[1] && a.cell[2] === b.cell[2] && a.face === b.face && a.mat === b.mat));
    /** A disagreement two right answers can have: hits within 0.01 of each other, or a ray grazing a voxel edge. */
    const tie = (g: Result, r: ReturnType<typeof traceRef>, ray: Ray) => {
      if (g.hit && r.hit) return Math.abs(g.t - r.t) < 0.01;
      const hitT = g.hit ? g.t : r.t;
      const p = [0, 1, 2].map((k) => ray.o[k] + ray.d[k] * hitT);
      const near = p.filter((v) => Math.abs(v - Math.round(v)) < 0.01).length;
      return near >= 2;
    };
    let agree = 0;
    const wrong: string[] = [];
    let ties = 0;
    let pyramidDiffs = 0;
    let occupancyDiffs = 0;
    let maxSteps = 0;
    let grazingOn = 0;
    let grazingOff = 0;
    let grazing = 0;
    rays.forEach((ray, i) => {
      const ref = traceRef(map, ray.o, ray.d, 1e6);
      const g = on[i];
      if (same(g, ref) && (!g.hit || Math.abs(g.t - ref.t) < 0.01)) agree++;
      else if (tie(g, ref, ray)) ties++;
      else if (wrong.length < 12) wrong.push(`${ray.kind} o ${ray.o.map((v) => v.toFixed(3))} d ${ray.d.map((v) => v.toFixed(4))}: gpu ${JSON.stringify(g)} ref ${JSON.stringify(ref)}`);
      if (!same(g, off[i]) || (g.hit && Math.abs(g.t - off[i].t) > 1e-3)) pyramidDiffs++;
      if (g.hit !== occupancy[i].hit || (g.hit && Math.abs(g.t - occupancy[i].t) > 1e-3)) occupancyDiffs++;
      maxSteps = Math.max(maxSteps, g.steps, off[i].steps);
      if (ray.kind === 'grazing') {
        grazing++;
        grazingOn += g.steps;
        grazingOff += off[i].steps;
      }
    });
    for (const b of [world.table, world.sectors, world.heap, world.palette, world.pyramid, results, rayBuffer, frameBuffer]) b.destroy();
    return {
      total: count, agree, ties, wrong, pyramidDiffs, occupancyDiffs, maxSteps,
      grazingStepsOn: grazingOn / grazing, grazingStepsOff: grazingOff / grazing, errors: [...errors],
    };
  },
};
