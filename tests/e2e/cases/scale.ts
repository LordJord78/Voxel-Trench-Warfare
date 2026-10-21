import { BrickMap } from '../../../src/world/bricks';
import { HeapMirror } from '../../../src/world/encode';
import { P } from '../../../src/world/materials';
import type { CameraPose } from '../../../src/render/camera';
import { GpuWorld } from '../../../src/render/gpu-world';
import { compileFrame, Renderer } from '../../../src/render/renderer';
import { gpu, readTexture } from '../support/gpu';
import { floatToHalf, halfToFloat } from '../support/half';

const SIZE: [number, number] = [128, 96];
const luma = (px: number[], i: number) => 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];

/** Ground, and a wall in stripes of brick and timber: edges everywhere a misplaced history would show. */
function stripes(): BrickMap {
  const map = new BrickMap({ x: 128, y: 128, z: 128 });
  map.fillBox(0, 0, 0, 128, 40, 128, P.SOD);
  for (let z = 0; z < 128; z += 8) {
    map.fillBox(60, 40, z, 64, 70, z + 4, P.BRICK);
    map.fillBox(60, 40, z + 4, 64, 70, z + 8, P.TIMBER);
  }
  return map;
}

/** Mean brightness difference between TAA's output and the frame it was given, over the image this frame rendered. */
async function stray(r: Renderer): Promise<number> {
  const [w, h] = r.stats.res;
  const width = r.texture('taa').width;
  const taa = Array.from(new Uint16Array(await readTexture(r.texture('taa'))), halfToFloat);
  const colour = Array.from(new Uint16Array(await readTexture(r.texture('colour'))), halfToFloat);
  let sum = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) sum += Math.abs(luma(taa, y * width + x) - luma(colour, y * width + x));
  return sum / (w * h);
}

/** Of the lighting pixels that see the world this frame, the share that kept their history. */
async function keptHistory(r: Renderer): Promise<number> {
  const [w, h] = r.lightResolution;
  const t = r.texture('variance');
  const v = new Float32Array(await readTexture(t));
  let seen = 0;
  let kept = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const length = v[(y * t.width + x) * 2 + 1];
      if (length > 0) seen++;
      if (length > 1.5) kept++;
    }
  }
  return kept / seen;
}

export const cases = {
  /** Still frames at full scale, then one at `scale`: TAA's stray before and after, and the lighting history that survived. */
  async scaleChange(args: { scale: number; frames: number }) {
    const g = await gpu();
    const map = stripes();
    const world = GpuWorld.create(g.device, { map, mirror: HeapMirror.fromMap(map) });
    const r = await Renderer.create(g, null, world, null, { size: SIZE });
    r.setLights([], 0);
    const pose: CameraPose = { position: [8.5, 4.8, 6.4], yaw: -90, pitch: -10 };
    for (let f = 0; f < args.frames; f++) r.render(pose, 0, f);
    const before = await stray(r);
    const keptBefore = await keptHistory(r);
    r.setQuality({ scale: args.scale });
    r.render(pose, 0, args.frames);
    const after = await stray(r);
    const kept = await keptHistory(r);
    const res = r.stats.res;
    for (const b of [world.table, world.sectors, world.heap, world.palette, world.pyramid]) b.destroy();
    return { before, after, keptBefore, kept, res, reset: r.stats.reset, errors: [...g.errors] };
  },

  /**
   * The present pass over a 32 × 32 texture whose top-left 16 × 16 is the image (colour `c`) and
   * the rest stale (colour `stale`): how far any output pixel's green code strays from c's.
   */
  async presentCrop(args: { c: number; stale: number }) {
    const g = await gpu();
    const device = g.device;
    const compiled = await compileFrame(device);
    const size: [number, number] = [32, 32];
    const image = device.createTexture({ size, format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const data = new Uint16Array(32 * 32 * 4);
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const v = floatToHalf(x < 16 && y < 16 ? args.c : args.stale);
        data.set([v, v, v, floatToHalf(1)], (y * 32 + x) * 4);
      }
    }
    device.queue.writeTexture({ texture: image }, data, { bytesPerRow: 32 * 8 }, size);
    const format = navigator.gpu.getPreferredCanvasFormat();
    const target = device.createTexture({ size, format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // The image is 16 × 16 of a 32 × 32 texture, shown on a 32 × 32 canvas.
    device.queue.writeBuffer(uniform, 0, new Float32Array([16, 16, 32, 32, 32, 32, 1, 0]));
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
    const c = halfToFloat(floatToHalf(args.c));
    const aces = Math.min(1, Math.max(0, (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14)));
    const expected = 255 * aces ** (1 / 2.2);
    let worst = 0;
    for (let i = 0; i < 32 * 32; i++) worst = Math.max(worst, Math.abs(bytes[i * 4 + 1] - expected));
    image.destroy();
    target.destroy();
    return { worst, errors: [...g.errors] };
  },
};
