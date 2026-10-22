import { BrickMap } from '../../../src/world/bricks';
import { HeapMirror } from '../../../src/world/encode';
import { P } from '../../../src/world/materials';
import { jitter, projectToPixel, type CameraPose } from '../../../src/render/camera';
import { CAMERA, FLAGS, FRAME, PROBE_DUSK, type FrameSky } from '../../../src/render/frame-uniforms';
import { structLayout } from '../../../src/render/layout';
import { GpuWorld } from '../../../src/render/gpu-world';
import { compileFrame, Renderer } from '../../../src/render/renderer';
import { gpu, readTexture } from '../support/gpu';
import { floatToHalf, halfToFloat } from '../support/half';

const luma = (px: number[], i: number) => 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
const rgba = async (t: GPUTexture) => Array.from(new Uint16Array(await readTexture(t)), halfToFloat);

/** ACES fit, as present.wgsl. */
const aces = (x: number) => Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));

export const cases = {
  /** Four frames, the third unjittered: each frame's own jitter and the jitter it says the last frame applied. */
  async frameJitters() {
    const g = await gpu();
    const map = new BrickMap({ x: 32, y: 32, z: 32 });
    map.fillBox(0, 0, 0, 32, 8, 32, P.SOD);
    const world = GpuWorld.create(g.device, { map, mirror: HeapMirror.fromMap(map) });
    const r = await Renderer.create(g, null, world, null, { size: [32, 32] });
    r.setLights([], 0);
    // A camera's jitter: the camera's offset in the frame plus the jitter's in the camera.
    const at = (camera: 'cam' | 'prev') => structLayout(FRAME).offsets[camera] + structLayout(CAMERA).offsets.jitter;
    const read = (camera: 'cam' | 'prev') => Array.from(new Float32Array(r.frameUniform(), at(camera), 2));
    const frames: { cam: number[]; prev: number[] }[] = [];
    for (let f = 0; f < 4; f++) {
      r.flags = f === 2 ? FLAGS.JITTER_OFF : 0;
      r.render({ position: [1.6, 1.5, 1.6], yaw: 0, pitch: -20 }, 0, f);
      frames.push({ cam: read('cam'), prev: read('prev') });
    }
    for (const b of [world.table, world.sectors, world.heap, world.palette, world.pyramid]) b.destroy();
    const halton = [0, 1, 2, 3].map((f) => Array.from(new Float32Array(jitter(f))));
    return { frames, halton, errors: [...g.errors] };
  },

  /** Mean frame-to-frame change of the TAA output after `frames` still frames. */
  async taaSettle(args: { frames: number }) {
    const g = await gpu();
    const map = new BrickMap({ x: 128, y: 128, z: 128 });
    map.fillBox(0, 0, 0, 128, 40, 128, P.SOD);
    map.fillBox(60, 40, 0, 64, 70, 128, P.BRICK);
    const world = GpuWorld.create(g.device, { map, mirror: HeapMirror.fromMap(map) });
    const r = await Renderer.create(g, null, world, null, { size: [128, 96] });
    r.setLights([], 0);
    const pose: CameraPose = { position: [8.5, 4.8, 6.4], yaw: -90, pitch: -10 };
    let before: number[] = [];
    let change = 0;
    for (let f = 0; f < args.frames; f++) {
      r.render(pose, 0, f);
      if (f >= args.frames - 2) {
        const now = await rgba(r.texture('taa'));
        if (before.length) {
          let sum = 0;
          for (let i = 0; i < now.length; i += 4) sum += Math.abs(luma(now, i / 4) - luma(before, i / 4));
          change = sum / (now.length / 4);
        }
        before = now;
      }
    }
    for (const b of [world.table, world.sectors, world.heap, world.palette, world.pyramid]) b.destroy();
    return { change, errors: [...g.errors] };
  },

  /** A bright column crossing the dark night sky at 4 px a frame: the brightest pixel left behind it, against the column's own. */
  async taaTrail() {
    const g = await gpu();
    const map = new BrickMap({ x: 128, y: 128, z: 128 });
    map.fillBox(60, 30, 100, 62, 110, 102, P.LANTERN_GLOW);
    const world = GpuWorld.create(g.device, { map, mirror: HeapMirror.fromMap(map) });
    const res: [number, number] = [128, 96];
    const r = await Renderer.create(g, null, world, null, { size: res });
    const night: FrameSky = { ...PROBE_DUSK, keyColour: [0, 0, 0], sunLight: [0, 0, 0], moonLight: [0, 0, 0], fogDensity: 0, smokeDensity: 0 };
    r.sky = night;
    r.setLights([], 0);
    const d = 6.4;
    const step = (4 * d * 2) / res[0];
    const pose = (f: number): CameraPose => ({ position: [6.1 - 3 * step + f * step, 7.0, 10.1 - d], yaw: 0, pitch: 0 });
    const frames = 14;
    for (let f = 0; f < frames; f++) r.render(pose(f), 0, f);
    const px = await rgba(r.texture('taa'));
    const centre = (f: number) => projectToPixel(pose(f), res, [6.1, 7.0, 10.1])![0];
    const nowX = centre(frames - 1);
    const thenX = centre(frames - 4);
    const row = 48;
    let column = 0;
    for (let x = Math.floor(nowX) - 1; x <= Math.floor(nowX) + 1; x++) column = Math.max(column, luma(px, row * res[0] + x));
    let trail = 0;
    const [a, b] = nowX < thenX ? [nowX + 3, thenX + 2] : [thenX - 2, nowX - 3];
    for (let x = Math.ceil(a); x <= Math.floor(b); x++) if (x >= 0 && x < res[0]) trail = Math.max(trail, luma(px, row * res[0] + x));
    for (const t of [world.table, world.sectors, world.heap, world.palette, world.pyramid]) t.destroy();
    return { column, trail, nowX, thenX, errors: [...g.errors] };
  },

  /**
   * The present pass over a flat 32 × 32 image of colour `c` (with, if given, one texel of `spot` in
   * the middle), upscaled to a `canvas`-wide square: the 8-bit codes it writes, and what ACES and
   * gamma say the flat colour's should be.
   */
  async present(args: { c: number; exposure: number; spot?: number; canvas?: number }) {
    const g = await gpu();
    const device = g.device;
    const compiled = await compileFrame(device);
    const size: [number, number] = [32, 32];
    const image = device.createTexture({ size, format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const h = floatToHalf(args.c);
    const texels = new Uint16Array(32 * 32 * 4).map((_, i) => (i % 4 === 3 ? floatToHalf(1) : h));
    if (args.spot !== undefined) texels.fill(floatToHalf(args.spot), (16 * 32 + 16) * 4, (16 * 32 + 16) * 4 + 3);
    device.queue.writeTexture({ texture: image }, texels, { bytesPerRow: 32 * 8 }, size);
    const format = navigator.gpu.getPreferredCanvasFormat();
    const side = args.canvas ?? 32;
    const target = device.createTexture({ size: [side, side], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uniform, 0, new Float32Array([32, 32, 32, 32, side, side, args.exposure, 0]));
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const group = device.createBindGroup({
      layout: compiled.layouts.present,
      entries: [image.createView(), sampler, { buffer: uniform }, compiled.noise.createView()].map((resource, binding) => ({ binding, resource })),
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    pass.setPipeline(compiled.pipelines.present);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    const bytes = new Uint8Array(await readTexture(target));
    const green = Array.from({ length: side * side }, (_, i) => bytes[i * 4 + 1]);
    const c = halfToFloat(h) * args.exposure;
    const expected = 255 * aces(c) ** (1 / 2.2);
    image.destroy();
    target.destroy();
    return { green, expected, errors: [...g.errors] };
  },

  /** CAS over a flat image: how far any output pixel strays from the input colour. */
  async casFlat(args: { c: number[] }) {
    const g = await gpu();
    const map = new BrickMap({ x: 32, y: 32, z: 32 });
    const world = GpuWorld.create(g.device, { map, mirror: HeapMirror.fromMap(map) });
    const r = await Renderer.create(g, null, world, null, { size: [32, 32], sharpness: 1 });
    const device = g.device;
    const compiled = await compileFrame(device);
    const input = device.createTexture({ size: [32, 32], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const out = device.createTexture({ size: [32, 32], format: 'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
    const hc = args.c.map(floatToHalf);
    device.queue.writeTexture({ texture: input }, new Uint16Array(32 * 32 * 4).map((_, i) => (i % 4 === 3 ? floatToHalf(1) : hc[i % 4])), { bytesPerRow: 32 * 8 }, [32, 32]);
    // Render once so the renderer's frame uniform (resolution, sharpness) is written, then run CAS alone with it.
    r.render({ position: [1, 1, 1], yaw: 0, pitch: 0 }, 0, 0);
    const group = device.createBindGroup({ layout: compiled.layouts.cas, entries: [input.createView(), out.createView()].map((resource, binding) => ({ binding, resource })) });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(compiled.pipelines.cas);
    pass.setBindGroup(0, r.sceneBindGroup());
    pass.setBindGroup(1, group);
    pass.dispatchWorkgroups(4, 4);
    pass.end();
    device.queue.submit([encoder.finish()]);
    const px = await rgba(out);
    let worst = 0;
    for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(px[i + c] - halfToFloat(hc[c])));
    for (const b of [world.table, world.sectors, world.heap, world.palette, world.pyramid]) b.destroy();
    return { worst, errors: [...g.errors] };
  },

  /**
   * TAA over a flat 0.5 image with one NaN pixel and a 3 × 3 block of -2: how many outputs are not
   * finite, what the NaN pixel became, and the range the block's outputs span.
   */
  async taaHardening() {
    const g = await gpu();
    const device = g.device;
    const map = new BrickMap({ x: 32, y: 32, z: 32 });
    const world = GpuWorld.create(device, { map, mirror: HeapMirror.fromMap(map) });
    const r = await Renderer.create(g, null, world, null, { size: [32, 32] });
    // Two frames, so the frame uniform no longer starts the history afresh.
    r.render({ position: [1, 1, 1], yaw: 0, pitch: 0 }, 0, 0);
    r.render({ position: [1, 1, 1], yaw: 0, pitch: 0 }, 0, 1);
    const compiled = await compileFrame(device);
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    const tex = (format: GPUTextureFormat, u = usage) => device.createTexture({ size: [32, 32], format, usage: u });
    const current = tex('rgba16float');
    const motion = tex('rgba16float');
    const history = tex('rgba16float');
    const out = tex('rgba16float', GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC);
    const half = floatToHalf(0.5);
    const flat = () => new Uint16Array(32 * 32 * 4).map((_, i) => (i % 4 === 3 ? floatToHalf(1) : half));
    const image = flat();
    const set = (x: number, y: number, v: number) => image.set([v, v, v, floatToHalf(1)], (y * 32 + x) * 4);
    set(10, 10, 0x7e00);
    for (let y = 20; y <= 22; y++) for (let x = 20; x <= 22; x++) set(x, y, floatToHalf(-2));
    device.queue.writeTexture({ texture: current }, image, { bytesPerRow: 32 * 8 }, [32, 32]);
    device.queue.writeTexture({ texture: motion }, new Uint16Array(32 * 32 * 4), { bytesPerRow: 32 * 8 }, [32, 32]);
    device.queue.writeTexture({ texture: history }, flat(), { bytesPerRow: 32 * 8 }, [32, 32]);
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const group = device.createBindGroup({
      layout: compiled.layouts.taa,
      entries: [current.createView(), motion.createView(), history.createView(), out.createView(), sampler].map((resource, binding) => ({ binding, resource })),
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(compiled.pipelines.taa);
    pass.setBindGroup(0, r.sceneBindGroup());
    pass.setBindGroup(1, group);
    pass.dispatchWorkgroups(4, 4);
    pass.end();
    device.queue.submit([encoder.finish()]);
    const px = await rgba(out);
    let nonFinite = 0;
    for (const v of px) if (!Number.isFinite(v)) nonFinite++;
    const at = (x: number, y: number) => px[(y * 32 + x) * 4];
    let lo = Infinity;
    let hi = -Infinity;
    for (let y = 20; y <= 22; y++) for (let x = 20; x <= 22; x++) {
      lo = Math.min(lo, at(x, y));
      hi = Math.max(hi, at(x, y));
    }
    for (const t of [current, motion, history, out]) t.destroy();
    for (const b of [world.table, world.sectors, world.heap, world.palette, world.pyramid]) b.destroy();
    return { nonFinite, nanPixel: at(10, 10), blockLo: lo, blockHi: hi, errors: [...g.errors] };
  },
};
