/**
 * The WebGPU device, asked for as much as the adapter offers.
 *
 * A 10 cm world's brick heap is tens of megabytes and grows with edits, so the
 * storage limits are raised to the adapter's maxima rather than WebGPU's
 * conservative defaults. Timestamp queries are taken when offered: they are
 * how every pass reports its time. Validation errors nothing caught are kept
 * and logged, so tests can assert there were none.
 */

export type GpuUnavailableReason = 'no-webgpu' | 'no-adapter' | 'limits';

export class GpuUnavailable extends Error {
  readonly reason: GpuUnavailableReason;

  constructor(reason: GpuUnavailableReason, message: string) {
    super(message);
    this.name = 'GpuUnavailable';
    this.reason = reason;
  }
}

export interface Gpu {
  adapter: GPUAdapter;
  device: GPUDevice;
  timestamps: boolean;
  errors: string[];
}

export async function createGpu(): Promise<Gpu> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) {
    throw new GpuUnavailable('no-webgpu', 'This browser has no WebGPU.');
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new GpuUnavailable('no-adapter', 'No WebGPU adapter is available.');
  const timestamps = adapter.features.has('timestamp-query');
  const limits = adapter.limits;
  const device = await adapter.requestDevice({
    requiredFeatures: timestamps ? ['timestamp-query'] : [],
    requiredLimits: {
      maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
      maxBufferSize: limits.maxBufferSize,
      maxStorageBuffersPerShaderStage: limits.maxStorageBuffersPerShaderStage,
      maxStorageTexturesPerShaderStage: limits.maxStorageTexturesPerShaderStage,
    },
  });
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => {
    const message = (event as GPUUncapturedErrorEvent).error.message;
    errors.push(message);
    console.error(`[gpu error] ${message}`);
  });
  return { adapter, device, timestamps, errors };
}
