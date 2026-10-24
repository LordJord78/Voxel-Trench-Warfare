/**
 * The haze's smoke (smoke.wgsl): each froxel column gathers the puffs its ray passes through once,
 * at most sixteen, and reads its depth to each slice from them; against every puff the frame holds
 * summed at each distance, as integrate did before. And how many puffs a frame's haze takes on each
 * preset.
 */
import { Rng } from '../../../src/core/rng';
import type { CameraPose } from '../../../src/render/camera';
import type { SmokePuff } from '../../../src/render/effects';
import { FLAGS, FRAME, PROBE_DUSK } from '../../../src/render/frame-uniforms';
import { GpuWorld } from '../../../src/render/gpu-world';
import { structLayout } from '../../../src/render/layout';
import { Renderer } from '../../../src/render/renderer';
import { sceneLayout } from '../../../src/render/scene';
import { moduleSource } from '../../../src/render/shaders';
import { BrickMap } from '../../../src/world/bricks';
import { HeapMirror } from '../../../src/world/encode';
import { gpu, readBuffer } from '../support/gpu';
import smokeTest from '../shaders/smoke-test.wgsl';

const DIMS = { x: 128, y: 128, z: 128 };
const POSE: CameraPose = { position: [6.4, 3, 6.4], yaw: 30, pitch: 5 };
const RAD = Math.PI / 180;
const FORWARD: [number, number, number] = [Math.sin(POSE.yaw * RAD) * Math.cos(POSE.pitch * RAD), Math.sin(POSE.pitch * RAD), Math.cos(POSE.yaw * RAD) * Math.cos(POSE.pitch * RAD)];
const along = (m: number): [number, number, number] => [POSE.position[0] + FORWARD[0] * m, POSE.position[1] + FORWARD[1] * m, POSE.position[2] + FORWARD[2] * m];
const far = (p: SmokePuff) => Math.hypot(p.centre[0] - POSE.position[0], p.centre[1] - POSE.position[1], p.centre[2] - POSE.position[2]);

async function smokeRenderer(): Promise<Renderer> {
  const g = await gpu();
  const map = new BrickMap(DIMS);
  const gw = GpuWorld.create(g.device, { map, mirror: HeapMirror.fromMap(map) });
  const renderer = await Renderer.create(g, null, gw, null, { size: [320, 180] });
  renderer.sky = PROBE_DUSK;
  renderer.setLights([], 0);
  renderer.flags |= FLAGS.JITTER_OFF;
  return renderer;
}

interface Answer {
  gathered: number;
  reference: number;
  count: number;
}

/** The smoke's depth at each (u, v, metres), gathered and summed puff by puff, from the frame the renderer last drew. */
async function smokeAt(renderer: Renderer, queries: readonly (readonly [number, number, number])[]): Promise<Answer[]> {
  const device = renderer.device;
  const module = device.createShaderModule({ code: moduleSource(smokeTest) });
  const info = await module.getCompilationInfo();
  const messages = info.messages.filter((m) => m.type === 'error').map((m) => `${m.lineNum}:${m.linePos} ${m.message}`);
  if (messages.length) throw new Error(`smoke-test.wgsl: ${messages.join('; ')}`);
  const local = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const pipeline = await device.createComputePipelineAsync({
    layout: device.createPipelineLayout({ bindGroupLayouts: [sceneLayout(device), local] }),
    compute: { module, entryPoint: 'main' },
  });
  const data = new Float32Array(queries.length * 4);
  queries.forEach((q, n) => data.set(q, n * 4));
  const input = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const output = device.createBuffer({ size: queries.length * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  device.queue.writeBuffer(input, 0, data);
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, renderer.sceneBindGroup());
  pass.setBindGroup(1, device.createBindGroup({ layout: local, entries: [{ binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: output } }] }));
  pass.dispatchWorkgroups(Math.ceil(queries.length / 64));
  pass.end();
  device.queue.submit([encoder.finish()]);
  const out = new Float32Array(await readBuffer(output, queries.length * 16));
  input.destroy();
  output.destroy();
  return queries.map((_, n) => ({ gathered: out[n * 4], reference: out[n * 4 + 1], count: out[n * 4 + 2] }));
}

/** Every (u, v) of a grid `nx` × `ny` over the view, at each depth. */
function grid(nx: number, ny: number, depths: readonly number[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) for (const m of depths) out.push([(i + 0.5) / nx, (j + 0.5) / ny, m]);
  return out;
}

export const cases = {
  /**
   * Forty puffs of every size scattered over the view out to 110 m, nearest first as the effects
   * frame lists them: over a grid of the view's rays at depths to 119 m, the gathered depth beside
   * the reference's, where a column gathered fewer than sixteen (so it took every puff it passes
   * through). Then twenty small puffs strung along the middle ray: it gathers the nearest sixteen,
   * the depth of those sixteen given alone.
   */
  async smokeGather() {
    const g = await gpu();
    const renderer = await smokeRenderer();
    const rng = Rng.root(11).derive('puffs');
    const puffs: SmokePuff[] = Array.from({ length: 40 }, () => {
      const d = rng.uniform(2, 110);
      const c = along(d);
      return {
        centre: [c[0] + rng.uniform(-0.4, 0.4) * d, c[1] + rng.uniform(-0.2, 0.2) * d, c[2] + rng.uniform(-0.4, 0.4) * d],
        radiusM: rng.uniform(0.5, 6),
        density: rng.uniform(0.05, 0.5),
      };
    });
    puffs.sort((a, b) => far(a) - far(b));
    renderer.setSmoke(puffs);
    renderer.render(POSE, 0, 16);
    const answers = await smokeAt(renderer, grid(32, 18, [1, 3, 8, 20, 50, 90, 119]));
    let compared = 0;
    let through = 0;
    let full = 0;
    let maxError = 0;
    const wrong: string[] = [];
    for (const a of answers) {
      if (a.count >= 16) {
        full++;
        continue;
      }
      compared++;
      if (a.reference > 0) through++;
      const error = Math.abs(a.gathered - a.reference) / Math.max(1e-3, a.reference);
      if (!(error <= maxError)) maxError = Number.isNaN(error) ? Infinity : error;
      if (!(error < 1e-4) && wrong.length < 8) wrong.push(`gathered ${a.gathered}, reference ${a.reference}, ${a.count} puffs`);
    }

    // Twenty puffs of 0.4 m on the middle ray, every 4 m from 6 m out, nearest first, each of its
    // own density: all twenty given, and the nearest sixteen alone.
    const strung: SmokePuff[] = Array.from({ length: 20 }, (_, k) => ({ centre: along(6 + 4 * k), radiusM: 0.4, density: 0.1 + 0.02 * k }));
    const middle = async (given: SmokePuff[], now: number) => {
      renderer.setSmoke(given);
      renderer.render(POSE, 0, now);
      return (await smokeAt(renderer, [[0.5, 0.5, 119]]))[0];
    };
    const all = await middle(strung, 32);
    const nearest = await middle(strung.slice(0, 16), 48);
    const crowded = { count: all.count, gathered: all.gathered, every: all.reference, nearestSixteen: nearest.reference };
    return { compared, through, full, maxError, wrong, crowded, errors: [...g.errors] };
  },

  /** Sixty-four puffs given: how many the frame's haze holds on each preset. */
  async smokePresets() {
    const g = await gpu();
    const renderer = await smokeRenderer();
    const puffs: SmokePuff[] = Array.from({ length: 64 }, (_, k) => ({ centre: along(4 + k), radiusM: 0.5, density: 0.1 }));
    const held = () => new Uint32Array(renderer.frameUniform(), structLayout(FRAME).offsets.puffCount, 1)[0];
    renderer.setSmoke(puffs);
    renderer.render(POSE, 0, 16);
    const high = held();
    renderer.setQuality({ preset: 'low' });
    renderer.setSmoke(puffs);
    renderer.render(POSE, 0, 32);
    const low = held();
    return { high, low, errors: [...g.errors] };
  },
};
