import { Rng } from '../../../src/core/rng';
import { BrickMap } from '../../../src/world/bricks';
import { HeapMirror } from '../../../src/world/encode';
import { P } from '../../../src/world/materials';
import type { CameraPose } from '../../../src/render/camera';
import { FarFieldGpu } from '../../../src/render/farfield-gpu';
import { FRAME, PROBE_DUSK, writeWorldInfo } from '../../../src/render/frame-uniforms';
import { GpuWorld } from '../../../src/render/gpu-world';
import { KEY_MAP_SIZE, KeyShadow, keyShadowInfo, type Key } from '../../../src/render/key-shadow';
import { StructWriter } from '../../../src/render/layout';
import { Renderer } from '../../../src/render/renderer';
import { sceneExtras, sceneGroup, sceneLayout } from '../../../src/render/scene';
import { moduleSource } from '../../../src/render/shaders';
import { gpu, readBuffer, readTexture } from '../support/gpu';
import { litRef, mapCoords, OPEN, texelDepth } from '../../support/key-shadow-ref';
import type { Vec3 } from '../../support/trace-ref';
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
};
