import { BrickMap } from '../../../src/world/bricks';
import { HeapMirror } from '../../../src/world/encode';
import { P } from '../../../src/world/materials';
import { jitter, projectToPixel, rayDir, type CameraPose } from '../../../src/render/camera';
import { FarFieldGpu } from '../../../src/render/farfield-gpu';
import { FLAGS, FRAME, PROBE_DUSK, writeWorldInfo } from '../../../src/render/frame-uniforms';
import { GpuWorld } from '../../../src/render/gpu-world';
import { StructWriter } from '../../../src/render/layout';
import { compileFrame, Renderer } from '../../../src/render/renderer';
import { sceneGroup } from '../../../src/render/scene';
import { moduleSource } from '../../../src/render/shaders';
import { Rng } from '../../../src/core/rng';
import { gpu, readTexture } from '../support/gpu';
import { floatToHalf, halfToFloat } from '../support/half';
import { traceRef } from '../../support/trace-ref';
import atrousReference from '../shaders/atrous-reference.wgsl';

/**
 * A floor with a wall standing on it, lit by a key light from 45° in -x: the
 * wall's shadow lies across the floor beside it. The camera looks straight
 * down at the shadow's edge.
 */
function world(): BrickMap {
  const map = new BrickMap({ x: 128, y: 128, z: 128 });
  map.fillBox(0, 0, 0, 128, 40, 128, P.SOD);
  map.fillBox(60, 40, 0, 64, 70, 128, P.BRICK);
  return map;
}

const DOWN: CameraPose = { position: [5.6, 9.0, 6.4], yaw: 0, pitch: -89.9 };

async function setup(g: Awaited<ReturnType<typeof gpu>>) {
  const map = world();
  const w = GpuWorld.create(g.device, { map, mirror: HeapMirror.fromMap(map) });
  const r = await Renderer.create(g, null, w, null, { size: [96, 96] });
  const el = Math.PI / 4;
  r.sky = { ...PROBE_DUSK, keyDir: [-Math.cos(el), Math.sin(el), 0], keyColour: [1, 1, 1], ambient: 1 };
  r.setLights([], 0);
  return { r, w };
}

/**
 * Lighting pixels whose 2 × 2 block of the internal image lies on one face of
 * one plane. A block straddling two surfaces represents one of them each
 * frame, so its own value alternates; the upsampler sorts that out per pixel.
 */
async function wholeBlocks(r: Renderer): Promise<Uint8Array> {
  const hit = new Uint32Array(await readTexture(r.texture('gHit')));
  const [w, h] = [r.stats.res[0], r.stats.res[1]];
  const [lw, lh] = r.lightResolution;
  const key = (i: number) => {
    const face = (hit[i * 2] >>> 24) & 7;
    const cell = [hit[i * 2] & 0xfff, hit[i * 2 + 1] & 0xffff, (hit[i * 2] >>> 12) & 0xfff];
    return face >= 6 ? -1 : face * 100000 + cell[face >> 1] + (face & 1);
  };
  const out = new Uint8Array(lw * lh);
  for (let qy = 0; qy < lh; qy++) {
    for (let qx = 0; qx < lw; qx++) {
      const keys = [0, 1, 2, 3].map((k) => key(Math.min(qy * 2 + (k >> 1), h - 1) * w + Math.min(qx * 2 + (k & 1), w - 1)));
      out[qy * lw + qx] = keys[0] >= 0 && keys.every((k) => k === keys[0]) ? 1 : 0;
    }
  }
  return out;
}

const rgba = async (r: Renderer, name: string) => {
  const raw = new Uint16Array(await readTexture(r.texture(name)));
  return Array.from(raw, halfToFloat);
};

export const cases = {
  /** The denoised key visibility after `frames` still frames, against a long plain average of the raw lighting. */
  async denoiseConverge(args: { frames: number; reference: number }) {
    const g = await gpu();
    const { r, w } = await setup(g);
    const [lw, lh] = r.lightResolution;
    const raw = new Float64Array(lw * lh);
    for (let f = 0; f < args.reference; f++) {
      r.render(DOWN, 0, f);
      const noisy = await rgba(r, 'lNoisy');
      for (let i = 0; i < lw * lh; i++) raw[i] += noisy[i * 4 + 3];
    }
    r.flags = FLAGS.HISTORY_RESET;
    r.render(DOWN, 0, 0);
    r.flags = 0;
    let previous: number[] = [];
    let change = 0;
    for (let f = 0; f < args.frames; f++) {
      r.render(DOWN, 0, f);
      if (f >= args.frames - 2) {
        const out = await rgba(r, 'denoised');
        if (previous.length) {
          let sum = 0;
          for (let i = 0; i < lw * lh; i++) sum += Math.abs(out[i * 4 + 3] - previous[i * 4 + 3]);
          change = sum / (lw * lh);
        }
        previous = out;
      }
    }
    const whole = await wholeBlocks(r);
    const rng = Rng.root(7);
    let worst = 0;
    let compared = 0;
    const bad: string[] = [];
    while (compared < 200) {
      const i = rng.randint(0, lw * lh - 1);
      if (!whole[i]) continue;
      compared++;
      const e = Math.abs(previous[i * 4 + 3] - raw[i] / args.reference);
      worst = Math.max(worst, e);
      if (e > 0.05 && bad.length < 6) bad.push(`q ${i % lw},${Math.floor(i / lw)} denoised ${previous[i * 4 + 3].toFixed(3)} raw ${(raw[i] / args.reference).toFixed(3)}`);
    }
    for (const b of [w.table, w.sectors, w.heap, w.palette, w.pyramid]) b.destroy();
    return { worst, change, bad, errors: [...g.errors] };
  },

  /**
   * The sky's history, traced every other frame: after `frames` still frames, each whole-block
   * pixel's sky visibility history (hMoments.w) against the plain average of every sky sample it
   * traced over `reference` frames. The mean and mean absolute differences.
   */
  async skyHistory(args: { frames: number; reference: number }) {
    const g = await gpu();
    const { r, w } = await setup(g);
    const [lw, lh] = r.lightResolution;
    const sum = new Float64Array(lw * lh);
    const count = new Float64Array(lw * lh);
    for (let f = 0; f < args.reference; f++) {
      r.render(DOWN, 0, f);
      const sky = new Float32Array(await readTexture(r.texture('lSky')));
      for (let i = 0; i < lw * lh; i++) {
        if (sky[i] < 0) continue;
        sum[i] += sky[i];
        count[i]++;
      }
    }
    r.flags = FLAGS.HISTORY_RESET;
    r.render(DOWN, 0, 0);
    r.flags = 0;
    for (let f = 0; f < args.frames; f++) r.render(DOWN, 0, f);
    const moments = await rgba(r, 'hMoments');
    const whole = await wholeBlocks(r);
    let bias = 0;
    let mae = 0;
    let n = 0;
    for (let i = 0; i < lw * lh; i++) {
      if (!whole[i] || count[i] === 0) continue;
      const d = moments[i * 4 + 3] - sum[i] / count[i];
      bias += d;
      mae += Math.abs(d);
      n++;
    }
    for (const b of [w.table, w.sectors, w.heap, w.palette, w.pyramid]) b.destroy();
    return { compared: n, bias: bias / n, mae: mae / n, errors: [...g.errors] };
  },

  /**
   * History lengths after the camera slides past the wall's top. Whether each
   * surface point was hidden last frame is decided on the CPU: a ray from the
   * previous camera to the point either reaches it or hits something first.
   */
  async denoiseDisocclusion() {
    const g = await gpu();
    const { r, w } = await setup(g);
    const map = world();
    const side: CameraPose = { position: [7.5, 5.5, 6.4], yaw: -90, pitch: -30 };
    for (let f = 0; f < 32; f++) r.render(side, 0, f);
    const moved: CameraPose = { ...side, position: [7.5, 5.5, 5.9] };
    r.render(moved, 0, 32);
    const whole = await wholeBlocks(r);
    const depth = new Float32Array(await readTexture(r.texture('hDepth')));
    const hit = new Uint32Array(await readTexture(r.texture('hHit')));
    const moments = await rgba(r, 'hMoments');
    const [lw, lh] = r.lightResolution;
    const res: [number, number] = [96, 96];
    const [jx, jy] = jitter(32);
    let hidden = 0;
    let hiddenFresh = 0;
    let seen = 0;
    let seenOld = 0;
    const lost: string[] = [];
    for (let qy = 0; qy < lh; qy++) {
      for (let qx = 0; qx < lw; qx++) {
        const i = qy * lw + qx;
        if (((hit[i * 2] >>> 24) & 7) >= 6 || !whole[i]) continue;
        // Frame 32's representative is the block's top-left pixel.
        const px = Math.min(qx * 2, res[0] - 1);
        const py = Math.min(qy * 2, res[1] - 1);
        const d = rayDir(moved, res, px + 0.5 + jx, py + 0.5 + jy);
        const o = moved.position.map((m) => m / 0.1);
        const at = [o[0] + d[0] * depth[i], o[1] + d[1] * depth[i], o[2] + d[2] * depth[i]];
        const from = side.position.map((m) => m / 0.1);
        // Seen from last frame's camera: the ray to the point reaches it.
        const reaches = (pt: number[]) => {
          const to = [pt[0] - from[0], pt[1] - from[1], pt[2] - from[2]];
          const dist = Math.hypot(to[0], to[1], to[2]);
          const back = traceRef(map, from as [number, number, number], [to[0] / dist, to[1] / dist, to[2] / dist], dist + 1);
          const before = projectToPixel(side, res, pt.map((v) => v * 0.1) as [number, number, number]);
          const inView = before !== null && before[0] >= 0 && before[1] >= 0 && before[0] < res[0] && before[1] < res[1];
          return inView && back.hit && Math.abs(back.t - dist) <= 0.5;
        };
        // The shader treats last frame's samples within `reach` on the same plane as the same
        // spot (see temporal.wgsl); a point is plainly uncovered when it and everything within
        // that reach on its plane was out of sight.
        const reach = Math.max(1.5, (2.5 * depth[i] * 2) / res[0] * 2);
        const axis = ((hit[i * 2] >>> 24) & 7) >> 1;
        const along = [0, 1, 2].filter((k) => k !== axis);
        const around = [at, ...along.flatMap((k) => [-reach, reach].map((dk) => at.map((v, c) => (c === k ? v + dk : v))))];
        const length = moments[i * 4 + 2];
        if (!reaches(at)) {
          if (around.every((pt) => !reaches(pt))) {
            hidden++;
            if (length <= 1.01) hiddenFresh++;
          }
          continue;
        }
        seen++;
        if (length >= 2) seenOld++;
        else if (lost.length < 10) lost.push(`q ${qx},${qy} face ${(hit[i * 2] >>> 24) & 7} length ${length}`);
      }
    }
    for (const b of [w.table, w.sectors, w.heap, w.palette, w.pyramid]) b.destroy();
    return { hidden, hiddenFresh, seen, seenOld, lost, errors: [...g.errors] };
  },

  /** After convergence, the key visibility on the shadowed wall face beside the lit floor. */
  async denoiseEdges() {
    const g = await gpu();
    const { r, w } = await setup(g);
    // Looking at the wall's shadowed +x face, with the lit floor below it.
    const view: CameraPose = { position: [8.5, 4.6, 6.4], yaw: -90, pitch: -12 };
    for (let f = 0; f < 96; f++) r.render(view, 0, f);
    const out = await rgba(r, 'denoised');
    const hit = new Uint32Array(await readTexture(r.texture('hHit')));
    const [lw, lh] = r.lightResolution;
    let worstWall = 0;
    let wallNearFloor = 0;
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        const i = y * lw + x;
        if (((hit[i * 2] >>> 24) & 7) !== 1) continue;
        // Within two lighting pixels of a floor (+y) pixel.
        let near = false;
        for (let dy = -2; dy <= 2 && !near; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= lw || yy >= lh) continue;
            if (((hit[(yy * lw + xx) * 2] >>> 24) & 7) === 3) near = true;
          }
        }
        if (!near) continue;
        wallNearFloor++;
        worstWall = Math.max(worstWall, out[i * 4 + 3]);
      }
    }
    for (const b of [w.table, w.sectors, w.heap, w.palette, w.pyramid]) b.destroy();
    return { worstWall, wallNearFloor, errors: [...g.errors] };
  },

  /** Every history length the frame after a reset. */
  /**
   * A wide (8°) key light, so the wall's shadow has a penumbra a metre across: converge, then
   * start the history afresh and filter one frame. Of the penumbra's lighting pixels (converged
   * key visibility 0.2 to 0.8, whole blocks), how many the filter left as raw 0s and 1s, and
   * their mean distance from the converged value.
   */
  async denoiseFresh() {
    const g = await gpu();
    const { r, w } = await setup(g);
    r.sky = { ...r.sky, keyCone: (8 * Math.PI) / 180 };
    for (let f = 0; f < 64; f++) r.render(DOWN, 0, f);
    const converged = await rgba(r, 'hColour');
    const whole = await wholeBlocks(r);
    r.flags = FLAGS.HISTORY_RESET;
    r.render(DOWN, 0, 64);
    r.flags = 0;
    const fresh = await rgba(r, 'denoised');
    let penumbra = 0;
    let binary = 0;
    let error = 0;
    for (let i = 0; i < whole.length; i++) {
      const a = converged[i * 4 + 3];
      if (!whole[i] || a < 0.2 || a > 0.8) continue;
      penumbra++;
      const v = fresh[i * 4 + 3];
      if (v < 0.02 || v > 0.98) binary++;
      error += Math.abs(v - a);
    }
    for (const b of [w.table, w.sectors, w.heap, w.palette, w.pyramid]) b.destroy();
    return { penumbra, binary, error: error / penumbra, errors: [...g.errors] };
  },

  async denoiseReset() {
    const g = await gpu();
    const { r, w } = await setup(g);
    for (let f = 0; f < 16; f++) r.render(DOWN, 0, f);
    r.flags = FLAGS.HISTORY_RESET;
    r.render(DOWN, 0, 16);
    r.flags = 0;
    const moments = await rgba(r, 'hMoments');
    const hit = new Uint32Array(await readTexture(r.texture('hHit')));
    let surfaces = 0;
    let longest = 0;
    for (let i = 0; i < hit.length / 2; i++) {
      if (((hit[i * 2] >>> 24) & 7) >= 6) continue;
      surfaces++;
      longest = Math.max(longest, moments[i * 4 + 2]);
    }
    for (const b of [w.table, w.sectors, w.heap, w.palette, w.pyramid]) b.destroy();
    return { surfaces, longest, errors: [...g.errors] };
  },

  /**
   * One à-trous pass at each step over a fixed noisy lighting image (73 × 51, so edge tiles are
   * partial) with face and plane edges: the production shader against a copy of the shader as
   * it was. The worst difference per channel, in f16 ulps for colour and relative for variance.
   */
  async atrousIdentity() {
    const g = await gpu();
    const device = g.device;
    const compiled = await compileFrame(device);
    const module = device.createShaderModule({ code: moduleSource(atrousReference) });
    const reference = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [compiled.scene, compiled.layouts.atrous] }),
      compute: { module, entryPoint: 'main' },
    });
    const size: [number, number] = [73, 51];
    const n = size[0] * size[1];
    const rng = Rng.root(11).derive('atrous');
    const colour = new Uint16Array(n * 4);
    const variance = new Float32Array(n * 2);
    const hits = new Uint32Array(n * 2);
    for (let y = 0; y < size[1]; y++) {
      for (let x = 0; x < size[0]; x++) {
        const i = y * size[0] + x;
        // Three surfaces: a floor at two planes split by a step, and a wall on the right.
        const face = x > 52 ? 1 : 3;
        const plane = face === 1 ? 52 : x < 26 ? 40 : 41;
        const cell = face === 1 ? [52, y, x] : [x, plane - 1, y];
        hits.set([(cell[0] | (cell[2] << 12) | (face << 24)) >>> 0, cell[1] | (5 << 16)], i * 2);
        const key = x < 30 ? (rng.uniform() < 0.5 ? 1 : 0) : rng.uniform();
        const lum = 0.2 + rng.uniform() * (y > 25 ? 2 : 0.3);
        colour.set([lum, lum * 0.8, lum * 0.6, key].map(floatToHalf), i * 4);
        variance.set([rng.uniform() * 0.05, 1 + rng.randint(0, 31)], i * 2);
      }
    }
    const tex = (format: GPUTextureFormat, usage: number) => device.createTexture({ size, format, usage });
    const inUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    const outUsage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC;
    const colourIn = tex('rgba16float', inUsage);
    const varianceIn = tex('rg32float', inUsage);
    const hitsIn = tex('rg32uint', inUsage);
    device.queue.writeTexture({ texture: colourIn }, colour, { bytesPerRow: size[0] * 8 }, size);
    device.queue.writeTexture({ texture: varianceIn }, variance, { bytesPerRow: size[0] * 8 }, size);
    device.queue.writeTexture({ texture: hitsIn }, hits, { bytesPerRow: size[0] * 8 }, size);
    const map = new BrickMap({ x: 32, y: 32, z: 32 });
    const world = GpuWorld.create(device, { map, mirror: HeapMirror.fromMap(map) });
    const writer = new StructWriter(FRAME);
    writeWorldInfo(writer, world);
    writer.set('res', [size[0] * 2, size[1] * 2]);
    writer.set('alloc', [size[0] * 2, size[1] * 2]);
    writer.set('lightRes', size);
    writer.set('lightScale', 2);
    writer.set('sigmaLuma', 4);
    writer.set('sigmaPlane', 1);
    const frame = device.createBuffer({ size: writer.buffer.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(frame, 0, writer.buffer);
    const scene = sceneGroup(device, compiled.scene, { frame, world, far: FarFieldGpu.empty(device), lights: compiled.lights, noise: compiled.noise, sky: compiled.sky });
    const run = async (pipeline: GPUComputePipeline, step: number) => {
      const colourOut = tex('rgba16float', outUsage);
      const varianceOut = tex('rg32float', outUsage);
      const stepBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(stepBuffer, 0, new Int32Array([step, 0, 0, 0]));
      const group = device.createBindGroup({
        layout: compiled.layouts.atrous,
        entries: [colourIn.createView(), varianceIn.createView(), hitsIn.createView(), colourOut.createView(), varianceOut.createView(), { buffer: stepBuffer }].map((resource, binding) => ({ binding, resource })),
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, scene);
      pass.setBindGroup(1, group);
      pass.dispatchWorkgroups(Math.ceil(size[0] / 8), Math.ceil(size[1] / 8));
      pass.end();
      device.queue.submit([encoder.finish()]);
      const c = new Uint16Array(await readTexture(colourOut));
      const v = new Float32Array(await readTexture(varianceOut));
      colourOut.destroy();
      varianceOut.destroy();
      return { c, v };
    };
    const worst = { colourUlps: 0, varianceRel: 0 };
    for (const step of [1, 2, 4]) {
      const a = await run(compiled.pipelines.atrous, step);
      const b = await run(reference, step);
      for (let i = 0; i < a.c.length; i++) worst.colourUlps = Math.max(worst.colourUlps, Math.abs(a.c[i] - b.c[i]));
      for (let i = 0; i < a.v.length; i++) worst.varianceRel = Math.max(worst.varianceRel, Math.abs(a.v[i] - b.v[i]) / Math.max(1e-6, Math.abs(b.v[i])));
    }
    for (const t of [colourIn, varianceIn, hitsIn]) t.destroy();
    return { ...worst, errors: [...g.errors] };
  },
};
