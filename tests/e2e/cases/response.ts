import { Bloom } from '../../../src/render/bloom';
import { bloom as bloomRef, level } from '../../support/bloom-ref';
import { gpu, readTexture } from '../support/gpu';
import { floatToHalf, halfToFloat } from '../support/half';

export const cases = {
  /**
   * The bloom pyramid over a `w` × `h` image whose rendered part (`res`, all of it unless given) is
   * noise below `noise` with one texel of `point` at its middle, and `outside` beyond it: the GPU's
   * top level against the f64 reference over the rendered part (worst error in units of 1% of the
   * reference plus 1e-4), its energy against the image's (each half-size texel standing for four),
   * the row through the point outward, and how many values are not finite.
   */
  async bloom(args: { w: number; h: number; res?: [number, number]; noise: number; point: number; outside?: number }) {
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
    bloom.encode(encoder, [rw, rh]);
    device.queue.submit([encoder.finish()]);
    const out = Array.from(new Uint16Array(await readTexture(bloom.output)), halfToFloat);
    const ow = bloom.output.width;
    // The reference sees the image as the GPU holds it, in half floats, over the rendered part.
    const rendered = new Float64Array(rw * rh);
    let input = 0;
    for (let j = 0; j < rh; j++) {
      for (let i = 0; i < rw; i++) {
        rendered[j * rw + i] = halfToFloat(floatToHalf(values[j * w + i]));
        input += rendered[j * rw + i];
      }
    }
    const ref = bloomRef(level(rw, rh, rendered));
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
