import { Rng } from '../../../src/core/rng';
import { BrickMap } from '../../../src/world/bricks';
import { HeapMirror } from '../../../src/world/encode';
import { P } from '../../../src/world/materials';
import { rayDir, type CameraPose } from '../../../src/render/camera';
import { FarFieldGpu } from '../../../src/render/farfield-gpu';
import { FLAGS, FRAME, PROBE_DUSK, writeWorldInfo, type FrameSky } from '../../../src/render/frame-uniforms';
import { GpuWorld } from '../../../src/render/gpu-world';
import { FLARE_MAP_SIZE, FlareShadows } from '../../../src/render/flare-shadows';
import { KEY_MAP_SIZE, KeyShadow, keyShadowInfo, type Key } from '../../../src/render/key-shadow';
import { structLayout, StructWriter } from '../../../src/render/layout';
import type { Preset } from '../../../src/render/quality';
import type { SceneLight } from '../../../src/render/lights';
import { Renderer } from '../../../src/render/renderer';
import { sceneExtras, sceneGroup, sceneLayout } from '../../../src/render/scene';
import { moduleSource } from '../../../src/render/shaders';
import { gpu, readBuffer, readTexture } from '../support/gpu';
import { halfToFloat } from '../support/half';
import * as flareRef from '../../support/flare-shadow-ref';
import { litRef, mapCoords, OPEN, texelDepth } from '../../support/key-shadow-ref';
import type { Vec3 } from '../../support/trace-ref';
import flareLitTest from '../shaders/flare-lit-test.wgsl';
import hazeTest from '../shaders/haze-test.wgsl';
import keyLitTest from '../shaders/key-lit-test.wgsl';

const DIMS = { x: 128, y: 128, z: 128 };
const VOXEL = 0.1;
/** A texel the GPU holds at or past this is open (nothing blocks its ray). */
const OPEN_GPU = 1e8;

/** A floor, and on it a wall 4 voxels thick with a window in it. */
function world(): BrickMap {
  const map = new BrickMap(DIMS);
  map.fillBox(0, 0, 0, 128, 16, 128, P.SOD);
  map.fillBox(24, 16, 60, 104, 64, 64, P.BRICK);
  map.fillBox(52, 32, 60, 76, 48, 64, P.AIR);
  return map;
}

const dir = (azimuthDeg: number, elevationDeg: number): Vec3 => {
  const a = (azimuthDeg * Math.PI) / 180;
  const e = (elevationDeg * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
};

/** The key 30° up, behind the wall and to one side: the wall's shadow and the window's shaft fall across the floor. */
const KEY = dir(160, 30);

/** A floor, and on it a wall across z with a slit 8 voxels wide from the floor to its top. */
function slitWorld(): BrickMap {
  const map = new BrickMap(DIMS);
  map.fillBox(0, 0, 0, 128, 16, 128, P.SOD);
  map.fillBox(0, 16, 60, 128, 110, 64, P.BRICK);
  map.fillBox(60, 16, 60, 68, 110, 64, P.AIR);
  return map;
}

/**
 * A flare beyond the slit's wall, 12 m up (over everything, as the scene's hang over the map): its
 * light falls through the slit. Off the voxels' grid, so its rays do not run along the slit's edges.
 */
const SLIT_FLARE: SceneLight = { position: [6.433, 12.07, 2.031], radius: 65, colour: [1, 0.88, 0.7], intensity: 260, kind: 'flare', phase: 0 };

/**
 * The fog based at 2 m: the haze tests' cameras stand a metre or two above it. The froxels' physics
 * alone: none of the key's glow kept in shadow, the point lights' glow at full.
 */
const HAZE_SKY: FrameSky = { ...PROBE_DUSK, fogBase: 2, hazeShadow: 0, hazeLights: 1 };
/** Behind the slit's wall, 5.6 m from it, looking at the slit; and turned 20°. */
const SLIT_POSE: CameraPose = { position: [6.4, 4, 12], yaw: 180, pitch: 0 };
const TURNED_POSE: CameraPose = { ...SLIT_POSE, yaw: 200 };
/** The key light from beyond the wall, 30° up: through the slit, a sheet of light toward the camera. */
const SLIT_KEY = dir(180, 30);
const HAZE_SIZE: [number, number] = [320, 180];

interface HazeAnswer {
  haze: number[];
  fog: number[];
  shaded: number[];
}

/** A renderer over `map` for a haze test: lit by `sky`, with `lights`, at `preset`. */
async function hazeRenderer(map: BrickMap, sky: FrameSky, lights: SceneLight[] = [], preset: Preset = 'high'): Promise<Renderer> {
  const g = await gpu();
  const gw = GpuWorld.create(g.device, { map, mirror: HeapMirror.fromMap(map) });
  const renderer = await Renderer.create(g, null, gw, null, { size: HAZE_SIZE, preset });
  renderer.sky = sky;
  renderer.setLights(lights, 1);
  return renderer;
}

/** Render `frames` frames from `pose`, on from `now` (ms); the time after. */
function frames(renderer: Renderer, pose: CameraPose, count: number, now: number): number {
  for (let k = 0; k < count; k++) renderer.render(pose, 0, (now += 16));
  return now;
}

/** The froxels' haze at each (u, v, metres), as the renderer's last frame left it, and the analytic fog's there. */
async function hazeAt(renderer: Renderer, queries: readonly (readonly [number, number, number])[]): Promise<HazeAnswer[]> {
  const device = renderer.device;
  const module = device.createShaderModule({ code: moduleSource(hazeTest) });
  const info = await module.getCompilationInfo();
  const messages = info.messages.filter((m) => m.type === 'error').map((m) => `${m.lineNum}:${m.linePos} ${m.message}`);
  if (messages.length) throw new Error(`haze-test.wgsl: ${messages.join('; ')}`);
  const local = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const none = device.createBindGroupLayout({ entries: [] });
  const haze = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '3d' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
    ],
  });
  const pipeline = await device.createComputePipelineAsync({
    layout: device.createPipelineLayout({ bindGroupLayouts: [sceneLayout(device), local, none, haze] }),
    compute: { module, entryPoint: 'main' },
  });
  const data = new Float32Array(queries.length * 4);
  queries.forEach((q, n) => data.set(q, n * 4));
  const input = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const output = device.createBuffer({ size: queries.length * 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  device.queue.writeBuffer(input, 0, data);
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, renderer.sceneBindGroup());
  pass.setBindGroup(1, device.createBindGroup({ layout: local, entries: [{ binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: output } }] }));
  pass.setBindGroup(2, device.createBindGroup({ layout: none, entries: [] }));
  pass.setBindGroup(3, device.createBindGroup({
    layout: haze,
    entries: [
      { binding: 0, resource: renderer.texture('froxels').createView() },
      { binding: 1, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
    ],
  }));
  pass.dispatchWorkgroups(Math.ceil(queries.length / 64));
  pass.end();
  device.queue.submit([encoder.finish()]);
  const out = new Float32Array(await readBuffer(output, queries.length * 48));
  input.destroy();
  output.destroy();
  const at = (n: number, k: number) => Array.from(out.subarray(n * 12 + k * 4, n * 12 + k * 4 + 4));
  return queries.map((_, n) => ({ haze: at(n, 0), fog: at(n, 1), shaded: at(n, 2) }));
}

const luma = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** Every (u, v) of a grid `nx` × `ny` over the view, off its froxels' middles, at each depth. */
function grid(nx: number, ny: number, depths: readonly number[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) for (const m of depths) out.push([(i + 0.37) / nx, (j + 0.61) / ny, m]);
  return out;
}

/**
 * The haze a light adds along a ray from `eye` (metres) to `depth` metres, by 4,000 steps: its light
 * at each point (unshadowed, as light.wgsl's falls off, without a face), scattered toward the eye
 * by the approved haze's phase, by the fog and smoke there, through the haze before it.
 */
function lanternHaze(sky: FrameSky, l: SceneLight, eye: readonly number[], rd: readonly number[], depth: number): number[] {
  const steps = 4000;
  const dt = depth / steps;
  let tau = 0;
  const out = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const x = [0, 1, 2].map((k) => eye[k] + rd[k] * t);
    const above = x[1] - sky.fogBase;
    const sigma = sky.fogDensity * Math.exp(-above / sky.fogHeight) + sky.smokeDensity * Math.exp(-above / sky.smokeHeight);
    const through = Math.exp(-(tau + (sigma * dt) / 2));
    tau += sigma * dt;
    const d = [0, 1, 2].map((k) => l.position[k] - x[k]);
    const dist = Math.hypot(d[0], d[1], d[2]);
    if (dist >= l.radius) continue;
    const win = Math.min(1, Math.max(0, 1 - (dist / l.radius) ** 4));
    const c = Math.max((rd[0] * d[0] + rd[1] * d[1] + rd[2] * d[2]) / dist, 0);
    const glow = (l.intensity * win * win) / (dist * dist + 1) * (sky.hazeKey + sky.hazeForward * c ** 4);
    for (let k = 0; k < 3; k++) out[k] += l.colour[k] * glow * sigma * through * dt;
  }
  return out;
}

/** The map against the CPU reference: texels near the middle traced on the CPU, the rest open. */
function compare(gpuMap: Float32Array, map: BrickMap, keyDir: Vec3) {
  const info = keyShadowInfo(DIMS, VOXEL, keyDir);
  const half = KEY_MAP_SIZE / 2;
  // The world lies within half its diagonal of the middle: 45 texels at a quarter metre.
  const near = Math.ceil(Math.hypot(DIMS.x, DIMS.y, DIMS.z) / 2 / info.texel) + 2;
  let compared = 0;
  let hits = 0;
  let mismatches = 0;
  let nan = 0;
  let maxError = 0;
  const wrong: string[] = [];
  for (let j = 0; j < KEY_MAP_SIZE; j++) {
    for (let i = 0; i < KEY_MAP_SIZE; i++) {
      const g = gpuMap[j * KEY_MAP_SIZE + i];
      if (Number.isNaN(g)) nan++;
      const ref = Math.abs(i - half) <= near && Math.abs(j - half) <= near ? texelDepth(map, info, i, j) : OPEN;
      compared++;
      if (ref === OPEN) {
        if (!(g >= OPEN_GPU)) {
          mismatches++;
          if (wrong.length < 8) wrong.push(`(${i}, ${j}): gpu ${g}, ref open`);
        }
        continue;
      }
      hits++;
      if (!(g < OPEN_GPU)) {
        mismatches++;
        if (wrong.length < 8) wrong.push(`(${i}, ${j}): gpu open, ref ${ref.toFixed(3)}`);
        continue;
      }
      maxError = Math.max(maxError, Math.abs(g - ref));
    }
  }
  return { compared, hits, mismatches, nan, maxError, wrong, texel: info.texel };
}

export const cases = {
  /**
   * The key light's height map on a wall with a window, on a floor: its texels against the CPU
   * reference, keyLit against shadow rays, the interleave over 16 frames, the outright rebuilds
   * (a switch between sun and moon, a turn of the key), a key 1° up, and points off the map.
   */
  async keyShadow() {
    const { device, errors } = await gpu();
    const map = world();
    const gw = GpuWorld.create(device, { map, mirror: HeapMirror.fromMap(map) });
    const far = FarFieldGpu.empty(device);
    const extras = sceneExtras(device);
    const frame = new StructWriter(FRAME);
    writeWorldInfo(frame, gw);
    const frameBuffer = device.createBuffer({ size: frame.buffer.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(frameBuffer, 0, frame.buffer);
    const layout = sceneLayout(device);
    let scene = sceneGroup(device, layout, { frame: frameBuffer, world: gw, far, ...extras });
    const edit = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, p: number) => {
      map.fillBox(x0, y0, z0, x1, y1, z1, p);
      gw.flush(1 << 30, [64, 64, 64]);
      shadow.worldChanged();
      // A grown heap is a new buffer.
      scene = sceneGroup(device, layout, { frame: frameBuffer, world: gw, far, ...extras });
    };

    let pipelines;
    try {
      pipelines = await KeyShadow.compile(device, layout);
    } catch (e) {
      return { compileErrors: [String(e)] };
    }
    const shadow = KeyShadow.create(device, pipelines, DIMS, VOXEL);
    const update = (keyDir: Vec3, key: Key) => {
      const encoder = device.createCommandEncoder();
      shadow.update(encoder, scene, keyDir, key);
      device.queue.submit([encoder.finish()]);
    };
    const read = async () => new Float32Array(await readTexture(shadow.map));

    // keyLit at points, through the test shader.
    const module = device.createShaderModule({ code: moduleSource(keyLitTest) });
    const info = await module.getCompilationInfo();
    const messages = info.messages.filter((m) => m.type === 'error').map((m) => `${m.lineNum}:${m.linePos} ${m.message}`);
    if (messages.length) return { compileErrors: messages };
    const local = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const litPipeline = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout, local, pipelines.read] }),
      compute: { module, entryPoint: 'main' },
    });
    const keyLit = async (points: readonly Vec3[]): Promise<Float32Array> => {
      const data = new Float32Array(points.length * 4);
      points.forEach((p, n) => data.set(p, n * 4));
      const input = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      const output = device.createBuffer({ size: points.length * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      device.queue.writeBuffer(input, 0, data);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(litPipeline);
      pass.setBindGroup(0, scene);
      pass.setBindGroup(1, device.createBindGroup({ layout: local, entries: [{ binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: output } }] }));
      pass.setBindGroup(2, shadow.group);
      pass.dispatchWorkgroups(Math.ceil(points.length / 64));
      pass.end();
      device.queue.submit([encoder.finish()]);
      const out = new Float32Array(await readBuffer(output, points.length * 4));
      input.destroy();
      output.destroy();
      return out;
    };

    // The first update builds every texel.
    update(KEY, 'sun');
    const built = await read();
    const texels = compare(built, map, KEY);

    // keyLit at 2,000 points in the air, against a shadow ray toward the key from each.
    const rng = Rng.root(5).derive('key-lit');
    const points: Vec3[] = [];
    while (points.length < 2000) {
      const p = [rng.uniform(0, 128), rng.uniform(16, 128), rng.uniform(0, 128)].map(Math.fround);
      if (map.get(Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2])) === P.AIR) points.push([p[0], p[1], p[2]]);
    }
    const lit = await keyLit(points);
    const keyInfo = keyShadowInfo(DIMS, VOXEL, KEY);
    const across = (p: Vec3, a: number, b: number): Vec3 => {
      const s = keyInfo.texel;
      return [0, 1, 2].map((k) => p[k] + (keyInfo.u[k] * a + keyInfo.v[k] * b) * s) as unknown as Vec3;
    };
    let agree = 0;
    let shadowed = 0;
    let nearEdge = 0;
    const farFromEdge: string[] = [];
    points.forEach((p, n) => {
      const truth = litRef(map, KEY, p);
      if (!truth) shadowed++;
      if (lit[n] > 0.5 === truth) {
        agree++;
        return;
      }
      // Within 2 texels of an edge: a point a texel or two off across the light sees otherwise.
      const offsets = [-2, -1, 0, 1, 2].flatMap((a) => [-2, -1, 0, 1, 2].map((b) => [a, b])).filter(([a, b]) => a || b);
      if (offsets.some(([a, b]) => litRef(map, KEY, across(p, a, b)) !== truth)) nearEdge++;
      else if (farFromEdge.length < 8) farFromEdge.push(`${p.map((c) => c.toFixed(2))}: keyLit ${lit[n].toFixed(3)}, ray ${truth ? 'lit' : 'shadowed'}, depth ${mapCoords(keyInfo, p).depth.toFixed(2)}`);
    });

    // Points off the map: high over it, and beyond the map's texels across the light. All lit.
    const off: Vec3[] = [];
    for (let n = 0; n < 200; n++) off.push([rng.uniform(-200, 328), rng.uniform(130, 600), rng.uniform(-200, 328)]);
    const edge = (KEY_MAP_SIZE / 2 + 4) * keyInfo.texel;
    for (let n = 0; n < 200; n++) {
      const [a, b] = n % 2 ? [rng.choice([-1, 1]) * edge, rng.uniform(-edge, edge)] : [rng.uniform(-edge, edge), rng.choice([-1, 1]) * edge];
      const along = rng.uniform(-300, 300);
      off.push([0, 1, 2].map((k) => keyInfo.origin[k] + keyInfo.u[k] * a + keyInfo.v[k] * b + keyInfo.along[k] * along) as unknown as Vec3);
    }
    const offLit = await keyLit(off);
    const offShadowed = Array.from(offLit).filter((v) => v < 1 - 1e-5).length;
    const offLeast = Math.min(...offLit);

    // Interleaved: the floor raised 2 voxels, which moves every texel that meets it; then 16 updates,
    // each tracing one 8 × 8 tile of every 4 × 4 block of tiles, the same one in each, a different one
    // each update.
    edit(0, 16, 0, 128, 18, 128, P.SOD);
    let before = built;
    const changedAt = new Int32Array(KEY_MAP_SIZE * KEY_MAP_SIZE).fill(-1);
    const slots: string[] = [];
    let mixed = 0;
    let twice = 0;
    for (let k = 0; k < 16; k++) {
      update(KEY, 'sun');
      const now = await read();
      const seen = new Set<string>();
      for (let n = 0; n < now.length; n++) {
        if (now[n] === before[n] || (Number.isNaN(now[n]) && Number.isNaN(before[n]))) continue;
        if (changedAt[n] >= 0) twice++;
        changedAt[n] = k;
        seen.add(`${((n % KEY_MAP_SIZE) >> 3) & 3},${(Math.floor(n / KEY_MAP_SIZE) >> 3) & 3}`);
      }
      if (seen.size > 1) mixed++;
      slots.push([...seen].join(' '));
      before = now;
    }
    const interleaved = compare(before, map, KEY);

    // Another edit, then the moon the same way: every texel at once.
    edit(84, 16, 16, 108, 40, 40, P.AIR);
    update(KEY, 'moon');
    const switched = compare(await read(), map, KEY);

    // The key turned 2° (the clock set): every texel at once.
    edit(84, 16, 16, 108, 40, 40, P.CONCRETE);
    const turnedKey = dir(162, 30);
    update(turnedKey, 'moon');
    const turned = compare(await read(), map, turnedKey);

    // The sun 1° up.
    const lowKey = dir(160, 1);
    update(lowKey, 'sun');
    const low = compare(await read(), map, lowKey);

    shadow.destroy();
    for (const b of [gw.table, gw.sectors, gw.heap, gw.palette, gw.pyramid, frameBuffer]) b.destroy();
    return {
      texels,
      lit: { total: points.length, agree, shadowed, nearEdge, farFromEdge },
      off: { total: off.length, shadowed: offShadowed, least: offLeast },
      interleave: { slots, mixed, twice, after: interleaved },
      switched,
      turned,
      low,
      errors: [...errors],
    };
  },

  /**
   * The flare's map on the slit's wall (SLIT_FLARE): its texels against the CPU reference; flareLit
   * against shadow rays toward the flare at 2,000 points in the air; and flareLit for a light the
   * maps do not hold, at points the flare's would shadow.
   */
  async flareShadow() {
    const { device, errors } = await gpu();
    const map = slitWorld();
    const gw = GpuWorld.create(device, { map, mirror: HeapMirror.fromMap(map) });
    const extras = sceneExtras(device);
    const frame = new StructWriter(FRAME);
    writeWorldInfo(frame, gw);
    const frameBuffer = device.createBuffer({ size: frame.buffer.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(frameBuffer, 0, frame.buffer);
    const layout = sceneLayout(device);
    const scene = sceneGroup(device, layout, { frame: frameBuffer, world: gw, far: FarFieldGpu.empty(device), ...extras });
    let pipelines;
    try {
      pipelines = await KeyShadow.compile(device, layout);
    } catch (e) {
      return { compileErrors: [String(e)] };
    }
    const flares = FlareShadows.create(device);
    const shadow = KeyShadow.create(device, pipelines, DIMS, VOXEL, flares);
    flares.setFlares([SLIT_FLARE], 1, VOXEL);
    const encoder = device.createCommandEncoder();
    shadow.update(encoder, scene, KEY, 'sun', flares.next());
    device.queue.submit([encoder.finish()]);
    // The flare's map: the first tile below the key's map in the atlas.
    const atlas = new Float32Array(await readTexture(shadow.map));
    const at: Vec3 = [SLIT_FLARE.position[0] / VOXEL, SLIT_FLARE.position[1] / VOXEL, SLIT_FLARE.position[2] / VOXEL];
    const reach = SLIT_FLARE.radius / VOXEL;
    let hits = 0;
    let mismatches = 0;
    let ties = 0;
    let maxError = 0;
    const wrong: string[] = [];
    // A disagreement two right answers can have: the ray grazing a voxel's edge where it hit (as the
    // traversal's test allows), within 0.01 of a boundary on two axes.
    const grazing = (i: number, j: number, t: number) => {
      const ray = flareRef.texelRay(at, i, j)!;
      return [0, 1, 2].filter((k) => {
        const v = ray.o[k] + ray.d[k] * t;
        return Math.abs(v - Math.round(v)) < 0.01;
      }).length >= 2;
    };
    for (let j = 0; j < FLARE_MAP_SIZE; j++) {
      for (let i = 0; i < FLARE_MAP_SIZE; i++) {
        const g = atlas[(KEY_MAP_SIZE + j) * KEY_MAP_SIZE + i];
        const ref = flareRef.texelDistance(map, at, reach, i, j);
        if (ref === flareRef.OPEN) {
          if (!(g >= OPEN_GPU)) {
            if (grazing(i, j, g)) ties++;
            else {
              mismatches++;
              if (wrong.length < 8) wrong.push(`(${i}, ${j}): gpu ${g}, ref open`);
            }
          }
          continue;
        }
        hits++;
        if (!(g < OPEN_GPU)) {
          if (grazing(i, j, ref)) ties++;
          else {
            mismatches++;
            if (wrong.length < 8) wrong.push(`(${i}, ${j}): gpu open, ref ${ref.toFixed(3)}`);
          }
          continue;
        }
        maxError = Math.max(maxError, Math.abs(g - ref));
      }
    }
    // flareLit through the test shader, for points (xyz) of a light (w).
    const module = device.createShaderModule({ code: moduleSource(flareLitTest) });
    const info = await module.getCompilationInfo();
    const messages = info.messages.filter((m) => m.type === 'error').map((m) => `${m.lineNum}:${m.linePos} ${m.message}`);
    if (messages.length) return { compileErrors: messages };
    const local = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const litPipeline = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout, local, pipelines.read] }),
      compute: { module, entryPoint: 'main' },
    });
    const flareLit = async (points: readonly (readonly [number, number, number, number])[]): Promise<Float32Array> => {
      const data = new Float32Array(points.length * 4);
      points.forEach((p, n) => data.set(p, n * 4));
      const input = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      const output = device.createBuffer({ size: points.length * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      device.queue.writeBuffer(input, 0, data);
      const e = device.createCommandEncoder();
      const pass = e.beginComputePass();
      pass.setPipeline(litPipeline);
      pass.setBindGroup(0, scene);
      pass.setBindGroup(1, device.createBindGroup({ layout: local, entries: [{ binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: output } }] }));
      pass.setBindGroup(2, shadow.group);
      pass.dispatchWorkgroups(Math.ceil(points.length / 64));
      pass.end();
      device.queue.submit([e.finish()]);
      const out = new Float32Array(await readBuffer(output, points.length * 4));
      input.destroy();
      output.destroy();
      return out;
    };
    const rng = Rng.root(6).derive('flare-lit');
    const points: Vec3[] = [];
    while (points.length < 2000) {
      const p = [rng.uniform(0, 128), rng.uniform(16, 118), rng.uniform(0, 128)].map(Math.fround);
      if (map.get(Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2])) === P.AIR) points.push([p[0], p[1], p[2]]);
    }
    const lit = await flareLit(points.map((p) => [p[0], p[1], p[2], 0] as const));
    // A texel's width across the flare's light at a point's distance: some 0.9° straight below.
    const texelAt = (dist: number) => (dist * 4) / FLARE_MAP_SIZE;
    let agree = 0;
    let shadowed = 0;
    let nearEdge = 0;
    const farFromEdge: string[] = [];
    points.forEach((p, n) => {
      const truth = flareRef.litRef(map, at, p);
      if (!truth) shadowed++;
      if (lit[n] > 0.5 === truth) {
        agree++;
        return;
      }
      // Within 2 texels of an edge: a point a texel or two off, along any axis, sees otherwise.
      const w = texelAt(Math.hypot(p[0] - at[0], p[1] - at[1], p[2] - at[2]));
      const offsets = [-2, -1, 1, 2].flatMap((a) =>
        [0, 1, 2].map((axis) => {
          const q: [number, number, number] = [p[0], p[1], p[2]];
          q[axis] += a * w;
          return q;
        }),
      );
      if (offsets.some((q) => flareRef.litRef(map, at, q) !== truth)) nearEdge++;
      else if (farFromEdge.length < 8) farFromEdge.push(`${p.map((c) => c.toFixed(2))}: flareLit ${lit[n].toFixed(3)}, ray ${truth ? 'lit' : 'shadowed'}`);
    });
    // A light the maps do not hold (index 5), at points the flare's map shadows: lit.
    const dark = points.filter((_, n) => lit[n] === 0).slice(0, 50);
    const unmapped = await flareLit(dark.map((p) => [p[0], p[1], p[2], 5] as const));
    shadow.destroy();
    for (const b of [gw.table, gw.sectors, gw.heap, gw.palette, gw.pyramid, frameBuffer]) b.destroy();
    return {
      texels: { hits, mismatches, ties, maxError, wrong },
      lit: { total: points.length, agree, shadowed, nearEdge, farFromEdge },
      unmapped: { total: dark.length, lit: Array.from(unmapped).filter((v) => v === 1).length },
      errors: [...errors],
    };
  },

  /**
   * How many texels the flares' maps ask to be traced each frame (FlareShadows.next): a new flare;
   * still; moved half a metre, 17 frames; moved 2 m in a frame; out; lit again; the world changed,
   * 17 frames. And which lights get maps: nine burning flares; one by day (the flares at nothing).
   */
  async flareMotion() {
    const { device, errors } = await gpu();
    const flares = FlareShadows.create(device);
    const flare = (y: number, intensity = 260, x = 6.4): SceneLight => ({ ...SLIT_FLARE, position: [x, y, 2], intensity });
    const counts: number[] = [];
    const frame = (lights: SceneLight[]) => {
      flares.setFlares(lights, 1, VOXEL);
      counts.push(flares.next());
    };
    frame([flare(12)]);
    frame([flare(12)]);
    for (let k = 0; k < 17; k++) frame([flare(11.5)]);
    frame([flare(9.5)]);
    frame([flare(9.5, 0)]);
    frame([flare(9.5)]);
    flares.worldChanged();
    for (let k = 0; k < 17; k++) frame([flare(9.5)]);
    flares.setFlares(Array.from({ length: 9 }, (_, k) => flare(12, 260, 1 + k)), 1, VOXEL);
    const mapped = flares.mapped();
    flares.setFlares([flare(12)], 0, VOXEL);
    const byDay = flares.mapped();
    flares.destroy();
    return { counts, mapped, byDay, errors: [...errors] };
  },

  /**
   * How many rows of texels the map asks a host pass for each frame (KeyShadow.share, 8 workgroups
   * across): the first frame; three frames more under the same key; after the world changes, 17;
   * and after the key turns a tenth of a degree, 17.
   */
  async keyShadowStill() {
    const { device, errors } = await gpu();
    let pipelines;
    try {
      pipelines = await KeyShadow.compile(device, sceneLayout(device));
    } catch (e) {
      return { compileErrors: [String(e)] };
    }
    const shadow = KeyShadow.create(device, pipelines, DIMS, VOXEL);
    const rows: number[] = [];
    const frame = (keyDir: Vec3) => rows.push(shadow.share(keyDir, 'sun', 8));
    frame(KEY);
    for (let k = 0; k < 3; k++) frame(KEY);
    shadow.worldChanged();
    for (let k = 0; k < 17; k++) frame(KEY);
    const turned = dir(160.1, 30);
    for (let k = 0; k < 17; k++) frame(turned);
    shadow.destroy();
    return { rows, errors: [...errors] };
  },

  /**
   * The renderer's own build: the map after the first frame (all of it), then with the floor raised,
   * after 15 frames more and after 16 (a sixteenth a frame).
   */
  async keyShadowFrames() {
    const g = await gpu();
    const map = world();
    const gw = GpuWorld.create(g.device, { map, mirror: HeapMirror.fromMap(map) });
    const renderer = await Renderer.create(g, null, gw, null, { size: [64, 64] });
    renderer.sky = { ...PROBE_DUSK, keyDir: KEY, keyColour: [1, 1, 1] };
    renderer.setLights([], 0);
    const pose: CameraPose = { position: [6.4, 9.6, 6.4], yaw: 0, pitch: -89.9 };
    let now = 0;
    const frame = () => renderer.render(pose, 0, (now += 16));
    const read = async () => new Float32Array(await readTexture(renderer.texture('keyShadow')));
    frame();
    const first = compare(await read(), map, KEY);
    map.fillBox(0, 16, 0, 128, 18, 128, P.SOD);
    for (let k = 0; k < 15; k++) frame();
    const partway = compare(await read(), map, KEY);
    frame();
    const after = compare(await read(), map, KEY);
    return { first, partway, after, errors: [...g.errors] };
  },

  /**
   * Nothing to cast a shaft, no point lights: the froxels' haze against the analytic fog over the
   * view, to 120 m, at `preset`; and the froxel grid's size, and whether the frame asked ReSTIR for
   * no spatial reuse.
   */
  async hazeOpen(args: { preset?: Preset } = {}) {
    const g = await gpu();
    const renderer = await hazeRenderer(new BrickMap(DIMS), { ...HAZE_SKY, keyDir: KEY }, [], args.preset);
    frames(renderer, { position: [6.4, 3, 6.4], yaw: 30, pitch: 5 }, 8, 0);
    const answers = await hazeAt(renderer, grid(16, 9, [0.3, 0.6, 1, 2, 4, 8, 15, 30, 60, 100, 119]));
    const t = renderer.texture('froxels');
    const flags = new Uint32Array(renderer.frameUniform(), structLayout(FRAME).offsets.flags, 1)[0];
    return { answers, froxels: [t.width, t.height, t.depthOrArrayLayers], spatialOff: (flags & FLAGS.SPATIAL_OFF) !== 0, errors: [...g.errors] };
  },

  /**
   * A view with sky, rendered on high, then low, then high again: the shaded sky above the
   * horizon (the mean of a 5 × 5 patch) before and after, and any GPU error on the way.
   */
  async presetSwitch() {
    const g = await gpu();
    const renderer = await hazeRenderer(new BrickMap(DIMS), { ...HAZE_SKY, keyDir: KEY });
    renderer.flags |= FLAGS.JITTER_OFF;
    const pose: CameraPose = { position: [6.4, 3, 6.4], yaw: 30, pitch: 10 };
    const sky = async () => {
      const t = renderer.texture('colour');
      const px = new Uint16Array(await readTexture(t));
      let sum = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const k = ((40 + dy) * t.width + 160 + dx) * 4;
        sum += luma([halfToFloat(px[k]), halfToFloat(px[k + 1]), halfToFloat(px[k + 2])]);
      }
      return sum / 25;
    };
    let now = frames(renderer, pose, 20, 0);
    const before = await sky();
    renderer.setQuality({ preset: 'low' });
    now = frames(renderer, pose, 20, now);
    const low = await sky();
    renderer.setQuality({ preset: 'high' });
    frames(renderer, pose, 20, now);
    const after = await sky();
    return { before, low, after, errors: [...g.errors] };
  },

  /** The haze shading sees, over a ramp of depths from 100 m to 140 m, a tenth of a metre apart, along three rays. */
  async hazeRamp() {
    const g = await gpu();
    const renderer = await hazeRenderer(new BrickMap(DIMS), { ...HAZE_SKY, keyDir: KEY });
    frames(renderer, { position: [6.4, 3, 6.4], yaw: 30, pitch: 5 }, 8, 0);
    const queries: [number, number, number][] = [];
    for (const [u, v] of [[0.5, 0.5], [0.2, 0.3], [0.8, 0.45]]) for (let k = 0; k <= 400; k++) queries.push([u, v, 100 + k / 10]);
    const answers = await hazeAt(renderer, queries);
    return { shaded: answers.map((x) => x.shaded), errors: [...g.errors] };
  },

  /**
   * The slit's view shaded, after 30 frames: through the slit and on the wall's back each side of
   * it, with the froxels' haze and (a frame later) with the analytic fog in its place.
   */
  async hazeShaded() {
    const g = await gpu();
    const sky = { ...HAZE_SKY, keyDir: SLIT_KEY };
    const renderer = await hazeRenderer(slitWorld(), sky);
    renderer.flags |= FLAGS.JITTER_OFF;
    const now = frames(renderer, SLIT_POSE, 30, 0);
    const side = Math.atan2(2.4, 5.6);
    const pixels = [0.5 - Math.tan(side) / 2, 0.5, 0.5 + Math.tan(side) / 2].map((u) => [Math.floor(u * HAZE_SIZE[0]), HAZE_SIZE[1] / 2]);
    // Each pixel's luminance, as the shade pass left it: the mean of the 3 × 3 round it.
    const read = async () => {
      const t = renderer.texture('colour');
      const px = new Uint16Array(await readTexture(t));
      return pixels.map(([x, y]) => {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const k = ((y + dy) * t.width + x + dx) * 4;
          sum += luma([halfToFloat(px[k]), halfToFloat(px[k + 1]), halfToFloat(px[k + 2])]);
        }
        return sum / 9;
      });
    };
    const froxels = await read();
    renderer.flags |= FLAGS.FROXELS_OFF;
    frames(renderer, SLIT_POSE, 1, now);
    const analytic = await read();
    // The key's share of the haze in front of the wall's back, 6 m off.
    const rd = rayDir(SLIT_POSE, HAZE_SIZE, pixels[0][0] + 0.5, pixels[0][1] + 0.5);
    const c = Math.max(rd[0] * SLIT_KEY[0] + rd[1] * SLIT_KEY[1] + rd[2] * SLIT_KEY[2], 0);
    const [wall] = await hazeAt(renderer, [[pixels[0][0] / HAZE_SIZE[0], 0.5, 6]]);
    const keyShare = luma(sky.keyColour) * (sky.hazeKey + sky.hazeForward * c ** 4) * (1 - wall.fog[3]);
    return { froxels, analytic, keyShare, errors: [...g.errors] };
  },

  /**
   * Behind a wall with a slit, lit through it at 30° (or `elevation`°), the haze keeping
   * `hazeShadow` of the key's glow in shadow (none unless given; the tunables' share if `shipped`):
   * the haze at 5 m looking at the slit, and each side of it.
   */
  async hazeSlit(args: { elevation?: number; hazeShadow?: number; shipped?: boolean } = {}) {
    const g = await gpu();
    const key = dir(180, args.elevation ?? 30);
    const sky = { ...HAZE_SKY, keyDir: key, hazeShadow: args.shipped ? PROBE_DUSK.hazeShadow : (args.hazeShadow ?? 0) };
    const renderer = await hazeRenderer(slitWorld(), sky);
    frames(renderer, SLIT_POSE, 30, 0);
    // At the wall, 2.4 m each side of the slit: in its shadow.
    const side = Math.atan2(2.4, 5.6);
    const [left, centre, right] = await hazeAt(renderer, [[0.5 - Math.tan(side) / 2, 0.5, 5], [0.5, 0.5, 5], [0.5 + Math.tan(side) / 2, 0.5, 5]]);
    // The key's share of the haze at the slit: its term of the haze's glow, over what the haze hides.
    const rd = rayDir(SLIT_POSE, HAZE_SIZE, HAZE_SIZE[0] / 2, HAZE_SIZE[1] / 2);
    const c = Math.max(rd[0] * key[0] + rd[1] * key[1] + rd[2] * key[2], 0);
    const keyShare = luma(sky.keyColour) * (sky.hazeKey + sky.hazeForward * c ** 4) * (1 - centre.fog[3]);
    return { left: luma(left.haze), centre: luma(centre.haze), right: luma(right.haze), keyShare, errors: [...g.errors] };
  },

  /**
   * The slit's view turned 20° after 30 frames, 4 frames on; and a fresh camera there after 30.
   * Their haze over the view, and where the slit was (the view's middle).
   */
  async hazeTurn() {
    const g = await gpu();
    const sky = { ...HAZE_SKY, keyDir: SLIT_KEY };
    const turned = await hazeRenderer(slitWorld(), sky);
    frames(turned, TURNED_POSE, 4, frames(turned, SLIT_POSE, 30, 0));
    const fresh = await hazeRenderer(slitWorld(), sky);
    frames(fresh, TURNED_POSE, 30, 0);
    const queries = [...grid(12, 7, [2, 5, 10, 30, 100]), [0.5, 0.5, 2] as [number, number, number], [0.5, 0.5, 5] as [number, number, number]];
    const a = await hazeAt(turned, queries);
    const b = await hazeAt(fresh, queries);
    return { turned: a.map((x) => luma(x.haze)), fresh: b.map((x) => luma(x.haze)), errors: [...g.errors] };
  },

  /**
   * A lantern in clear air beside a broken one (its intensity not finite, as a bug might leave it):
   * the haze round them, which the broken light must not poison, from the froxels and by the CPU.
   */
  async hazeBroken() {
    const g = await gpu();
    const dark = [0, 0, 0];
    const sky: FrameSky = { ...HAZE_SKY, keyDir: KEY, keyColour: dark, sunLight: dark, moonLight: dark, frontGlow: dark };
    const lantern: SceneLight = { position: [6.4, 3, 9], radius: 8, colour: [1, 0.7, 0.4], intensity: 3, kind: 'lantern', phase: 0 };
    const renderer = await hazeRenderer(new BrickMap(DIMS), sky, [lantern, { ...lantern, position: [6.0, 3, 9], intensity: Infinity }]);
    const pose: CameraPose = { position: [6.4, 3, 4], yaw: 0, pitch: 0 };
    frames(renderer, pose, 30, 0);
    const queries: [number, number, number][] = [];
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) for (const m of [4.5, 7]) queries.push([0.45 + 0.05 * i, 0.45 + 0.05 * j, m]);
    const answers = await hazeAt(renderer, queries);
    const reference = queries.map(([u, v, m]) => luma(lanternHaze(sky, lantern, pose.position, rayDir(pose, HAZE_SIZE, u * HAZE_SIZE[0], v * HAZE_SIZE[1]), m)));
    return { froxels: answers.map((x) => luma(x.haze)), transmittance: answers.map((x) => x.haze[3]), reference, errors: [...g.errors] };
  },

  /**
   * Behind the slit's wall, the flare beyond it (SLIT_FLARE), no other light in the haze: the haze at
   * 5 m looking at the slit and each side of it, and the flare's share there (its haze unshadowed, by
   * the CPU).
   */
  async hazeFlareSlit() {
    const g = await gpu();
    const dark = [0, 0, 0];
    const sky: FrameSky = { ...HAZE_SKY, keyDir: KEY, keyColour: dark, sunLight: dark, moonLight: dark, frontGlow: dark };
    const renderer = await hazeRenderer(slitWorld(), sky, [SLIT_FLARE]);
    frames(renderer, SLIT_POSE, 30, 0);
    const side = Math.atan2(2.4, 5.6);
    const [left, centre, right] = await hazeAt(renderer, [[0.5 - Math.tan(side) / 2, 0.5, 5], [0.5, 0.5, 5], [0.5 + Math.tan(side) / 2, 0.5, 5]]);
    const share = luma(lanternHaze(sky, SLIT_FLARE, SLIT_POSE.position, rayDir(SLIT_POSE, HAZE_SIZE, HAZE_SIZE[0] / 2, HAZE_SIZE[1] / 2), 5));
    return { left: luma(left.haze), centre: luma(centre.haze), right: luma(right.haze), share, errors: [...g.errors] };
  },

  /** A lantern in clear air (no other light in the haze): its haze around it, from the froxels and by the CPU. */
  async hazeLantern() {
    const g = await gpu();
    const dark = [0, 0, 0];
    const sky: FrameSky = { ...HAZE_SKY, keyDir: KEY, keyColour: dark, sunLight: dark, moonLight: dark, frontGlow: dark };
    const lantern: SceneLight = { position: [6.4, 3, 9], radius: 8, colour: [1, 0.7, 0.4], intensity: 3, kind: 'lantern', phase: 0 };
    const renderer = await hazeRenderer(new BrickMap(DIMS), sky, [lantern]);
    const pose: CameraPose = { position: [6.4, 3, 4], yaw: 0, pitch: 0 };
    frames(renderer, pose, 30, 0);
    const queries: [number, number, number][] = [];
    for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) for (const m of [3, 4.5, 5.5, 7, 10]) queries.push([0.4 + 0.05 * i, 0.4 + 0.05 * j, m]);
    const answers = await hazeAt(renderer, queries);
    const reference = queries.map(([u, v, m]) => luma(lanternHaze(sky, lantern, pose.position, rayDir(pose, HAZE_SIZE, u * HAZE_SIZE[0], v * HAZE_SIZE[1]), m)));
    return { froxels: answers.map((x) => luma(x.haze)), reference, errors: [...g.errors] };
  },
};
