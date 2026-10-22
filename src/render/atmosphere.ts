/**
 * The sky's atmosphere on the GPU, after Hillaire (2020): Rayleigh, Mie and
 * ozone over a spherical earth, as three LUTs built by compute
 * (shaders/atmosphere-luts.wgsl) and read by shading through the scene's
 * bindings 11 to 14 (shaders/atmosphere-model.wgsl):
 *   transmittance (256 × 64)  — the light lost from a height along a direction
 *                               to the top of the atmosphere; built once;
 *   scattering    (64 × 32)   — ln Ψms, every order of scattering past the
 *                               first, by the sun's angle and height; built
 *                               once, in full floats;
 *   sky view      (192 × 108) — the sky's radiance as the camera sees it, by
 *                               angle from the sun and from the zenith; built
 *                               for each frame's sun and camera height.
 * Radiance is per unit of sun illuminance; distances are kilometres.
 */

import type { Tunables } from '../core/tunables';
import { ATMOSPHERE } from './frame-uniforms';
import { StructWriter } from './layout';
import type { SkyLuts } from './scene';
import { moduleSource } from './shaders';
import lutsSrc from './shaders/atmosphere-luts.wgsl';

export type Rgb = [number, number, number];

export interface AtmosphereModel {
  /** The radii of the ground and of the atmosphere's top, from the earth's centre. */
  bottom: number;
  top: number;
  /** Rayleigh scattering per km at the ground (air absorbs none), thinning by e every `rayleighHeight` km. */
  rayleigh: Rgb;
  rayleighHeight: number;
  /** Mie (haze) scattering and extinction per km at the ground, thinning by e every `mieHeight` km. */
  mieScattering: number;
  mieExtinction: number;
  mieHeight: number;
  /** How strongly haze scatters forward, 0 to 1. */
  mieG: number;
  /** Ozone's absorption per km at its peak, falling linearly to none `ozoneHalfWidth` km either side. */
  ozone: Rgb;
  ozoneCentre: number;
  ozoneHalfWidth: number;
  /** The ground's albedo, lit below the horizon. */
  albedo: number;
}

export interface AtmospherePipelines {
  transmittance: GPUComputePipeline;
  scattering: GPUComputePipeline;
  skyView: GPUComputePipeline;
}

const SIZES = { transmittance: [256, 64], scattering: [64, 32], skyView: [192, 108] } as const;

function rgb(tun: Tunables, key: string): Rgb {
  const v = tun.get(key);
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    throw new TypeError(`tunable '${key}' is not three numbers`);
  }
  return [v[0], v[1], v[2]];
}

/** The [atmosphere] tunables. */
export function atmosphereModel(tun: Tunables): AtmosphereModel {
  const f = (key: string) => tun.f(`atmosphere.${key}`);
  return {
    bottom: f('ground_radius_km'),
    top: f('top_radius_km'),
    rayleigh: rgb(tun, 'atmosphere.rayleigh_per_km'),
    rayleighHeight: f('rayleigh_height_km'),
    mieScattering: f('mie_scattering_per_km'),
    mieExtinction: f('mie_extinction_per_km'),
    mieHeight: f('mie_height_km'),
    mieG: f('mie_g'),
    ozone: rgb(tun, 'atmosphere.ozone_per_km'),
    ozoneCentre: f('ozone_centre_km'),
    ozoneHalfWidth: f('ozone_half_width_km'),
    albedo: f('ground_albedo'),
  };
}

/** A model and its viewer into a struct laid out as ATMOSPHERE, at `path` ('' for the struct itself). */
function writeModel(w: StructWriter, path: string, m: AtmosphereModel, sunDir: readonly number[], viewHeightKm: number): void {
  const set = (field: string, value: number | readonly number[]) => w.set(path ? `${path}.${field}` : field, value);
  set('rayleigh', m.rayleigh);
  set('rayleighHeight', m.rayleighHeight);
  set('ozone', m.ozone);
  set('ozoneCentre', m.ozoneCentre);
  set('mieScattering', m.mieScattering);
  set('mieExtinction', m.mieExtinction);
  set('mieHeight', m.mieHeight);
  set('mieG', m.mieG);
  set('ozoneHalfWidth', m.ozoneHalfWidth);
  set('albedo', m.albedo);
  set('bottom', m.bottom);
  set('top', m.top);
  set('sunDir', sunDir);
  set('viewHeight', viewHeightKm);
}

export class Atmosphere {
  readonly model: AtmosphereModel;
  readonly transmittance: GPUTexture;
  readonly scattering: GPUTexture;
  readonly skyView: GPUTexture;
  readonly sampler: GPUSampler;
  private readonly device: GPUDevice;
  private readonly pipelines: AtmospherePipelines;
  private readonly uniform: GPUBuffer;
  private readonly writer = new StructWriter(ATMOSPHERE);
  private readonly skyViewGroup: GPUBindGroup;
  private sunDir: readonly number[] = [0, 1, 0];
  private viewHeightKm = 0;

  /** Compile the three builds; they need only the device, so they can compile with the frame's passes. */
  static async compile(device: GPUDevice): Promise<AtmospherePipelines> {
    const module = device.createShaderModule({ label: 'atmosphere-luts', code: moduleSource(lutsSrc) });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length) throw new Error(`atmosphere-luts.wgsl: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`);
    const build = (entryPoint: string) => device.createComputePipelineAsync({ label: entryPoint, layout: 'auto', compute: { module, entryPoint } });
    const [transmittance, scattering, skyView] = await Promise.all([build('transmittanceLut'), build('scatteringLut'), build('skyViewLut')]);
    return { transmittance, scattering, skyView };
  }

  /** The LUTs for `model`, with transmittance and multiple scattering built now; `update` builds the sky view. */
  static create(device: GPUDevice, pipelines: AtmospherePipelines, model: AtmosphereModel): Atmosphere {
    return new Atmosphere(device, pipelines, model);
  }

  private constructor(device: GPUDevice, pipelines: AtmospherePipelines, model: AtmosphereModel) {
    this.device = device;
    this.pipelines = pipelines;
    this.model = model;
    const lut = (label: string, size: readonly [number, number], format: GPUTextureFormat) =>
      device.createTexture({
        label,
        size: [...size],
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
      });
    this.transmittance = lut('transmittance', SIZES.transmittance, 'rgba16float');
    this.scattering = lut('multiple scattering', SIZES.scattering, 'rgba32float');
    this.skyView = lut('sky view', SIZES.skyView, 'rgba16float');
    this.sampler = device.createSampler({ label: 'atmosphere', magFilter: 'linear', minFilter: 'linear' });
    this.uniform = device.createBuffer({ label: 'atmosphere', size: this.writer.buffer.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const group = (pipeline: GPUComputePipeline, entries: [number, GPUBindingResource][]) =>
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [[0, { buffer: this.uniform }] as [number, GPUBindingResource], ...entries].map(([binding, resource]) => ({ binding, resource })),
      });
    const transmittanceGroup = group(pipelines.transmittance, [[4, this.transmittance.createView()]]);
    const scatteringGroup = group(pipelines.scattering, [
      [1, this.transmittance.createView()],
      [3, this.sampler],
      [5, this.scattering.createView()],
    ]);
    this.skyViewGroup = group(pipelines.skyView, [
      [1, this.transmittance.createView()],
      [2, this.scattering.createView()],
      [3, this.sampler],
      [6, this.skyView.createView()],
    ]);
    writeModel(this.writer, '', model, this.sunDir, this.viewHeightKm);
    device.queue.writeBuffer(this.uniform, 0, this.writer.buffer);
    const encoder = device.createCommandEncoder({ label: 'atmosphere' });
    const pass = encoder.beginComputePass({ label: 'atmosphere' });
    pass.setPipeline(pipelines.transmittance);
    pass.setBindGroup(0, transmittanceGroup);
    pass.dispatchWorkgroups(SIZES.transmittance[0] / 8, SIZES.transmittance[1] / 8);
    // One workgroup per texel.
    pass.setPipeline(pipelines.scattering);
    pass.setBindGroup(0, scatteringGroup);
    pass.dispatchWorkgroups(SIZES.scattering[0], SIZES.scattering[1]);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  /**
   * Build the sky view for the sun (a unit vector, y up) and the camera's height over the ground,
   * in metres. Its uniform is written now, so call this once per submit.
   */
  update(encoder: GPUCommandEncoder, sunDir: readonly number[], cameraHeightM: number, timestampWrites?: GPUComputePassTimestampWrites): void {
    this.sunDir = [...sunDir];
    this.viewHeightKm = Math.max(0, cameraHeightM) / 1000;
    writeModel(this.writer, '', this.model, this.sunDir, this.viewHeightKm);
    this.device.queue.writeBuffer(this.uniform, 0, this.writer.buffer);
    const pass = encoder.beginComputePass({ label: 'sky view', timestampWrites });
    pass.setPipeline(this.pipelines.skyView);
    pass.setBindGroup(0, this.skyViewGroup);
    pass.dispatchWorkgroups(SIZES.skyView[0] / 8, Math.ceil(SIZES.skyView[1] / 8));
    pass.end();
  }

  /** The atmosphere as the sky view was last built, into a frame struct's field (laid out as ATMOSPHERE). */
  writeTo(w: StructWriter, path: string): void {
    writeModel(w, path, this.model, this.sunDir, this.viewHeightKm);
  }

  views(): SkyLuts {
    return { transmittance: this.transmittance.createView(), scattering: this.scattering.createView(), skyView: this.skyView.createView(), sampler: this.sampler };
  }

  destroy(): void {
    this.transmittance.destroy();
    this.scattering.destroy();
    this.skyView.destroy();
    this.uniform.destroy();
  }
}
