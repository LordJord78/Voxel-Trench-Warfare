import { Rng } from '../../../src/core/rng';
import { loadTunables } from '../../../src/core/tunables';
import { cellGrid, CELL_LIGHTS, CELL_METRES, LightCells } from '../../../src/render/light-cells';
import { lightBuffer, MAX_LIGHTS, type SceneLight } from '../../../src/render/lights';
import { genParams } from '../../../src/world/generation/params';
import { cellLists } from '../../support/light-cells-ref';
import { gpu, readBuffer } from '../support/gpu';

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

export const cases = {
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
