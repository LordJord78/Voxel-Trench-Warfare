import { BrickMap } from '../../../src/world/bricks';
import { HeapMirror } from '../../../src/world/encode';
import { K, P, kindOf, paletteData } from '../../../src/world/materials';
import { loadTunables } from '../../../src/core/tunables';
import { atmosphereModel, writeAtmosphere } from '../../../src/render/atmosphere';
import { rayDir, type CameraPose } from '../../../src/render/camera';
import { FarFieldGpu } from '../../../src/render/farfield-gpu';
import { FLAGS, FRAME, PROBE_DUSK, writeCamera, writeSky, writeWorldInfo, type FrameSky } from '../../../src/render/frame-uniforms';
import { GpuWorld } from '../../../src/render/gpu-world';
import { StructWriter } from '../../../src/render/layout';
import { compileFrame } from '../../../src/render/renderer';
import { sceneGroup, type SkyLuts } from '../../../src/render/scene';
import { gpu, readTexture } from '../support/gpu';
import { floatToHalf, halfToFloat } from '../support/half';

type V3 = [number, number, number];

/** One 4 × 4-pixel region of the test image: what the G-buffer and the (uniform) lighting say there. */
export interface Region {
  mat: number;
  face: number;
  cell: V3;
  /** Voxels along the ray. 1e9 with face 7 is sky. */
  depth: number;
  light: [number, number, number, number];
}

const RES: [number, number] = [16, 16];

// The shader's formulas, in TypeScript: the reference every region is checked against.
function hash3(x: number, y: number, z: number): number {
  let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// The sky the case binds: the same radiance in every direction, per unit of each light (sun, moon),
// as its one-texel sky-view layers hold it (times LUT_SCALE, in half floats).
const LUT_SCALE = 16384;
const SKY_UNIT = [
  [0.02, 0.03, 0.05],
  [0.01, 0.012, 0.02],
].map((layer) => layer.map((v) => halfToFloat(floatToHalf(v * LUT_SCALE)) / LUT_SCALE));

/** The sky in any direction, before the moon's disc. */
function skyLight(sky: FrameSky): number[] {
  return [0, 1, 2].map((c) => sky.sunLight[c] * SKY_UNIT[0][c] + sky.moonLight[c] * SKY_UNIT[1][c]);
}

/**
 * What the haze (the fog and the smoke) glows with looking along rd: the key's light all round and
 * more toward it, and the front's; this case's sky puts no light on faces, so none from above.
 */
function hazeRef(sky: FrameSky, rd: readonly number[]): number[] {
  const c = Math.max(dot(rd, sky.keyDir), 0);
  return [0, 1, 2].map((k) => sky.keyColour[k] * (sky.hazeKey + sky.hazeForward * c ** 4) + sky.frontGlow[k]);
}

function skyRef(sky: FrameSky, rd: readonly number[]): number[] {
  const moon = smooth(Math.cos((0.55 * Math.PI) / 180), Math.cos((0.45 * Math.PI) / 180), dot(rd, sky.moonDir));
  const light = skyLight(sky);
  return [0, 1, 2].map((c) => light[c] + sky.moonColour[c] * 40 * moon);
}

/** One-texel sky views holding SKY_UNIT, and no light on faces from them. */
function constantSky(device: GPUDevice): SkyLuts {
  const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
  const skyView = device.createTexture({ size: [1, 1, 2], format: 'rgba16float', usage });
  SKY_UNIT.forEach((layer, k) => {
    const texel = new Uint16Array([...layer.map((v) => floatToHalf(v * LUT_SCALE)), floatToHalf(1)]);
    device.queue.writeTexture({ texture: skyView, origin: [0, 0, k] }, texel, { bytesPerRow: 8 }, [1, 1, 1]);
  });
  const flat = () => device.createTexture({ size: [1, 1], format: 'rgba16float', usage }).createView();
  return {
    transmittance: flat(),
    scattering: flat(),
    skyView: skyView.createView({ dimension: '2d-array' }),
    sampler: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
    irradiance: device.createBuffer({ size: 12 * 16, usage: GPUBufferUsage.STORAGE }),
  };
}

export function shadeRef(r: Region, pose: CameraPose, px: number, py: number, sky: FrameSky, voxel = 0.1): number[] {
  const rd = rayDir(pose, RES, px + 0.5, py + 0.5);
  const pal = paletteData();
  let colour: number[];
  let metres = 2000;
  if (r.face === 7) {
    colour = skyRef(sky, rd);
  } else {
    metres = r.depth * voxel;
    const v = hash3(r.cell[0], r.cell[1], r.cell[2]);
    const fine = 0.84 + (0.28 * (v & 255)) / 255;
    const blotch = 0.9 + (0.2 * (hash3(r.cell[0] >> 2, r.cell[1] >> 2, r.cell[2] >> 2) & 255)) / 255;
    const tint = [1 + 0.05 * (((v >>> 8) & 255) / 255 - 0.5), 1, 1 + 0.05 * (((v >>> 16) & 255) / 255 - 0.5)];
    const albedo = [0, 1, 2].map((c) => pal[r.mat * 8 + c] * fine * blotch * tint[c]);
    const n = [0, 0, 0];
    n[r.face >> 1] = r.face & 1 ? 1 : -1;
    const ndl = Math.max(dot(n, sky.keyDir), 0);
    const lit = [0, 1, 2].map((c) => sky.keyColour[c] * r.light[3] * ndl + r.light[c]);
    colour = [0, 1, 2].map((c) => albedo[c] * lit[c] + pal[r.mat * 8 + 4 + c]);
    if (kindOf(r.mat) === K.WATER && r.face === 3) {
      const fresnel = 0.02 + 0.98 * (1 - Math.abs(dot(rd, n))) ** 5;
      const k = 2 * dot(rd, n);
      const reflected = skyRef(sky, [rd[0] - k * n[0], rd[1] - k * n[1], rd[2] - k * n[2]]);
      colour = [0, 1, 2].map((c) => albedo[c] * lit[c] * 0.6 + fresnel * reflected[c]);
    }
  }
  // Each haze's depth between the eye and the point: the ground fog, and the smoke over it.
  const depth = (density: number, height: number) => {
    const start = Math.exp(-(pose.position[1] - sky.fogBase) / height);
    const x = (rd[1] * metres) / height;
    const shape = Math.abs(x) < 1e-3 ? 1 - 0.5 * x : (1 - Math.exp(-x)) / x;
    return density * start * metres * shape;
  };
  const t = Math.exp(-Math.max(depth(sky.fogDensity, sky.fogHeight) + depth(sky.smokeDensity, sky.smokeHeight), 0));
  const haze = hazeRef(sky, rd);
  return [0, 1, 2].map((c) => colour[c] * t + haze[c] * (1 - t));
}

export const cases = {
  /** The shade pass over 16 hand-made regions; each region's second pixel, and its reference colour. */
  async shade(args: { regions: Region[]; pose: CameraPose; sky?: Partial<FrameSky> }) {
    const g = await gpu();
    const device = g.device;
    const compiled = await compileFrame(device);
    const map = new BrickMap({ x: 64, y: 64, z: 64 });
    const world = GpuWorld.create(device, { map, mirror: HeapMirror.fromMap(map) });
    const far = FarFieldGpu.empty(device);
    const sky: FrameSky = { ...PROBE_DUSK, ...args.sky };
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC;
    const tex = (format: GPUTextureFormat, size: [number, number]) => device.createTexture({ size, format, usage });
    const gDepth = tex('r32float', RES);
    const gHit = tex('rg32uint', RES);
    const out = tex('rgba16float', RES);
    const light = tex('rgba16float', [8, 8]);
    const lightHit = tex('rg32uint', [8, 8]);
    const depth = new Float32Array(16 * 16);
    const hit = new Uint32Array(16 * 16 * 2);
    const lightData = new Uint16Array(8 * 8 * 4);
    const lightHitData = new Uint32Array(8 * 8 * 2);
    const word = (r: Region) => [(r.cell[0] | (r.cell[2] << 12) | (r.face << 24)) >>> 0, (r.cell[1] | (r.mat << 16)) >>> 0];
    args.regions.forEach((r, k) => {
      const rx = (k % 4) * 4;
      const ry = Math.floor(k / 4) * 4;
      for (let y = ry; y < ry + 4; y++) {
        for (let x = rx; x < rx + 4; x++) {
          depth[y * 16 + x] = r.depth;
          hit.set(word(r), (y * 16 + x) * 2);
        }
      }
      for (let y = ry / 2; y < ry / 2 + 2; y++) {
        for (let x = rx / 2; x < rx / 2 + 2; x++) {
          lightData.set(r.light.map(floatToHalf), (y * 8 + x) * 4);
          lightHitData.set(word(r), (y * 8 + x) * 2);
        }
      }
    });
    device.queue.writeTexture({ texture: gDepth }, depth, { bytesPerRow: 16 * 4 }, RES);
    device.queue.writeTexture({ texture: gHit }, hit, { bytesPerRow: 16 * 8 }, RES);
    device.queue.writeTexture({ texture: light }, lightData, { bytesPerRow: 8 * 8 }, [8, 8]);
    device.queue.writeTexture({ texture: lightHit }, lightHitData, { bytesPerRow: 8 * 8 }, [8, 8]);
    const writer = new StructWriter(FRAME);
    writeWorldInfo(writer, world);
    writeCamera(writer, 'cam', args.pose, 0.1, [0, 0]);
    writeCamera(writer, 'prev', args.pose, 0.1, [0, 0]);
    writer.set('res', RES);
    writer.set('alloc', RES);
    writer.set('lightRes', [8, 8]);
    writer.set('lightScale', 2);
    // The shading formula with the analytic fog nearer than 120 m too: the froxels' haze is the
    // shafts spec's to test.
    writer.set('flags', FLAGS.JITTER_OFF | FLAGS.FROXELS_OFF);
    writer.set('voxel', 0.1);
    writeSky(writer, sky);
    writeAtmosphere(writer, 'atmosphere', atmosphereModel(loadTunables()), sky.sunDir, sky.moonDir, 0.002);
    writer.set('far', far.info);
    const frame = device.createBuffer({ size: writer.buffer.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(frame, 0, writer.buffer);
    const group = device.createBindGroup({
      layout: compiled.layouts.shade,
      entries: [gDepth.createView(), gHit.createView(), out.createView(), light.createView(), lightHit.createView()].map((resource, binding) => ({ binding, resource })),
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(compiled.pipelines.shade);
    pass.setBindGroup(0, sceneGroup(device, compiled.scene, { frame, world, far, lights: compiled.lights, noise: compiled.noise, sky: constantSky(device) }));
    pass.setBindGroup(1, group);
    // The haze (unread under FROXELS_OFF), and the empty group before it.
    const haze = device.createTexture({ size: [1, 1, 1], dimension: '3d', format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING });
    pass.setBindGroup(2, device.createBindGroup({ layout: compiled.froxels.layouts.none, entries: [] }));
    pass.setBindGroup(3, device.createBindGroup({
      layout: compiled.froxels.layouts.haze,
      entries: [
        { binding: 0, resource: haze.createView() },
        { binding: 1, resource: device.createSampler() },
      ],
    }));
    pass.dispatchWorkgroups(2, 2);
    pass.end();
    device.queue.submit([encoder.finish()]);
    const px = Array.from(new Uint16Array(await readTexture(out)), halfToFloat);
    const results = args.regions.map((r, k) => {
      const x = (k % 4) * 4 + 1;
      const y = Math.floor(k / 4) * 4 + 1;
      const i = (y * 16 + x) * 4;
      // The reference sees the light as the texture stored it: in half floats.
      const stored: Region = { ...r, light: r.light.map((v) => halfToFloat(floatToHalf(v))) as Region['light'] };
      const fog = hazeRef(sky, rayDir(args.pose, RES, x + 0.5, y + 0.5));
      return { got: [px[i], px[i + 1], px[i + 2]], want: shadeRef(stored, args.pose, x, y, sky), fog };
    });
    for (const t of [gDepth, gHit, out, light, lightHit]) t.destroy();
    return { results, errors: [...g.errors] };
  },
};

export const MATERIALS = { SOD: P.SOD, BRICK: P.BRICK, TIMBER: P.TIMBER, WATER: P.WATER, LANTERN_GLOW: P.LANTERN_GLOW, SANDBAG: P.SANDBAG };
