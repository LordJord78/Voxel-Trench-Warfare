/** Browser-side helpers for GPU cases: one device per page, and readbacks. */
import { createGpu, type Gpu } from '../../../src/render/device';

let cached: Promise<Gpu> | null = null;

export function gpu(): Promise<Gpu> {
  cached ??= createGpu();
  return cached;
}

export async function readBuffer(buffer: GPUBuffer, bytes: number, offset = 0): Promise<ArrayBuffer> {
  const { device } = await gpu();
  const staging = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, offset, staging, 0, bytes);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const out = staging.getMappedRange().slice(0);
  staging.destroy();
  return out;
}

const TEXEL_BYTES: Partial<Record<GPUTextureFormat, number>> = {
  r8uint: 1,
  r16uint: 2,
  r32float: 4,
  r32uint: 4,
  rgba8unorm: 4,
  bgra8unorm: 4,
  rg32float: 8,
  rg32uint: 8,
  rgba16float: 8,
  rgba32float: 16,
};

/** Mip level 0 of a 2D texture, rows packed tightly. */
export async function readTexture(texture: GPUTexture): Promise<ArrayBuffer> {
  const { device } = await gpu();
  const texel = TEXEL_BYTES[texture.format];
  if (!texel) throw new Error(`readTexture does not know ${texture.format}`);
  const row = texture.width * texel;
  const stride = Math.ceil(row / 256) * 256;
  const staging = device.createBuffer({ size: stride * texture.height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow: stride }, [texture.width, texture.height]);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const padded = new Uint8Array(staging.getMappedRange());
  const out = new Uint8Array(row * texture.height);
  for (let y = 0; y < texture.height; y++) out.set(padded.subarray(y * stride, y * stride + row), y * row);
  staging.destroy();
  return out.buffer;
}
