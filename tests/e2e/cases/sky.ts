import { loadTunables } from '../../../src/core/tunables';
import { HeapMirror } from '../../../src/world/encode';
import { Atmosphere, atmosphereModel } from '../../../src/render/atmosphere';
import { FarFieldGpu } from '../../../src/render/farfield-gpu';
import { FRAME, PROBE_DUSK, writeSky, writeWorldInfo } from '../../../src/render/frame-uniforms';
import { GpuWorld } from '../../../src/render/gpu-world';
import { StructWriter } from '../../../src/render/layout';
import { sceneExtras, sceneGroup, sceneLayout } from '../../../src/render/scene';
import { moduleSource } from '../../../src/render/shaders';
import skyTest from '../shaders/sky-test.wgsl';
import { gpu, readBuffer, readTexture } from '../support/gpu';
import { halfToFloat } from '../support/half';
import { syntheticWorld } from '../../support/synthetic';

/** A LUT's texels, RGBA, row by row. */
async function lutValues(texture: GPUTexture): Promise<number[]> {
  const bytes = await readTexture(texture);
  return texture.format === 'rgba32float' ? Array.from(new Float32Array(bytes)) : Array.from(new Uint16Array(bytes), halfToFloat);
}

/** Values that are not finite, or (unless they are logs) below zero. */
const bad = (values: number[], logs = false) => values.filter((v) => !Number.isFinite(v) || (!logs && v < 0)).length;

/** Run sky-test.wgsl's `entry` over `dirs` with the frame's sky lit by `sky`'s lights, the sky views built for them. */
async function sample(entry: 'main' | 'fog', dirs: number[][], sky: { sunDir: number[]; moonDir: number[]; sunLight: number[]; moonLight: number[] }, heightM: number) {
  const g = await gpu();
  const device = g.device;
  const atmosphere = Atmosphere.create(device, await Atmosphere.compile(device), atmosphereModel(loadTunables()));
  const map = syntheticWorld(1);
  const world = GpuWorld.create(device, { map, mirror: HeapMirror.fromMap(map) });
  const far = FarFieldGpu.empty(device);
  const n = dirs.length;
  const dirData = new Float32Array(n * 4);
  dirs.forEach((d, i) => dirData.set([d[0], d[1], d[2], 0], i * 4));
  const dirBuffer = device.createBuffer({ size: dirData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(dirBuffer, 0, dirData);
  const out = device.createBuffer({ size: n * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const frame = new StructWriter(FRAME);
  writeWorldInfo(frame, world);
  writeSky(frame, { ...PROBE_DUSK, ...sky });
  const frameBuffer = device.createBuffer({ size: frame.buffer.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const scene = sceneLayout(device);
  const local = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const module = device.createShaderModule({ code: moduleSource(skyTest) });
  const info = await module.getCompilationInfo();
  const compileErrors = info.messages.filter((m) => m.type === 'error').map((m) => `${m.lineNum}:${m.linePos} ${m.message}`);
  if (compileErrors.length) return { compileErrors, values: [] as number[][], errors: [...g.errors] };
  const pipeline = await device.createComputePipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: [scene, local] }), compute: { module, entryPoint: entry } });
  const extras = sceneExtras(device);
  const encoder = device.createCommandEncoder();
  atmosphere.update(encoder, { sunDir: sky.sunDir, moonDir: sky.moonDir }, heightM);
  atmosphere.writeTo(frame, 'atmosphere');
  device.queue.writeBuffer(frameBuffer, 0, frame.buffer);
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, sceneGroup(device, scene, { frame: frameBuffer, world, far, lights: extras.lights, noise: extras.noise, sky: atmosphere.views() }));
  pass.setBindGroup(1, device.createBindGroup({ layout: local, entries: [{ binding: 0, resource: { buffer: dirBuffer } }, { binding: 1, resource: { buffer: out } }] }));
  pass.dispatchWorkgroups(Math.ceil(n / 64));
  pass.end();
  device.queue.submit([encoder.finish()]);
  const v = new Float32Array(await readBuffer(out, n * 16));
  for (const b of [world.table, world.sectors, world.heap, world.palette, world.pyramid, dirBuffer, out, frameBuffer, extras.lights]) b.destroy();
  far.destroy();
  atmosphere.destroy();
  return { compileErrors, values: Array.from({ length: n }, (_, i) => Array.from(v.subarray(i * 4, i * 4 + 3))), errors: [...g.errors] };
}

export const cases = {
  /**
   * The atmosphere's LUTs for the game's tunables: the sky along each of `dirs`, sampled as shading
   * samples it, for every sun in `suns` at every camera height in `heightsM` (suns outermost), with
   * the moon at `moon`; the six faces' irradiance from each, per unit of its light; the
   * transmittance and multiple-scattering LUTs as built; and how many texels of each LUT are not
   * finite or negative, over every build.
   */
  async skyModel(args: { dirs: number[][]; suns: number[][]; moon: number[]; heightsM: number[] }) {
    const g = await gpu();
    const device = g.device;
    const model = atmosphereModel(loadTunables());
    const atmosphere = Atmosphere.create(device, await Atmosphere.compile(device), model);
    const map = syntheticWorld(1);
    const world = GpuWorld.create(device, { map, mirror: HeapMirror.fromMap(map) });
    const far = FarFieldGpu.empty(device);
    const n = args.dirs.length;
    const dirData = new Float32Array(n * 4);
    args.dirs.forEach((d, i) => dirData.set([d[0], d[1], d[2], 0], i * 4));
    const dirBuffer = device.createBuffer({ size: dirData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(dirBuffer, 0, dirData);
    const configs = args.suns.flatMap((sun) => args.heightsM.map((heightM) => ({ sun, heightM })));
    const out = device.createBuffer({ size: n * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const all = device.createBuffer({ size: configs.length * n * 16, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const frame = new StructWriter(FRAME);
    writeWorldInfo(frame, world);
    const frameBuffer = device.createBuffer({ size: frame.buffer.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const scene = sceneLayout(device);
    const local = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const module = device.createShaderModule({ code: moduleSource(skyTest) });
    const info = await module.getCompilationInfo();
    const compileErrors = info.messages.filter((m) => m.type === 'error').map((m) => `${m.lineNum}:${m.linePos} ${m.message}`);
    if (compileErrors.length) return { compileErrors };
    const pipeline = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [scene, local] }),
      compute: { module, entryPoint: 'main' },
    });
    const extras = sceneExtras(device);
    const sceneBinds = sceneGroup(device, scene, { frame: frameBuffer, world, far, lights: extras.lights, noise: extras.noise, sky: atmosphere.views() });
    const localBinds = device.createBindGroup({ layout: local, entries: [{ binding: 0, resource: { buffer: dirBuffer } }, { binding: 1, resource: { buffer: out } }] });
    const transmittance = await lutValues(atmosphere.transmittance);
    const scattering = await lutValues(atmosphere.scattering);
    const nonFinite = { transmittance: bad(transmittance), scattering: bad(scattering, true), skyView: 0 };
    const irradiance: number[][] = [];
    for (const [k, c] of configs.entries()) {
      const encoder = device.createCommandEncoder();
      atmosphere.update(encoder, { sunDir: c.sun, moonDir: args.moon }, c.heightM);
      atmosphere.writeTo(frame, 'atmosphere');
      device.queue.writeBuffer(frameBuffer, 0, frame.buffer);
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, sceneBinds);
      pass.setBindGroup(1, localBinds);
      pass.dispatchWorkgroups(Math.ceil(n / 64));
      pass.end();
      encoder.copyBufferToBuffer(out, 0, all, k * n * 16, n * 16);
      device.queue.submit([encoder.finish()]);
      irradiance.push(Array.from(new Float32Array(await readBuffer(atmosphere.irradiance, 12 * 16))));
      nonFinite.skyView += bad(await lutValues(atmosphere.skyView));
    }
    const values = new Float32Array(await readBuffer(all, configs.length * n * 16));
    const radiance = configs.map((_, k) => Array.from({ length: n }, (_, i) => Array.from(values.subarray((k * n + i) * 4, (k * n + i) * 4 + 3))));
    for (const b of [world.table, world.sectors, world.heap, world.palette, world.pyramid, dirBuffer, out, all, frameBuffer, extras.lights]) b.destroy();
    far.destroy();
    atmosphere.destroy();
    return { model, radiance, irradiance, transmittance, scattering, bad: nonFinite, errors: [...g.errors] };
  },

  /** fogColour along each of `dirs`, under the sun alone (unit light) at `sun`, from 2 m. */
  async skyFog(args: { dirs: number[][]; sun: number[] }) {
    return sample('fog', args.dirs, { sunDir: args.sun, moonDir: [0, -1, 0], sunLight: [1, 1, 1], moonLight: [0, 0, 0] }, 2);
  },
};
