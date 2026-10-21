import { HeapMirror } from '../../../src/world/encode';
import { P } from '../../../src/world/materials';
import { GpuWorld } from '../../../src/render/gpu-world';
import { buildPyramid } from '../../../src/render/pyramid';
import { gpu, readBuffer } from '../support/gpu';
import { syntheticWorld } from '../../support/synthetic';

function differences(a: Uint32Array, b: Uint32Array): number {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

async function readU32(buffer: GPUBuffer, count: number): Promise<Uint32Array> {
  return new Uint32Array(await readBuffer(buffer, count * 4));
}

export const cases = {
  /** Upload the synthetic world and read every buffer back. */
  async worldUpload() {
    const { device, errors } = await gpu();
    const map = syntheticWorld(1);
    const mirror = HeapMirror.fromMap(map);
    const world = GpuWorld.create(device, { map, mirror });
    const pyramid = buildPyramid(map);
    const result = {
      table: differences(await readU32(world.table, map.table.length), mirror.gpuTable),
      sectors: differences(await readU32(world.sectors, map.sectorMask().length), map.sectorMask()),
      heap: differences(await readU32(world.heap, mirror.usedUnits * 4), mirror.heapView()),
      pyramid: differences(await readU32(world.pyramid, pyramid.data.length), pyramid.data),
      errors: [...errors],
    };
    for (const b of [world.table, world.sectors, world.heap, world.palette, world.pyramid]) b.destroy();
    return result;
  },

  /** With no headroom, an edit that needs new records must grow the heap and keep its contents. */
  async worldGrowth() {
    const { device, errors } = await gpu();
    const map = syntheticWorld(2);
    const mirror = HeapMirror.fromMap(map);
    const world = GpuWorld.create(device, { map, mirror }, { headroom: 0 });
    for (let k = 0; k < 6; k++) map.fillBox(10 + 40 * k, 90, 10, 30 + 40 * k, 100, 240, k % 2 ? P.SANDBAG : P.TIMBER);
    for (let k = 0; k < 200; k++) map.set(12 + k, 95, 12, P.WIRE);
    world.takeEdits();
    while (world.queue.pending > 0) world.flush(1 << 30, [128, 95, 128]);
    const result = {
      generation: world.generation,
      table: differences(await readU32(world.table, map.table.length), mirror.gpuTable),
      heap: differences(await readU32(world.heap, mirror.usedUnits * 4), mirror.heapView()),
      errors: [...errors],
    };
    for (const b of [world.table, world.sectors, world.heap, world.palette, world.pyramid]) b.destroy();
    return result;
  },
};
