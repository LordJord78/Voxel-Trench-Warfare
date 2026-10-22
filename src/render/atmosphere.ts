/**
 * The sky's atmosphere on the GPU, after Hillaire (2020): Rayleigh, Mie and
 * ozone over a spherical earth, as LUTs built by compute
 * (shaders/atmosphere-luts.wgsl) and read by shading through the scene's
 * bindings 11 to 15 (shaders/atmosphere-model.wgsl, sky.wgsl):
 *   transmittance (256 × 64)    — the light lost from a height along a
 *                                 direction to the top of the atmosphere;
 *                                 built once;
 *   scattering    (64 × 32)     — ln Ψms, every order of scattering past the
 *                                 first, by the sun's angle and height; built
 *                                 once, in full floats;
 *   sky view      (192 × 108 × 2) — the sky's radiance as the camera sees it,
 *                                 by angle from the light and from the zenith:
 *                                 one layer lit by the sun and one by the moon,
 *                                 built for each frame's sun, moon and camera
 *                                 height;
 *   irradiance    (6 × 2)       — the light the sky puts on each of the six
 *                                 face directions, from each layer.
 * Radiance and irradiance are per unit of the light's illuminance above the
 * air; distances are kilometres.
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

/** The lights a sky view is built for: the moon's layer only while its light counts (null skips it). */
export interface SkyLights {
  sunDir: readonly number[];
  moonDir: readonly number[] | null;
}

export interface AtmospherePipelines {
  transmittance: GPUComputePipeline;
  scattering: GPUComputePipeline;
  skyView: GPUComputePipeline;
  irradiance: GPUComputePipeline;
  irradianceSum: GPUComputePipeline;
}

const SIZES = { transmittance: [256, 64], scattering: [64, 32], skyView: [192, 108] } as const;
/** The irradiance build's chunks of each layer's texels (IRRADIANCE_CHUNKS in the shader). */
const IRRADIANCE_CHUNKS = 16;

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

/**
 * The transmittance from `heightKm` above the ground along cosine `mu` from the zenith to the top
 * of the atmosphere, on the CPU (what the key light loses on its way down): none from below the
 * horizon, where the ray meets the ground.
 */
export function transmittanceAt(m: AtmosphereModel, heightKm: number, mu: number): Rgb {
  const r = m.bottom + heightKm;
  // As the GPU carries them: c = r² - bottom², formed from the height, and b = r mu.
  const c = heightKm * (2 * m.bottom + heightKm);
  const b = r * mu;
  if (b < 0 && b * b >= c) return [0, 0, 0];
  const tMax = -b + Math.sqrt(Math.max(0, b * b - (c - (m.top * m.top - m.bottom * m.bottom))));
  const steps = 200;
  const dt = tMax / steps;
  const depth = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const ct = c + t * (2 * b + t);
    const h = ct / (Math.sqrt(m.bottom * m.bottom + ct) + m.bottom);
    const dr = Math.exp(-h / m.rayleighHeight);
    const dm = Math.exp(-h / m.mieHeight);
    const dz = Math.max(0, 1 - Math.abs(h - m.ozoneCentre) / m.ozoneHalfWidth);
    for (let k = 0; k < 3; k++) depth[k] += (m.rayleigh[k] * dr + m.mieExtinction * dm + m.ozone[k] * dz) * dt;
  }
  return [Math.exp(-depth[0]), Math.exp(-depth[1]), Math.exp(-depth[2])];
}

/** A model and its viewer into a struct laid out as ATMOSPHERE, at `path` ('' for the struct itself). */
export function writeAtmosphere(w: StructWriter, path: string, m: AtmosphereModel, sunDir: readonly number[], moonDir: readonly number[], viewHeightKm: number): void {
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
  set('moonDir', moonDir);
}

export class Atmosphere {
  readonly model: AtmosphereModel;
  readonly transmittance: GPUTexture;
  readonly scattering: GPUTexture;
  /** Two layers: lit by the sun, and by the moon. */
  readonly skyView: GPUTexture;
  /** Twelve vec4s: the six faces' irradiance (faceNormal's order) from the sun's layer, then the moon's. */
  readonly irradiance: GPUBuffer;
  readonly sampler: GPUSampler;
  private readonly device: GPUDevice;
  private readonly pipelines: AtmospherePipelines;
  private readonly uniform: GPUBuffer;
  private readonly writer = new StructWriter(ATMOSPHERE);
  private readonly skyViewGroup: GPUBindGroup;
  private readonly irradianceGroup: GPUBindGroup;
  private readonly irradianceSumGroup: GPUBindGroup;
  private readonly irradianceParts: GPUBuffer;
  private sunDir: readonly number[] = [0, 1, 0];
  private moonDir: readonly number[] = [0, -1, 0];
  private viewHeightKm = 0;

  /** Compile the builds; they need only the device, so they can compile with the frame's passes. */
  static async compile(device: GPUDevice): Promise<AtmospherePipelines> {
    const module = device.createShaderModule({ label: 'atmosphere-luts', code: moduleSource(lutsSrc) });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length) throw new Error(`atmosphere-luts.wgsl: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`);
    const build = (entryPoint: string) => device.createComputePipelineAsync({ label: entryPoint, layout: 'auto', compute: { module, entryPoint } });
    const [transmittance, scattering, skyView, irradiance, irradianceSum] = await Promise.all([
      build('transmittanceLut'),
      build('scatteringLut'),
      build('skyViewLut'),
      build('irradianceLut'),
      build('irradianceSum'),
    ]);
    return { transmittance, scattering, skyView, irradiance, irradianceSum };
  }

  /** The LUTs for `model`, with transmittance and multiple scattering built now; `update` builds the rest. */
  static create(device: GPUDevice, pipelines: AtmospherePipelines, model: AtmosphereModel): Atmosphere {
    return new Atmosphere(device, pipelines, model);
  }

  private constructor(device: GPUDevice, pipelines: AtmospherePipelines, model: AtmosphereModel) {
    this.device = device;
    this.pipelines = pipelines;
    this.model = model;
    const lut = (label: string, size: readonly number[], format: GPUTextureFormat) =>
      device.createTexture({
        label,
        size: [...size],
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
      });
    this.transmittance = lut('transmittance', SIZES.transmittance, 'rgba16float');
    this.scattering = lut('multiple scattering', SIZES.scattering, 'rgba32float');
    this.skyView = lut('sky view', [...SIZES.skyView, 2], 'rgba16float');
    this.irradiance = device.createBuffer({ label: 'sky irradiance', size: 12 * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.irradianceParts = device.createBuffer({ label: 'sky irradiance parts', size: 2 * IRRADIANCE_CHUNKS * 6 * 16, usage: GPUBufferUsage.STORAGE });
    this.sampler = device.createSampler({ label: 'atmosphere', magFilter: 'linear', minFilter: 'linear' });
    this.uniform = device.createBuffer({ label: 'atmosphere', size: this.writer.buffer.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // Each build's own (automatic) layout, with the atmosphere's uniform at 0 unless it reads none.
    const group = (pipeline: GPUComputePipeline, entries: [number, GPUBindingResource][], uniform = true) =>
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [...(uniform ? [[0, { buffer: this.uniform }] as [number, GPUBindingResource]] : []), ...entries].map(([binding, resource]) => ({ binding, resource })),
      });
    const layers = (dimension: GPUTextureViewDimension) => this.skyView.createView({ dimension });
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
      [6, layers('2d-array')],
    ]);
    this.irradianceGroup = group(pipelines.irradiance, [
      [7, layers('2d-array')],
      [9, { buffer: this.irradianceParts }],
    ]);
    this.irradianceSumGroup = group(
      pipelines.irradianceSum,
      [
        [8, { buffer: this.irradiance }],
        [9, { buffer: this.irradianceParts }],
      ],
      false,
    );
    writeAtmosphere(this.writer, '', model, this.sunDir, this.moonDir, this.viewHeightKm);
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
   * Build the sky views for the sun and moon (unit vectors, y up; the moon's skipped if null) and
   * the camera's height over the ground in metres, and the faces' irradiance from them. Its uniform
   * is written now, so call this once per submit.
   */
  update(encoder: GPUCommandEncoder, lights: SkyLights, cameraHeightM: number, timestampWrites?: GPUComputePassTimestampWrites): void {
    this.sunDir = [...lights.sunDir];
    this.moonDir = lights.moonDir ? [...lights.moonDir] : [0, -1, 0];
    this.viewHeightKm = Math.max(0, cameraHeightM) / 1000;
    writeAtmosphere(this.writer, '', this.model, this.sunDir, this.moonDir, this.viewHeightKm);
    this.device.queue.writeBuffer(this.uniform, 0, this.writer.buffer);
    const layers = lights.moonDir ? 2 : 1;
    const pass = encoder.beginComputePass({ label: 'sky view', timestampWrites });
    pass.setPipeline(this.pipelines.skyView);
    pass.setBindGroup(0, this.skyViewGroup);
    pass.dispatchWorkgroups(SIZES.skyView[0] / 8, Math.ceil(SIZES.skyView[1] / 8), layers);
    pass.setPipeline(this.pipelines.irradiance);
    pass.setBindGroup(0, this.irradianceGroup);
    pass.dispatchWorkgroups(IRRADIANCE_CHUNKS, layers);
    pass.setPipeline(this.pipelines.irradianceSum);
    pass.setBindGroup(0, this.irradianceSumGroup);
    pass.dispatchWorkgroups(layers);
    pass.end();
  }

  /** The atmosphere as the sky views were last built, into a frame struct's field (laid out as ATMOSPHERE). */
  writeTo(w: StructWriter, path: string): void {
    writeAtmosphere(w, path, this.model, this.sunDir, this.moonDir, this.viewHeightKm);
  }

  views(): SkyLuts {
    return {
      transmittance: this.transmittance.createView(),
      scattering: this.scattering.createView(),
      skyView: this.skyView.createView({ dimension: '2d-array' }),
      sampler: this.sampler,
      irradiance: this.irradiance,
    };
  }

  destroy(): void {
    this.transmittance.destroy();
    this.scattering.destroy();
    this.skyView.destroy();
    this.irradiance.destroy();
    this.irradianceParts.destroy();
    this.uniform.destroy();
  }
}
