import { loadTunables } from '../../../src/core/tunables';
import { AutoExposure, type ExposureParams } from '../../../src/render/auto-exposure';
import { Bloom } from '../../../src/render/bloom';
import { frameSky, skyState } from '../../../src/render/sky-state';
import { bloom as bloomRef, level } from '../../support/bloom-ref';
import { adapt, binOf, centre, histogram, meteredMean, zoneCorrection } from '../../support/exposure-ref';
import { gpu, readBuffer, readTexture } from '../support/gpu';
import { floatToHalf, halfToFloat } from '../support/half';
import { cases as taa } from './taa';

/** The meter and its adaptation, alone, with a present uniform to write into. */
async function meter(device: GPUDevice) {
  const present = device.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_SRC });
  const auto = AutoExposure.create(device, await AutoExposure.compile(device), present);
  return { auto, present };
}

/** A `w` × `h` image whose texels are grey at each of `lums` (their bits, in half floats). */
function greyTexture(device: GPUDevice, w: number, h: number, halves: ArrayLike<number>): GPUTexture {
  const texels = new Uint16Array(w * h * 4);
  for (let i = 0; i < w * h; i++) texels.set([halves[i], halves[i], halves[i], 0x3c00], i * 4);
  const t = device.createTexture({ size: [w, h], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  device.queue.writeTexture({ texture: t }, texels, { bytesPerRow: w * 8 }, [w, h]);
  return t;
}

const NAN_HALF = 0x7e00;

export const cases = {
  /**
   * Grain as the present pass lays it over a flat grey on a 64 × 64 canvas (the blue-noise tile's
   * size) at the clock's `hours`: the hour's grain (8-bit steps), and the green bytes with that grain
   * at each of two shifts into the tile, and without it.
   */
  async grain(args: { hours: number; shifts: [[number, number], [number, number]] }) {
    const tun = loadTunables();
    const key = frameSky(skyState(tun, args.hours), tun).grain;
    const show = (grain: number, shift: [number, number]) => taa.present({ c: 0.18, exposure: 1, canvas: 64, grain, shift });
    const a = await show(key, args.shifts[0]);
    const b = await show(key, args.shifts[1]);
    const none = await show(0, args.shifts[0]);
    return { key, a: a.green, b: b.green, none: none.green, errors: [...a.errors, ...b.errors, ...none.errors] };
  },

  /**
   * The meter's counts over a `w` × `h` image of greys at bins' middles from below the range to past
   * it, with NaN, infinite, zero and negative texels among them, and bright texels beyond the
   * rendered part `res`: the GPU's counts, and the CPU's of the rendered part.
   */
  async histogram(args: { w: number; h: number; res?: [number, number]; base: number }) {
    const g = await gpu();
    const device = g.device;
    const { w, h } = args;
    const [rw, rh] = args.res ?? [w, h];
    const halves = new Uint16Array(w * h);
    const lums: number[] = [];
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        let half: number;
        if (i >= rw || j >= rh) half = floatToHalf(1000);
        else if (k % 97 === 0) half = NAN_HALF;
        else if (k % 89 === 0) half = 0x7c00;
        else if (k % 83 === 0) half = 0;
        else if (k % 79 === 0) half = floatToHalf(-1);
        // A bin's middle, from 4 bins below the range to 4 above it, under the base.
        else half = floatToHalf(2 ** centre(((k * 37) % 136) - 4) / args.base);
        halves[k] = half;
        if (i < rw && j < rh) lums.push(halfToFloat(half));
      }
    }
    const image = greyTexture(device, w, h, halves);
    const { auto, present } = await meter(device);
    device.queue.writeBuffer(auto.state, 0, new Float32Array([args.base, 0, 0, 0, 0, 0, 0, 0]));
    auto.bind(image.createView());
    const encoder = device.createCommandEncoder();
    auto.encode(encoder, [rw, rh], { dt: 1 / 60, bias: 1, target: 0, zone: 1, rise: 1, fall: 3, reset: true });
    device.queue.submit([encoder.finish()]);
    const counts = await auto.counts();
    image.destroy();
    auto.destroy();
    present.destroy();
    return { counts, ref: histogram(lums, args.base), errors: [...g.errors] };
  },

  /**
   * The adaptation over flat images: for each step, `frames` frames of a grey `stops` stops from 1
   * (the first frame a reset if `reset`), a sixtieth of a second apart, the base exposure 1: each
   * frame's correction and want, and the presented exposure, with the reference's trajectory.
   */
  async adaptation(args: { steps: { stops: number; frames: number; reset?: boolean }[]; target: number; zone: number; rise: number; fall: number; bias: number }) {
    const g = await gpu();
    const device = g.device;
    const { auto, present } = await meter(device);
    device.queue.writeBuffer(auto.state, 0, new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]));
    const got: { correction: number; want: number; exposure: number }[] = [];
    const ref: { correction: number; want: number }[] = [];
    let c = 0;
    for (const step of args.steps) {
      const lum = 2 ** step.stops;
      const image = greyTexture(device, 64, 64, new Uint16Array(64 * 64).fill(floatToHalf(lum)));
      auto.bind(image.createView());
      const metered = meteredMean(histogram(new Array(64 * 64).fill(halfToFloat(floatToHalf(lum))), 1), args.target);
      const want = zoneCorrection(args.target, metered, args.zone);
      for (let f = 0; f < step.frames; f++) {
        const reset = f === 0 && step.reset === true;
        const params: ExposureParams = { dt: 1 / 60, bias: args.bias, target: args.target, zone: args.zone, rise: args.rise, fall: args.fall, reset };
        const encoder = device.createCommandEncoder();
        auto.encode(encoder, [64, 64], params);
        device.queue.submit([encoder.finish()]);
        const s = await auto.read();
        const exposure = new Float32Array(await readBuffer(present, 48))[6];
        got.push({ correction: s.correction, want: s.want, exposure });
        c = reset ? want : adapt(c, want, 1 / 60, args.rise, args.fall);
        ref.push({ correction: c, want });
      }
      image.destroy();
    }
    auto.destroy();
    present.destroy();
    return { got, ref, errors: [...g.errors] };
  },

  /**
   * The bloom pyramid over a `w` × `h` image whose rendered part (`res`, all of it unless given) is
   * noise below `noise` with one texel of `point` at its middle, and `outside` beyond it, the input
   * capped at `cap` (none unless given): the GPU's
   * top level against the f64 reference over the rendered part (worst error in units of 1% of the
   * reference plus 1e-4), its energy against the reference's (each half-size texel standing for four),
   * the row through the point outward, and how many values are not finite.
   */
  async bloom(args: { w: number; h: number; res?: [number, number]; noise: number; point: number; outside?: number; cap?: number }) {
    const g = await gpu();
    const device = g.device;
    const { w, h } = args;
    const [rw, rh] = args.res ?? [w, h];
    let seed = 7;
    const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const values = new Float32Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) values[j * w + i] = i < rw && j < rh ? rand() * args.noise : (args.outside ?? 0);
    const [px, py] = [rw >> 1, rh >> 1];
    values[py * w + px] += args.point;
    const texels = new Uint16Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const v = floatToHalf(values[i]);
      texels.set([v, v, v, floatToHalf(1)], i * 4);
    }
    const source = device.createTexture({ size: [w, h], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: source }, texels, { bytesPerRow: w * 8 }, [w, h]);
    const bloom = Bloom.create(device, await Bloom.compile(device));
    bloom.resize([w, h], source.createView());
    const encoder = device.createCommandEncoder();
    bloom.encode(encoder, [rw, rh], args.cap ?? 1e9);
    device.queue.submit([encoder.finish()]);
    const out = Array.from(new Uint16Array(await readTexture(bloom.output)), halfToFloat);
    const ow = bloom.output.width;
    // The reference sees the image as the GPU holds it, in half floats, over the rendered part.
    const rendered = new Float64Array(rw * rh);
    for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) rendered[j * rw + i] = halfToFloat(floatToHalf(values[j * w + i]));
    const ref = bloomRef(level(rw, rh, rendered), 6, args.cap ?? Infinity);
    // The energy against the reference's, which keeps the image's (tests/render/bloom-ref.test.ts) unless a cap takes some.
    const input = 4 * ref.v.reduce((a, b) => a + b, 0);
    let worst = 0;
    let bad = 0;
    let total = 0;
    for (let j = 0; j < ref.h; j++) {
      for (let i = 0; i < ref.w; i++) {
        const v = out[(j * ow + i) * 4 + 1];
        const want = ref.v[j * ref.w + i];
        if (!Number.isFinite(v)) bad++;
        total += v;
        worst = Math.max(worst, Math.abs(v - want) / (0.01 * Math.abs(want) + 1e-4));
      }
    }
    const row = Array.from({ length: 96 }, (_, i) => out[((py >> 1) * ow + (px >> 1) + i) * 4 + 1]);
    source.destroy();
    bloom.destroy();
    return { worst, energy: (4 * total) / input, row, bad, errors: [...g.errors] };
  },
};
