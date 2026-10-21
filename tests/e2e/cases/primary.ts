import { HeapMirror } from '../../../src/world/encode';
import { projectToPixel, rayDir, type CameraPose } from '../../../src/render/camera';
import { FLAGS } from '../../../src/render/frame-uniforms';
import { GpuWorld } from '../../../src/render/gpu-world';
import { Renderer } from '../../../src/render/renderer';
import { Rng } from '../../../src/core/rng';
import { gpu, readTexture } from '../support/gpu';
import { halfToFloat } from '../support/half';
import { syntheticWorld } from '../../support/synthetic';
import { traceRef } from '../../support/trace-ref';

export const cases = {
  /** Two frames of the synthetic world, the camera moved 1 m along +x between them; G-buffer against reference rays. */
  async primary() {
    const g = await gpu();
    const map = syntheticWorld(4);
    const world = GpuWorld.create(g.device, { map, mirror: HeapMirror.fromMap(map) });
    const res: [number, number] = [160, 120];
    const renderer = await Renderer.create(g, null, world, null, { size: res });
    renderer.flags = FLAGS.JITTER_OFF;
    const a: CameraPose = { position: [2, 7, 2], yaw: 45, pitch: -15 };
    const b: CameraPose = { position: [3, 7, 2], yaw: 45, pitch: -15 };
    renderer.render(a, 0, 0);
    renderer.render(b, 0, 0);
    const depth = new Float32Array(await readTexture(renderer.texture('gDepth')));
    const hit = new Uint32Array(await readTexture(renderer.texture('gHit')));
    const motion = new Uint16Array(await readTexture(renderer.texture('gMotion')));
    const rng = Rng.root(4).derive('pixels');
    const origin: [number, number, number] = [b.position[0] / 0.1, b.position[1] / 0.1, b.position[2] / 0.1];
    let agree = 0;
    let ties = 0;
    let sky = 0;
    let hits = 0;
    let motionError = 0;
    const wrong: string[] = [];
    for (let k = 0; k < 400; k++) {
      const px = rng.randint(0, res[0] - 1);
      const py = rng.randint(0, res[1] - 1);
      const i = py * res[0] + px;
      const rd = rayDir(b, res, px + 0.5, py + 0.5);
      const ref = traceRef(map, origin, rd, 1e6);
      const w0 = hit[i * 2];
      const w1 = hit[i * 2 + 1];
      const face = (w0 >>> 24) & 7;
      const cell = [w0 & 0xfff, w1 & 0xffff, (w0 >>> 12) & 0xfff];
      const mat = w1 >>> 16;
      if (!ref.hit) {
        if (face === 7 && depth[i] === 1e9) {
          agree++;
          sky++;
        } else wrong.push(`(${px}, ${py}) reference sees sky, G-buffer face ${face} depth ${depth[i]}`);
        continue;
      }
      hits++;
      const same = face === ref.face && cell[0] === ref.cell[0] && cell[1] === ref.cell[1] && cell[2] === ref.cell[2] && mat === ref.mat;
      if (same && Math.abs(depth[i] - ref.t) < 1e-3) agree++;
      else if (Math.abs(depth[i] - ref.t) < 0.01) ties++;
      else wrong.push(`(${px}, ${py}) G-buffer ${JSON.stringify({ face, cell, mat, depth: depth[i] })} reference ${JSON.stringify(ref)}`);
      const p: [number, number, number] = [(origin[0] + rd[0] * ref.t) * 0.1, (origin[1] + rd[1] * ref.t) * 0.1, (origin[2] + rd[2] * ref.t) * 0.1];
      const before = projectToPixel(a, res, p)!;
      const want = [before[0] - (px + 0.5), before[1] - (py + 0.5)];
      const got = [halfToFloat(motion[i * 4]), halfToFloat(motion[i * 4 + 1])];
      motionError = Math.max(motionError, Math.abs(got[0] - want[0]), Math.abs(got[1] - want[1]));
    }
    for (const buffer of [world.table, world.sectors, world.heap, world.palette, world.pyramid]) buffer.destroy();
    return { compared: 400, agree, ties, sky, hits, wrong: wrong.slice(0, 8), motionError, errors: [...g.errors] };
  },
};
