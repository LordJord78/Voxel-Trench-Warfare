import { BrickMap } from '../../../src/world/bricks';
import { HeapMirror } from '../../../src/world/encode';
import { P } from '../../../src/world/materials';
import { cameraBasis, projectToPixel, rayDir, type CameraPose } from '../../../src/render/camera';
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

  /**
   * The beam pre-pass changes nothing but where rays start: two renderers, one with the beam
   * off, draw the same poses with jitter on, each pose at its scale of the textures' `size` (as
   * dynamic resolution renders them). Every pixel's hit and depth, compared; every pixel's beam
   * start against its own hit; and inside a roofed box, every beam start is 0.
   */
  async beamIdentity(args?: { size?: [number, number]; scales?: number[] }) {
    const g = await gpu();
    const map = new BrickMap({ x: 256, y: 128, z: 256 });
    map.fillBox(0, 0, 0, 256, 40, 256, P.SOD);
    const rng = Rng.root(9).derive('posts');
    for (let i = 0; i < 200; i++) {
      const x = rng.randint(8, 247);
      const z = rng.randint(8, 247);
      map.fillBox(x, 40, z, x + 1, 40 + rng.randint(10, 30), z + 1, P.TIMBER_DARK);
    }
    for (let x = 20; x < 236; x++) map.set(x, 45, 128, P.WIRE);
    for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) {
      const h = Math.floor(14 - (x * x + z * z) / 30);
      if (h > 0) map.fillBox(180 + x, 40, 60 + z, 181 + x, 40 + h, 61 + z, P.MUD);
    }
    // A roofed box to stand in: the camera is below every column top around it.
    map.fillBox(40, 40, 40, 60, 62, 41, P.TIMBER);
    map.fillBox(40, 40, 59, 60, 62, 60, P.TIMBER);
    map.fillBox(40, 40, 40, 41, 62, 60, P.TIMBER);
    map.fillBox(59, 40, 40, 60, 62, 60, P.TIMBER);
    map.fillBox(40, 62, 40, 60, 63, 60, P.TIMBER);
    const world = GpuWorld.create(g.device, { map, mirror: HeapMirror.fromMap(map) });
    const alloc: [number, number] = args?.size ?? [128, 128];
    const withBeam = await Renderer.create(g, null, world, null, { size: alloc });
    const without = await Renderer.create(g, null, world, null, { size: alloc });
    without.flags = FLAGS.BEAM_OFF;
    const poses: CameraPose[] = [
      { position: [3.0, 4.3, 12.8], yaw: 90, pitch: 0 },
      { position: [12.8, 4.3, 3.0], yaw: 10, pitch: -2 },
      { position: [-2.0, 11.0, -2.0], yaw: 45, pitch: -25 },
      { position: [5.0, 5.6, 5.0], yaw: 30, pitch: 5 },
    ];
    let differ = 0;
    let beyond = 0;
    let insideNonZero = 0;
    let compared = 0;
    let elevatedStart = 0;
    const firstDiffs: string[] = [];
    const sizes: [number, number][] = [];
    for (const [k, pose] of poses.entries()) {
      const scale = args?.scales?.[k] ?? 1;
      withBeam.setQuality({ scale });
      without.setQuality({ scale });
      withBeam.render(pose, 0, k);
      without.render(pose, 0, k);
      const res = withBeam.stats.res;
      sizes.push([...res]);
      const [d1, d0] = [new Float32Array(await readTexture(withBeam.texture('gDepth'))), new Float32Array(await readTexture(without.texture('gDepth')))];
      const [h1, h0] = [new Uint32Array(await readTexture(withBeam.texture('gHit'))), new Uint32Array(await readTexture(without.texture('gHit')))];
      const beamTex = withBeam.texture('beam');
      const beam = new Float32Array(await readTexture(beamTex));
      const { forward } = cameraBasis(pose.yaw, pose.pitch);
      for (let y = 0; y < res[1]; y++) {
        for (let x = 0; x < res[0]; x++) {
          const i = y * alloc[0] + x;
          compared++;
          if (d1[i] !== d0[i] || h1[i * 2] !== h0[i * 2] || h1[i * 2 + 1] !== h0[i * 2 + 1]) {
            differ++;
            if (firstDiffs.length < 6) firstDiffs.push(`pose ${k} (${x}, ${y}) depth ${d1[i]} vs ${d0[i]}`);
          }
          const rd = rayDir(pose, res, x + 0.5, y + 0.5);
          const start = beam[(y >> 3) * beamTex.width + (x >> 3)] / (rd[0] * forward[0] + rd[1] * forward[1] + rd[2] * forward[2]);
          if (d0[i] < 1e8 && start > d0[i] + 1e-3) beyond++;
          if (k === 3 && beam[(y >> 3) * beamTex.width + (x >> 3)] !== 0) insideNonZero++;
          if (k === 2) elevatedStart += start / (res[0] * res[1]);
        }
      }
    }
    for (const b of [world.table, world.sectors, world.heap, world.palette, world.pyramid]) b.destroy();
    return { compared, sizes, differ, beyond, insideNonZero, elevatedStart, firstDiffs, errors: [...g.errors] };
  },
};
