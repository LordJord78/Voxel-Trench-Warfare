import { Rng } from '../../../src/core/rng';
import { loadTunables } from '../../../src/core/tunables';
import { jitter, rayDir, type CameraPose } from '../../../src/render/camera';
import { FLAGS, PROBE_DUSK } from '../../../src/render/frame-uniforms';
import { GpuWorld } from '../../../src/render/gpu-world';
import { cellGrid, CELL_LIGHTS, CELL_METRES, LightCells } from '../../../src/render/light-cells';
import { lightBuffer, MAX_LIGHTS, type SceneLight } from '../../../src/render/lights';
import { Renderer } from '../../../src/render/renderer';
import { BrickMap } from '../../../src/world/bricks';
import { HeapMirror } from '../../../src/world/encode';
import { genParams } from '../../../src/world/generation/params';
import { P } from '../../../src/world/materials';
import { cellLists } from '../../support/light-cells-ref';
import { gpu, readBuffer, readTexture } from '../support/gpu';
import { halfToFloat } from '../support/half';
import { analytic } from './lighting';

const lamp = (position: [number, number, number], radius: number): SceneLight => ({ position, radius, colour: [1, 1, 1], intensity: 1, kind: 'lantern', phase: 0 });

/**
 * 1,024 lights over the map, all on an eighth of a voxel (positions and radii), so that the GPU's
 * f32 arithmetic is exact and its lists must match the reference's exactly: 960 spread over the
 * map's x below 200 m (radius 1-20 m, up to 30 m high), so the cells past 220 m are empty, and 64
 * within 2 m of a point in one cell, which more than 32 then reach.
 */
function testLights(seed: number, voxel: number, crowdAt: [number, number]): SceneLight[] {
  const rng = Rng.root(seed).derive('test.light-cells');
  const eighth = (m: number) => (Math.round((m / voxel) * 8) / 8) * voxel;
  const lights: SceneLight[] = [];
  for (let i = 0; i < 960; i++) {
    lights.push(lamp([eighth(rng.uniform(0, 200)), eighth(rng.uniform(0, 30)), eighth(rng.uniform(0, 256))], eighth(rng.uniform(1, 20))));
  }
  for (let i = 0; i < MAX_LIGHTS - 960; i++) {
    lights.push(lamp([eighth(crowdAt[0] + rng.uniform(-2, 2)), eighth(rng.uniform(0, 30)), eighth(crowdAt[1] + rng.uniform(-2, 2))], eighth(rng.uniform(3, 6))));
  }
  return lights;
}

/**
 * An open floor 4 m down, 12.8 m square, the camera 5.6 m over its middle looking straight down
 * (as the lighting cases have it), lit by `lights` at dusk with the key and sky dark: the renderer,
 * and the point light at the middle lighting pixel each frame. Given `block`, a box stands on the
 * floor and the camera looks at its corner instead.
 */
async function floor(lights: SceneLight[], block?: { from: [number, number, number]; to: [number, number, number]; pose: CameraPose }, size = 64) {
  const g = await gpu();
  const map = new BrickMap({ x: 128, y: 128, z: 128 });
  map.fillBox(0, 0, 0, 128, 40, 128, P.SOD);
  if (block) map.fillBox(...block.from, ...block.to, P.CONCRETE);
  const world = GpuWorld.create(g.device, { map, mirror: HeapMirror.fromMap(map) });
  const renderer = await Renderer.create(g, null, world, null, { size: [size, size] });
  renderer.sky = { ...PROBE_DUSK, keyColour: [0, 0, 0], sunLight: [0, 0, 0], moonLight: [0, 0, 0] };
  renderer.setLights(lights, 1);
  const pose: CameraPose = block?.pose ?? { position: [6.4, 9.6, 6.4], yaw: 0, pitch: -89.9 };
  const [lw, lh] = renderer.lightResolution;
  const middle = ((lh >> 1) * lw + (lw >> 1)) * 4;
  let frame = 0;
  if (lw !== size / 2 || lh !== size / 2) throw new Error(`the floor's lighting grid is ${lw} × ${lh}, not half of ${size} at scale 2`);
  return {
    g,
    renderer,
    world,
    /** The floor's top face under the middle pixel, in metres. */
    at: [pose.position[0], 4.0, pose.position[2]] as [number, number, number],
    /** Render a frame; the middle lighting pixel's point light (rgb). */
    async render(): Promise<number[]> {
      renderer.render(pose, 0, frame++ * 16);
      const px = new Uint16Array(await readTexture(renderer.texture('lNoisy')));
      return [0, 1, 2].map((c) => halfToFloat(px[middle + c]));
    },
    /**
     * Render a frame; every lighting pixel's point light (rgb), and the point of the floor it lit
     * (metres): its representative pixel this frame (lightgrid.wgsl, a 2 × 2 block's), through the
     * frame's jitter, down to the floor, just off it as the lighting pass weighs it.
     */
    async renderAll(): Promise<{ light: number[][]; at: [number, number, number][] }> {
      const f = frame;
      renderer.render(pose, 0, frame++ * 16);
      const px = new Uint16Array(await readTexture(renderer.texture('lNoisy')));
      const [res, scale] = [[size, size] as [number, number], 2];
      const o = [[0, 0], [1, 1], [1, 0], [0, 1]][f & 3];
      const j = jitter(f);
      const light: number[][] = [];
      const at: [number, number, number][] = [];
      for (let qy = 0; qy < lh; qy++) {
        for (let qx = 0; qx < lw; qx++) {
          const i = (qy * lw + qx) * 4;
          light.push([0, 1, 2].map((c) => halfToFloat(px[i + c])));
          const d = rayDir(pose, res, qx * scale + o[0] + 0.5 + j[0], qy * scale + o[1] + 0.5 + j[1]);
          const t = (4.0 - pose.position[1]) / d[1];
          at.push([pose.position[0] + d[0] * t, 4.002, pose.position[2] + d[2] * t]);
        }
      }
      return { light, at };
    },
    destroy() {
      for (const b of [world.table, world.sectors, world.heap, world.palette, world.pyramid]) b.destroy();
    },
  };
}

const bulb = (position: [number, number, number], intensity: number, colour: [number, number, number] = [1, 1, 1], radius = 30): SceneLight => ({
  position, radius, colour, intensity, kind: 'lantern', phase: 0,
});

export const cases = {
  /**
   * Six lights round the floor's middle, of several colours: every lighting pixel's point light
   * over `frames` frames, its mean (rgb) against the mean of the lights' unshadowed light summed at
   * the points they lit. (One pixel's history spans some 20 frames, so a pixel alone is far from
   * that many samples: the whole floor's pixels, each with its own history, are.)
   */
  async restirMean(args: { frames: number }) {
    const lights = [
      bulb([5.0, 6.0, 6.4], 3, [1, 0.6, 0.3]),
      bulb([8.0, 5.0, 7.0], 1),
      bulb([6.4, 8.0, 3.0], 5, [0.4, 0.7, 1]),
      bulb([9.5, 4.5, 9.5], 2),
      bulb([3.0, 7.0, 9.0], 4, [1, 0.3, 0.2]),
      bulb([6.0, 4.6, 5.8], 0.5),
    ];
    const s = await floor(lights);
    const sum = [0, 0, 0];
    const want = [0, 1, 2].map(() => 0);
    let n = 0;
    for (let f = 0; f < args.frames; f++) {
      const { light, at } = await s.renderAll();
      light.forEach((v, i) => {
        for (let c = 0; c < 3; c++) {
          sum[c] += v[c];
          want[c] += lights.reduce((t, l) => t + analytic(l, at[i])[c], 0);
        }
        n++;
      });
    }
    s.destroy();
    return { mean: sum.map((v) => v / n), want: want.map((v) => v / n), errors: [...s.g.errors] };
  },

  /**
   * One light, lit for 32 frames; then moved, and the very next frame's point light at the
   * middle against a floor lit from the start by the light where it is now, on the same frame
   * (so at the same point of the middle's block); then moved out of the floor's reach, and the
   * next frame's.
   */
  async restirMoved() {
    const moved = bulb([7.5, 5.5, 6.0], 3);
    const s = await floor([bulb([6.0, 6.5, 6.4], 3)]);
    const fresh = await floor([moved]);
    for (let f = 0; f < 32; f++) {
      await s.render();
      await fresh.render();
    }
    s.renderer.setLights([moved], 1);
    const there = await s.render();
    const want = await fresh.render();
    s.renderer.setLights([bulb([6.0, 6.5, 6.4], 3, [1, 1, 1], 1)], 1);
    const gone = await s.render();
    s.destroy();
    fresh.destroy();
    return { there, want, gone, errors: [...s.g.errors] };
  },

  /**
   * Two lights, the second out of the floor's reach for 32 frames and then brought within it: the
   * floor's mean point light (rgb) the frame it arrives, against a floor lit by both from the start
   * on the same frame. Its history never had the newcomer, so this frame's candidates alone can have
   * drawn it.
   */
  async restirArrived() {
    const stay = bulb([5.0, 6.0, 6.4], 3);
    const come = bulb([8.0, 5.5, 7.0], 3, [0.4, 0.7, 1]);
    const away = bulb([8.0, 5.5, 7.0], 3, [0.4, 0.7, 1], 1);
    const s = await floor([stay, away]);
    const fresh = await floor([stay, come]);
    for (let f = 0; f < 32; f++) {
      await s.render();
      await fresh.render();
    }
    s.renderer.setLights([stay, come], 1);
    const mean = async (x: Awaited<ReturnType<typeof floor>>) => {
      const { light } = await x.renderAll();
      return [0, 1, 2].map((c) => light.reduce((t, v) => t + v[c], 0) / light.length);
    };
    const arrived = await mean(s);
    const want = await mean(fresh);
    s.destroy();
    fresh.destroy();
    return { arrived, want, errors: [...s.g.errors] };
  },

  /**
   * A block's corner, its -z face lit red from in front and its +x face blue from the side, each
   * light behind the other face's plane: over `frames` frames, how many lighting pixels lay on
   * each face, the most blue any pixel on the -z face had and the most red any on the +x face had,
   * and each face's mean of its own light.
   */
  async restirCorner(args: { frames: number }) {
    const red = bulb([5.5, 6.0, 4.5], 3, [1, 0, 0]);
    const blue = bulb([8.5, 6.0, 7.5], 3, [0, 0, 1]);
    // The block from (4, 4, 6) m to (7, 8, 9) m; the camera off its corner at (7, 6, 6), looking at it.
    const s = await floor([red, blue], { from: [40, 40, 60], to: [70, 80, 90], pose: { position: [9.5, 6.5, 3.5], yaw: -45, pitch: -8 } });
    const [lw, lh] = s.renderer.lightResolution;
    const out = { front: 0, side: 0, blueOnFront: 0, redOnSide: 0, frontRed: 0, sideBlue: 0 };
    for (let f = 0; f < args.frames; f++) {
      const { light } = await s.renderAll();
      const hit = new Uint32Array(await readTexture(s.renderer.texture('hHit')));
      for (let i = 0; i < lw * lh; i++) {
        const face = (hit[i * 2] >>> 24) & 7;
        if (face === 4) {
          out.front++;
          out.blueOnFront = Math.max(out.blueOnFront, light[i][2]);
          out.frontRed += light[i][0];
        } else if (face === 1) {
          out.side++;
          out.redOnSide = Math.max(out.redOnSide, light[i][0]);
          out.sideBlue += light[i][2];
        }
      }
    }
    s.destroy();
    return { ...out, frontRed: out.frontRed / out.front, sideBlue: out.sideBlue / out.side, errors: [...s.g.errors] };
  },

  /**
   * Six lights 2 to 3 m over the floor, rendered `size` square: each lighting pixel's point light
   * (its luminance) over `frames` frames after `warm`, its error against the lights' own sum at its
   * point, root-mean-square over its share of that sum; the history started afresh every `cycle`
   * frames if given (as a camera cut does); with neighbours sharing their picks, or (`spatial`
   * false) not.
   */
  async restirNoise(args: { frames: number; warm: number; size: number; spatial: boolean; cycle?: number; many?: boolean; plain?: boolean }) {
    // Six lights, or (`many`) twenty-four: three times what a pixel draws a frame, so its
    // candidates do not take in every light.
    const lights = args.many
      ? Array.from({ length: 24 }, (_, i) => {
          const a = i * 2.39996;
          const r = 1.2 + 4.6 * Math.sqrt((i + 0.5) / 24);
          return bulb([6.4 + r * Math.cos(a), 6.0 + (i % 3) * 0.5, 6.4 + r * Math.sin(a)], 1 + (i % 4));
        })
      : [
          bulb([4.0, 6.5, 5.0], 3),
          bulb([8.5, 6.0, 4.5], 3),
          bulb([6.4, 7.0, 8.8], 3),
          bulb([3.5, 6.0, 8.5], 2),
          bulb([9.0, 6.5, 8.0], 2),
          bulb([6.4, 6.0, 2.5], 2),
        ];
    const s = await floor(lights, undefined, args.size);
    if (!args.spatial) s.renderer.flags |= FLAGS.SPATIAL_OFF;
    if (args.plain) s.renderer.flags |= FLAGS.SPATIAL_OFF | FLAGS.RESERVOIR_HISTORY_OFF;
    const lum = (v: number[]) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    let err = 0;
    let n = 0;
    for (let f = 0; f < args.warm + args.frames; f++) {
      if (args.cycle && f % args.cycle === 0) s.renderer.resetHistory();
      const { light, at } = await s.renderAll();
      if (f < args.warm) continue;
      light.forEach((v, i) => {
        const want = lum([0, 1, 2].map((c) => lights.reduce((t, x) => t + analytic(x, at[i])[c], 0)));
        err += ((lum(v) - want) / want) ** 2;
        n++;
      });
    }
    s.destroy();
    return { error: Math.sqrt(err / n), errors: [...s.g.errors] };
  },

  /**
   * The middle lighting pixel's temporal reservoir (light, W, M) after each of `frames` frames, the
   * history started afresh before frame `reset`; and whether every lighting pixel's reservoir
   * holds one of the frame's lights (or none) with a weight that is a number, not negative.
   */
  async restirReservoirs(args: { frames: number; reset: number }) {
    const s = await floor([bulb([5.0, 6.0, 6.4], 3), bulb([8.0, 5.0, 7.0], 1), bulb([6.4, 8.0, 3.0], 5)]);
    // The temporal merge's own reservoirs: neighbours do not share, so the shaded ones are those.
    s.renderer.flags |= FLAGS.SPATIAL_OFF;
    const [lw, lh] = s.renderer.lightResolution;
    const middle = (lh >> 1) * s.renderer.lightStride + (lw >> 1);
    const seen: { light: number; weight: number; count: number }[] = [];
    let sound = true;
    for (let f = 0; f < args.frames; f++) {
      if (f === args.reset) s.renderer.resetHistory();
      await s.render();
      const data = await readBuffer(s.renderer.reservoirs(), s.renderer.lightStride * lh * 16);
      const u = new Uint32Array(data);
      const v = new Float32Array(data);
      seen.push({ light: u[middle * 4] | 0, weight: v[middle * 4 + 1], count: v[middle * 4 + 2] });
      for (let y = 0; y < lh; y++) {
        for (let x = 0; x < lw; x++) {
          const i = (y * s.renderer.lightStride + x) * 4;
          const light = u[i] | 0;
          if (!(light === -1 || (light >= 0 && light < 3)) || !(v[i + 1] >= 0) || !Number.isFinite(v[i + 1])) sound = false;
        }
      }
    }
    s.destroy();
    return { seen, sound, errors: [...s.g.errors] };
  },

  /**
   * The light cells built on the GPU for `testLights`, after a build in which 200 lights reached
   * every cell (so a cell left empty must have been emptied): the cells whose list differs from the
   * reference's, in each build, the cells with none, the crowded cell's count and whether it is the reference's,
   * and the build's GPU time in a frame, the median of `runs` (null without timestamp queries).
   */
  async lightCells(args: { seed: number; runs: number }) {
    const g = await gpu();
    const device = g.device;
    const p = genParams(loadTunables());
    const voxel = p.voxel;
    const grid = cellGrid(p.dims, voxel);
    const crowdAt: [number, number] = [CELL_METRES * 3.5, CELL_METRES * 20.5];
    const lights = testLights(args.seed, voxel, crowdAt);
    // Room past the lights for the work the timed builds wait on.
    const buffer = device.createBuffer({ size: (MAX_LIGHTS + 64) * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const cells = LightCells.create(device, await LightCells.compile(device), buffer, grid, voxel);
    const build = (data: Float32Array, timestampWrites?: GPUComputePassTimestampWrites) => {
      device.queue.writeBuffer(buffer, 0, data);
      const encoder = device.createCommandEncoder();
      cells.encode(encoder, data.length / 8, timestampWrites);
      device.queue.submit([encoder.finish()]);
    };
    const stride = 1 + CELL_LIGHTS;
    const read = async () => new Uint32Array(await readBuffer(cells.cells, grid[0] * grid[1] * stride * 4));
    const listOf = (words: Uint32Array, c: number) => Array.from(words.subarray(c * stride + 1, c * stride + 1 + words[c * stride]));
    // The reference from the very numbers the GPU read.
    const reference = (data: Float32Array) =>
      cellLists(
        Array.from({ length: data.length / 8 }, (_, i) => ({ pos: [data[i * 8], data[i * 8 + 1], data[i * 8 + 2]] as [number, number, number], radius: data[i * 8 + 3] })),
        grid,
        Math.fround(CELL_METRES / voxel),
        CELL_LIGHTS,
      );
    // A first build that fills every cell: 200 lights reaching everywhere, more than a cell gathers
    // in workgroup memory, so every cell ranks them from the lights themselves.
    const dense = lightBuffer(lights.slice(0, 200).map((l) => ({ ...l, radius: 1e4 })), 1, voxel);
    build(dense);
    const denseWords = await read();
    const denseMismatched = reference(dense).flatMap((list, c) => (listOf(denseWords, c).join() === list.join() ? [] : [c]));
    const data = lightBuffer(lights, 1, voxel);
    build(data);
    const words = await read();
    const ref = reference(data);
    const listed = (c: number) => listOf(words, c);
    const counts = ref.map((_, c) => words[c * stride]);
    const mismatched = ref.flatMap((list, c) => (listed(c).join() === list.join() ? [] : [c]));
    const crowdCell = Math.floor(crowdAt[1] / CELL_METRES) * grid[0] + Math.floor(crowdAt[0] / CELL_METRES);
    const reaching = lights.filter((l) => Math.abs(l.position[0] - crowdAt[0]) < 3 && Math.abs(l.position[2] - crowdAt[1]) < 3).length;
    // The build's GPU time as a frame meets it: straight after some 15 ms of other work, which it
    // waits on (a pass writing past the lights in their buffer), with the GPU at a frame's clocks.
    let ms: number | null = null;
    if (g.timestamps) {
      const busy = device.createComputePipeline({
        layout: 'auto',
        compute: {
          module: device.createShaderModule({
            code: `@group(0) @binding(0) var<storage, read_write> out: array<f32>;
              @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
                var x = f32(g.x);
                for (var i = 0u; i < 20000u; i++) { x = fract(x * 1.0001 + 0.37); }
                out[${MAX_LIGHTS * 8}u + (g.x & 511u)] = x;
              }`,
          }),
          entryPoint: 'main',
        },
      });
      const busyGroup = device.createBindGroup({ layout: busy.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer } }] });
      const times: number[] = [];
      const querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
      const resolved = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      for (let i = 0; i < 3 + args.runs; i++) {
        device.queue.writeBuffer(buffer, 0, data);
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(busy);
        pass.setBindGroup(0, busyGroup);
        for (let k = 0; k < 4; k++) pass.dispatchWorkgroups(1024);
        pass.end();
        cells.encode(encoder, MAX_LIGHTS, { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 });
        encoder.resolveQuerySet(querySet, 0, 2, resolved, 0);
        device.queue.submit([encoder.finish()]);
        const [t0, t1] = new BigUint64Array(await readBuffer(resolved, 16));
        if (i >= 3) times.push(Number(t1 - t0) / 1e6);
      }
      times.sort((a, b) => a - b);
      ms = times[times.length >> 1];
      querySet.destroy();
      resolved.destroy();
    }
    cells.destroy();
    buffer.destroy();
    return {
      cells: ref.length,
      mismatched,
      denseMismatched,
      empty: counts.filter((n, c) => n === 0 && ref[c].length === 0).length,
      refEmpty: ref.filter((l) => l.length === 0).length,
      crowd: { reaching, count: counts[crowdCell], same: listed(crowdCell).join() === ref[crowdCell].join() },
      ms,
      errors: [...g.errors],
    };
  },
};
