import { gpu, readBuffer } from '../support/gpu';

export const cases = {
  /** 64 threads each write the square of their index. */
  async device() {
    const { device, errors } = await gpu();
    const module = device.createShaderModule({
      code: `@group(0) @binding(0) var<storage, read_write> out: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) { out[g.x] = g.x * g.x; }`,
    });
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const buffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer } }] });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    device.queue.submit([encoder.finish()]);
    const values = Array.from(new Uint32Array(await readBuffer(buffer, 256)));
    buffer.destroy();
    return { values, errors: [...errors] };
  },
};
