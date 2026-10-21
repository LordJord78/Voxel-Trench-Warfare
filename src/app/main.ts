// Bootstrap. For now it generates the world across the worker pool and reports
// each phase, which is what the renderer (milestone 4) will start from.
import { generateInWorkers } from './generate-in-workers';

const statusEl = document.getElementById('status')!;
const lines = ['TRENCHLINE — building', `WebGPU available: ${'gpu' in navigator ? 'yes' : 'no'}`, 'generating the world…'];
const show = () => (statusEl.textContent = lines.join('\n'));
show();

const t0 = performance.now();
generateInWorkers(7, (phase, done, total) => {
  lines[2] = `generating: ${phase} ${done}/${total}`;
  show();
})
  .then((world) => {
    const ms = Math.round(performance.now() - t0);
    lines[2] = `generated in ${ms} ms`;
    lines.push(`phases (ms): ${JSON.stringify(world.timings)}`);
    lines.push(`dense bricks: ${world.map.denseCount}`);
    lines.push(`spawn (m): ${world.spawn.position.map((v) => v.toFixed(1)).join(', ')}`);
    show();
    (window as unknown as { __trenchline: unknown }).__trenchline = { world, ms, ready: true };
  })
  .catch((error: unknown) => {
    lines.push(`generation failed: ${String(error)}`);
    show();
    (window as unknown as { __trenchline: unknown }).__trenchline = { error: String(error), ready: true };
  });
