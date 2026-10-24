import { loadTunables } from '../../../src/core/tunables';
import { HeapMirror } from '../../../src/world/encode';
import { Atmosphere, atmosphereModel } from '../../../src/render/atmosphere';
import { FarFieldGpu } from '../../../src/render/farfield-gpu';
import { FRAME, horizonTerms, PROBE_DUSK, writeCamera, writeHorizon, writeSky, writeWorldInfo, type FrameSky } from '../../../src/render/frame-uniforms';
import { CLOCK_KEYS } from '../../../src/core/sky-clock';
import { BrickMap } from '../../../src/world/bricks';
import { P } from '../../../src/world/materials';
import { Renderer } from '../../../src/render/renderer';
import { frameSky, skyState } from '../../../src/render/sky-state';
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
async function sample(entry: 'main' | 'fog' | 'bodies' | 'farLight', dirs: number[][], sky: Partial<FrameSky> & { sunDir: readonly number[]; moonDir: readonly number[] }, heightM: number, extra?: (frame: StructWriter) => void) {
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
  extra?.(frame);
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
  async skyModel(args: { dirs: number[][]; suns: number[][]; moon: number[]; heightsM: number[]; skyView?: [number, number] }) {
    const g = await gpu();
    const device = g.device;
    const model = atmosphereModel(loadTunables());
    const atmosphere = Atmosphere.create(device, await Atmosphere.compile(device), model);
    // The low preset's smaller sky view, if asked.
    if (args.skyView) atmosphere.resizeSkyView(args.skyView);
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

  /**
   * The colour the height fog glows with at the clock's `hours`, under the frame's sky as the app sets
   * it: looking level `round` degrees round from the key light, then `down` degrees under it.
   */
  async skyHaze(args: { hours: number; round: number[]; down: number[] }) {
    const tun = loadTunables();
    const sky = frameSky(skyState(tun, args.hours), tun);
    const key = Math.atan2(sky.keyDir[0], sky.keyDir[2]);
    const at = (azimuth: number, elevation: number) => [Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation)];
    const rad = Math.PI / 180;
    const dirs = [...args.round.map((d) => at(key + d * rad, 0)), ...args.down.map((d) => at(key, -d * rad))];
    return { ...(await sample('fog', dirs, sky, 2)), dirs, keyDir: [...sky.keyDir], keyColour: [...sky.keyColour] };
  },

  /**
   * The GPU time the atmosphere's LUTs take to build at load (transmittance and multiple scattering,
   * one pass), in ms: the first build's, on a GPU still at its idle clocks, and the median of `runs`
   * builds after `warm` more, at the clocks it settles to; null without timestamp queries.
   */
  async skyBuild(args: { warm: number; runs: number }) {
    const g = await gpu();
    if (!g.timestamps) return { first: null, ms: null, times: [] as number[], errors: [...g.errors] };
    const device = g.device;
    const pipelines = await Atmosphere.compile(device);
    const model = atmosphereModel(loadTunables());
    const times: number[] = [];
    for (let i = 0; i < args.warm + args.runs; i++) {
      const querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
      const resolved = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      const atmosphere = Atmosphere.create(device, pipelines, model, { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 });
      const encoder = device.createCommandEncoder();
      encoder.resolveQuerySet(querySet, 0, 2, resolved, 0);
      device.queue.submit([encoder.finish()]);
      const [t0, t1] = new BigUint64Array(await readBuffer(resolved, 16));
      times.push(Number(t1 - t0) / 1e6);
      atmosphere.destroy();
      querySet.destroy();
      resolved.destroy();
    }
    const settled = times.slice(args.warm).sort((a, b) => a - b);
    return { first: times[0], ms: settled[settled.length >> 1], times, errors: [...g.errors] };
  },

  /** The sky with its discs and stars along each of `dirs`, lit as `sky` says (unit lights unless set), from 2 m. */
  /**
   * Distant shells' flashes as the app sets them, at the clock's `hours`, the eye at `eyeM` (metres):
   * the sky with its bodies and the haze's glow along `dirs`, and the far field's light at each of
   * `points` (metres) facing its normal in `normals`.
   */
  async skyHorizon(args: { hours: number; eyeM: number[]; flashes: { position: number[]; power: number }[]; dirs: number[][]; points: number[][]; normals: number[][] }) {
    const tun = loadTunables();
    const sky = frameSky(skyState(tun, args.hours), tun);
    const voxel = 0.1;
    const extra = (frame: StructWriter) => {
      frame.set('voxel', voxel);
      writeCamera(frame, 'cam', { position: [args.eyeM[0], args.eyeM[1], args.eyeM[2]], yaw: 0, pitch: 0 }, voxel, [0, 0]);
      writeHorizon(frame, horizonTerms(tun), args.flashes.map((f) => ({ position: [f.position[0], f.position[1], f.position[2]] as const, power: f.power })), voxel);
    };
    const bodies = await sample('bodies', args.dirs, sky, args.eyeM[1], extra);
    const fog = await sample('fog', args.dirs, sky, args.eyeM[1], extra);
    const pairs = args.points.flatMap((p, i) => [p.map((m) => m / voxel), args.normals[i]]);
    const far = pairs.length > 0 ? await sample('farLight', pairs, sky, args.eyeM[1], extra) : { compileErrors: [], values: [] as number[][], errors: [] as string[] };
    return {
      compileErrors: [...bodies.compileErrors, ...fog.compileErrors, ...far.compileErrors],
      bodies: bodies.values,
      fog: fog.values,
      far: far.values.slice(0, args.points.length),
      errors: [...bodies.errors, ...fog.errors, ...far.errors],
    };
  },

  async skyBodies(args: { dirs: number[][]; sky: Partial<FrameSky> & { sunDir: number[]; moonDir: number[] } }) {
    return sample('bodies', args.dirs, { sunLight: [0, 0, 0], moonLight: [0, 0, 0], moonFull: [1, 1, 1], ...args.sky }, 2);
  },

  /**
   * The night sky and the noon sky as the renderer draws them, 1024 pixels across 60° (the game's
   * pixel size), looking 60° up over flat ground: how many pixels outshine the sky's median by 4×
   * after `frames` frames; and how far the 30 brightest stars' centres at the middle frame lie from
   * the nearest star at the last.
   */
  async skyStars(args: { frames: number }) {
    const g = await gpu();
    const tun = loadTunables();
    const map = new BrickMap({ x: 64, y: 64, z: 64 });
    map.fillBox(0, 0, 0, 64, 20, 64, P.SOD);
    const world = GpuWorld.create(g.device, { map, mirror: HeapMirror.fromMap(map) });
    const size: [number, number] = [1024, 1024];
    const renderer = await Renderer.create(g, null, world, null, { size });
    renderer.setLights([], 0);
    const pose = { position: [3.2, 3.6, 3.2] as [number, number, number], yaw: 0, pitch: 60, fov: 60 };
    const luminance = (px: number[], i: number) => 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
    const image = async () => Array.from(new Uint16Array(await readTexture(renderer.texture('taa'))), halfToFloat);
    const count = (px: number[]) => {
      const l = Array.from({ length: size[0] * size[1] }, (_, i) => luminance(px, i));
      const median = [...l].sort((a, b) => a - b)[l.length >> 1];
      return { stars: l.filter((v) => v > 4 * median).length, median };
    };
    /** Local maxima over 4× the median, brightest first (the first `limit`): the stars' centres. */
    const centres = (px: number[], median: number, limit = Infinity) => {
      const out: [number, number, number][] = [];
      for (let y = 1; y < size[1] - 1; y++) {
        for (let x = 1; x < size[0] - 1; x++) {
          const v = luminance(px, y * size[0] + x);
          if (v <= 4 * median) continue;
          let peak = true;
          for (let dy = -1; dy <= 1 && peak; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && luminance(px, (y + dy) * size[0] + x + dx) > v) peak = false;
          if (peak) out.push([x, y, v]);
        }
      }
      return out.sort((a, b) => b[2] - a[2]).slice(0, limit);
    };
    const run = async (hours: number) => {
      // The haze stands on this scene's ground, 2 m up, as the game's stands on its own: the eye
      // looks out through it from 1.6 m over the ground, as the player's does.
      renderer.sky = { ...frameSky(skyState(tun, hours), tun), fogBase: 2 };
      renderer.resetHistory();
      let middle: [number, number, number][] = [];
      let px: number[] = [];
      for (let f = 0; f < args.frames; f++) {
        renderer.render(pose, 0, f * 16);
        if (f === (args.frames >> 1) || f === args.frames - 1) {
          px = await image();
          if (f === args.frames >> 1) middle = centres(px, count(px).median, 30);
        }
      }
      const c = count(px);
      const last = centres(px, c.median);
      let shift = 0;
      for (const [x, y] of middle) {
        let best = Infinity;
        for (const [u, v] of last) best = Math.min(best, Math.hypot(u - x, v - y));
        shift = Math.max(shift, best);
      }
      return { ...c, shift, tracked: middle.length };
    };
    const night = await run(CLOCK_KEYS.night);
    const noon = await run(CLOCK_KEYS.noon);
    // 18:23, the sun 3° down: civil twilight.
    const twilight = await run(18 + 23 / 60);
    for (const b of [world.table, world.sectors, world.heap, world.palette, world.pyramid]) b.destroy();
    return { night, noon, twilight, errors: [...g.errors] };
  },
};
