import { Rng } from '../../../src/core/rng';
import { HeapMirror } from '../../../src/world/encode';
import { FAR, type FarField } from '../../../src/world/generation/farfield';
import { FarFieldGpu } from '../../../src/render/farfield-gpu';
import { prepareFarHeights } from '../../../src/render/farfield-mips';
import { FRAME, writeWorldInfo } from '../../../src/render/frame-uniforms';
import { GpuWorld } from '../../../src/render/gpu-world';
import { StructWriter } from '../../../src/render/layout';
import { sceneExtras, sceneGroup, sceneLayout } from '../../../src/render/scene';
import { moduleSource } from '../../../src/render/shaders';
import farTest from '../shaders/far-test.wgsl';
import { gpu, readBuffer } from '../support/gpu';
import { syntheticWorld } from '../../support/synthetic';
import { marchRef, type Vec3 } from '../../support/trace-ref';

/** 256 cells of 20 voxels, rolling ground, and the 1024-voxel map in the middle where the far field is empty. */
function syntheticFar(): FarField {
  const size = 256;
  const cell = 20;
  const originX = -2048;
  const originZ = -2048;
  const height = new Float32Array(size * size);
  const material = new Uint8Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = originX + (i + 0.5) * cell;
      const z = originZ + (j + 0.5) * cell;
      const inside = x >= 0 && x < 1024 && z >= 0 && z < 1024;
      height[j * size + i] = inside ? -Infinity : 150 + 30 * Math.sin(x / 400) * Math.cos(z / 300) + 15 * Math.sin(x / 97 + z / 131);
      material[j * size + i] = inside ? FAR.NONE : (i + j) % 3 === 0 ? FAR.PLOUGHED : FAR.FIELD;
    }
  }
  return { size, cell, originX, originZ, height, material };
}

export const cases = {
  async farfield(args?: { count?: number }) {
    const g = await gpu();
    const device = g.device;
    const count = args?.count ?? 4096;
    const ff = syntheticFar();
    const far = FarFieldGpu.create(device, ff);
    const map = syntheticWorld(1);
    const world = GpuWorld.create(device, { map, mirror: HeapMirror.fromMap(map) });
    const ref = { size: ff.size, cell: ff.cell, originX: ff.originX, originZ: ff.originZ, heights: prepareFarHeights(ff.height, ff.size) };
    const rng = Rng.root(5).derive('far');
    const rays: { o: Vec3; d: Vec3; kind: 'out' | 'down' }[] = [];
    while (rays.length < count) {
      if (rng.chance(0.85)) {
        const a = rng.uniform(0, 2 * Math.PI);
        const dy = rng.uniform(-0.2, 0.2);
        const l = Math.hypot(Math.cos(a), dy, Math.sin(a));
        rays.push({ o: [rng.uniform(0, 1024), rng.uniform(160, 600), rng.uniform(0, 1024)], d: [Math.cos(a) / l, dy / l, Math.sin(a) / l], kind: 'out' });
      } else {
        const d: [number, number, number] = [rng.uniform(-0.3, 0.3), -1, rng.uniform(-0.3, 0.3)];
        const l = Math.hypot(...d);
        rays.push({ o: [rng.uniform(200, 800), rng.uniform(300, 600), rng.uniform(200, 800)], d: [d[0] / l, d[1] / l, d[2] / l], kind: 'down' });
      }
    }
    const f = Math.fround;
    const data = new Float32Array(count * 8);
    rays.forEach((r, i) => data.set([f(r.o[0]), f(r.o[1]), f(r.o[2]), 0, f(r.d[0]), f(r.d[1]), f(r.d[2]), 6000], i * 8));
    const rayBuffer = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(rayBuffer, 0, data);
    const results = device.createBuffer({ size: count * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const frame = new StructWriter(FRAME);
    writeWorldInfo(frame, world);
    frame.set('far', far.info);
    const frameBuffer = device.createBuffer({ size: frame.buffer.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(frameBuffer, 0, frame.buffer);
    const scene = sceneLayout(device);
    const local = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const module = device.createShaderModule({ code: moduleSource(farTest) });
    const info = await module.getCompilationInfo();
    const compileErrors = info.messages.filter((m) => m.type === 'error').map((m) => `${m.lineNum}:${m.linePos} ${m.message}`);
    if (compileErrors.length) return { compileErrors };
    const pipeline = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [scene, local] }),
      compute: { module, entryPoint: 'main' },
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, sceneGroup(device, scene, { frame: frameBuffer, world, far, ...sceneExtras(device) }));
    pass.setBindGroup(1, device.createBindGroup({ layout: local, entries: [{ binding: 0, resource: { buffer: rayBuffer } }, { binding: 1, resource: { buffer: results } }] }));
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.end();
    device.queue.submit([encoder.finish()]);
    const out = await readBuffer(results, count * 32);
    const of = new Float32Array(out);
    const ou = new Uint32Array(out);
    let agree = 0;
    let hits = 0;
    let worstT = 0;
    let worstAngle = 0;
    let insideHits = 0;
    const wrong: string[] = [];
    rays.forEach((r, i) => {
      const o: Vec3 = [data[i * 8], data[i * 8 + 1], data[i * 8 + 2]];
      const d: Vec3 = [data[i * 8 + 4], data[i * 8 + 5], data[i * 8 + 6]];
      const want = marchRef(ref, o, d, 0, 6000);
      const hit = ou[i * 8 + 4] === 1;
      const t = of[i * 8 + 3];
      if (hit && r.kind === 'down') {
        const x = o[0] + d[0] * t;
        const z = o[2] + d[2] * t;
        if (x > 20 && x < 1004 && z > 20 && z < 1004) insideHits++;
      }
      if (hit !== want.hit) {
        if (wrong.length < 8) wrong.push(`${r.kind} o ${o.map((v) => v.toFixed(1))} d ${d.map((v) => v.toFixed(3))}: gpu ${hit ? t.toFixed(2) : 'miss'} ref ${want.hit ? want.t.toFixed(2) : 'miss'}`);
        return;
      }
      agree++;
      if (!hit) return;
      hits++;
      worstT = Math.max(worstT, Math.abs(t - want.t));
      const n = [of[i * 8], of[i * 8 + 1], of[i * 8 + 2]];
      const cos = n[0] * want.n[0] + n[1] * want.n[1] + n[2] * want.n[2];
      worstAngle = Math.max(worstAngle, (Math.acos(Math.min(1, cos)) * 180) / Math.PI);
    });
    for (const b of [world.table, world.sectors, world.heap, world.palette, world.pyramid, rayBuffer, results, frameBuffer]) b.destroy();
    far.destroy();
    return { count, agree, hits, worstT, worstAngle, insideHits, wrong, errors: [...g.errors] };
  },

  /**
   * The far field's shading normal along a line of points 0.1 cell apart across eight patch
   * edges: the largest angle between neighbours, in degrees.
   */
  async farSmoothness() {
    const g = await gpu();
    const device = g.device;
    const ff = syntheticFar();
    const far = FarFieldGpu.create(device, ff);
    const map = syntheticWorld(1);
    const world = GpuWorld.create(device, { map, mirror: HeapMirror.fromMap(map) });
    const line = 81;
    // Then 20 points on the last patches before the map's hole, whose stencils reach into it.
    const edge = 20;
    const count = line + edge;
    const data = new Float32Array(count * 8);
    for (let k = 0; k < line; k++) {
      // From the middle of cell 30 to the middle of cell 38, along x, at z in the middle of row 40.
      data.set([ff.originX + (30.5 + 0.1 * k) * ff.cell, 400, ff.originZ + 40.3 * ff.cell, 0, 0, -1, 0, 0], k * 8);
    }
    for (let k = 0; k < edge; k++) {
      // Patch 101 is the last outside the hole (x < 0), between sample 101 and the ring of ground
      // carried into the map (102): its stencil reaches sample 103, which has none. z is mid-hole.
      data.set([ff.originX + (101.5 + 0.045 * k) * ff.cell, 400, 500, 0, 0, -1, 0, 0], (line + k) * 8);
    }
    const points = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(points, 0, data);
    const results = device.createBuffer({ size: count * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const frame = new StructWriter(FRAME);
    writeWorldInfo(frame, world);
    frame.set('far', far.info);
    const frameBuffer = device.createBuffer({ size: frame.buffer.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(frameBuffer, 0, frame.buffer);
    const scene = sceneLayout(device);
    const local = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const module = device.createShaderModule({ code: moduleSource(farTest) });
    const pipeline = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [scene, local] }),
      compute: { module, entryPoint: 'normals' },
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, sceneGroup(device, scene, { frame: frameBuffer, world, far, ...sceneExtras(device) }));
    pass.setBindGroup(1, device.createBindGroup({ layout: local, entries: [{ binding: 0, resource: { buffer: points } }, { binding: 1, resource: { buffer: results } }] }));
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.end();
    device.queue.submit([encoder.finish()]);
    const n = new Float32Array(await readBuffer(results, count * 32));
    let worst = 0;
    let tilt = 0;
    let edgeBad = 0;
    for (let k = line; k < count; k++) {
      const y = n[k * 8 + 1];
      if (!(Number.isFinite(y) && y > 0.5)) edgeBad++;
    }
    for (let k = 1; k < line; k++) {
      const a = [n[(k - 1) * 8], n[(k - 1) * 8 + 1], n[(k - 1) * 8 + 2]];
      const b = [n[k * 8], n[k * 8 + 1], n[k * 8 + 2]];
      const cos = Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
      worst = Math.max(worst, (Math.acos(cos) * 180) / Math.PI);
      tilt = Math.max(tilt, (Math.acos(Math.min(1, b[1])) * 180) / Math.PI);
    }
    for (const b of [world.table, world.sectors, world.heap, world.palette, world.pyramid, points, results, frameBuffer]) b.destroy();
    far.destroy();
    return { worst, tilt, edgeBad, errors: [...g.errors] };
  },
};
