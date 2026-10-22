/** Row 2's scene and measures, for the app: a thousand lights over the field at night, and the image read back. */
import type { Page } from '@playwright/test';
import { hooks } from './support/app';

/**
 * 1,024 lights over the field the overview sees: 768 lanterns a metre or two off the ground, which
 * flicker, and 256 lights 4 to 10 m up that sink as flares do (light-motion.ts), all from a seeded
 * stream; replacing the scene's lights.
 */
export async function useManyLights(page: Page): Promise<void> {
  await hooks(page, (h) => {
    const plan = (h as unknown as { world: { plan: { params: { voxel: number; dims: { x: number }; layout: { front: number; enemyFront: number } } } } }).world.plan;
    const p = plan.params;
    const v = p.voxel;
    let s = 20261022;
    const rand = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    const lights = [];
    for (let i = 0; i < 1024; i++) {
      const moving = i >= 768;
      const x = 12 + rand() * (p.dims.x * v - 24);
      const z = p.layout.front * v - 20 + rand() * ((p.layout.enemyFront - p.layout.front) * v + 40);
      lights.push({
        position: [x, 16 + (moving ? 4 + rand() * 6 : 0.4 + rand() * 1.6), z] as [number, number, number],
        radius: moving ? 12 : 7,
        colour: (moving ? [1, 0.88, 0.7] : [1, 0.52, 0.16]) as [number, number, number],
        intensity: moving ? 20 : 2.5,
        kind: moving ? ('flare' as const) : ('lantern' as const),
        phase: rand(),
      });
    }
    h.useLights(lights);
  });
}

/**
 * A texture of the last frame, rgba16float, read back in the page: each pixel's luminance (or its
 * rgb, with `rgb`), over the part the frame rendered.
 */
export function readImage(page: Page, name: string, rgb = false): Promise<number[]> {
  return hooks(
    page,
    async (h, arg) => {
      const { name: n, rgb: colour } = arg as { name: string; rgb: boolean };
      const r = (h as unknown as { renderer: { device: GPUDevice; texture(n: string): GPUTexture; stats: { res: [number, number] } } }).renderer;
      const t = r.texture(n);
      // The internal image's rendered part; the lighting images are half its size (the high preset).
      const [w, hgt] = n === 'sharp' ? r.stats.res : [Math.ceil(r.stats.res[0] / 2), Math.ceil(r.stats.res[1] / 2)];
      const row = t.width * 8;
      const stride = Math.ceil(row / 256) * 256;
      const buffer = r.device.createBuffer({ size: stride * t.height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const encoder = r.device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: t }, { buffer, bytesPerRow: stride }, [t.width, t.height]);
      r.device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const bytes = buffer.getMappedRange();
      const half = (u: number) => {
        const e = (u >> 10) & 31;
        const m = u & 1023;
        const sign = u & 32768 ? -1 : 1;
        return e === 0 ? sign * m * 2 ** -24 : e === 31 ? (m ? NaN : sign * Infinity) : sign * (1 + m / 1024) * 2 ** (e - 15);
      };
      const out: number[] = [];
      for (let y = 0; y < hgt; y++) {
        const px = new Uint16Array(bytes, y * stride, t.width * 4);
        for (let x = 0; x < w; x++) {
          const c = [half(px[x * 4]), half(px[x * 4 + 1]), half(px[x * 4 + 2])];
          if (colour) out.push(...c);
          else out.push(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);
        }
      }
      buffer.unmap();
      buffer.destroy();
      return out;
    },
    { name, rgb },
  );
}
