/**
 * Bootstrap: generate the world in workers while the GPU device comes up,
 * upload it, compile the renderer, and draw it from a fly camera at the
 * front-line bay at dusk. `window.__trenchline` exposes hooks the tests use.
 */

import { loadTunables } from '../core/tunables';
import { createGpu, GpuUnavailable, type Gpu } from '../render/device';
import { FarFieldGpu } from '../render/farfield-gpu';
import { GpuWorld } from '../render/gpu-world';
import { sceneLights } from '../render/lights';
import { compileFrame, Renderer } from '../render/renderer';
import { frameSky, skyState } from '../render/sky-state';
import { fingerprint } from '../world/fingerprint';
import { FlyCam } from './flycam';
import { generateInWorkers } from './generate-in-workers';
import { standardViews, VIEW_NAMES, type ViewName } from './views';

const statusEl = document.getElementById('status')!;
const canvas = document.getElementById('view') as HTMLCanvasElement;
const hooks: Record<string, unknown> = { ready: false };
(window as unknown as { __trenchline: unknown }).__trenchline = hooks;

function say(text: string): void {
  statusEl.textContent = text;
}

function fail(error: unknown): void {
  const message =
    error instanceof GpuUnavailable && error.reason === 'no-webgpu'
      ? 'TRENCHLINE needs WebGPU: use Chrome, Edge or Safari 26.'
      : `TRENCHLINE could not start: ${error instanceof Error ? error.message : String(error)}`;
  say(message);
  hooks.error = message;
  hooks.ready = true;
}

async function start(): Promise<void> {
  say('TRENCHLINE — generating the world…');
  // The device comes up and the pipelines compile while the workers generate.
  const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));
  const gpuReady: Promise<Gpu | Error> = createGpu().catch(asError);
  const compiling = gpuReady.then((g) => (g instanceof Error ? g : compileFrame(g.device).catch(asError)));
  const world = await generateInWorkers(7, (phase, done, total) => say(`TRENCHLINE — generating: ${phase} ${done}/${total}`));
  const gpu = await gpuReady;
  if (gpu instanceof Error) throw gpu;

  let t = performance.now();
  const gpuWorld = GpuWorld.create(gpu.device, world);
  world.timings.upload = Math.round(performance.now() - t);
  t = performance.now();
  const far = FarFieldGpu.create(gpu.device, world.farField);
  world.timings.farUpload = Math.round(performance.now() - t);
  t = performance.now();
  const compiled = await compiling;
  if (compiled instanceof Error) throw compiled;
  world.timings.pipelinesWait = Math.round(performance.now() - t);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(canvas.clientWidth * dpr);
  canvas.height = Math.floor(canvas.clientHeight * dpr);
  const renderer = await Renderer.create(gpu, canvas, gpuWorld, world.plan, { megapixels: 1.5, far, compiled });

  const views = standardViews(world.plan, world.spawn);
  const cam = new FlyCam(views.bay);
  let timeOfDay = views.bay.time;
  // The light follows the time of day; the flares burn as it says.
  const tun = loadTunables();
  const lights = sceneLights(world.plan, tun);
  let litFor = Number.NaN;
  const light = () => {
    if (timeOfDay === litFor) return;
    litFor = timeOfDay;
    const sky = skyState(tun, timeOfDay);
    renderer.sky = frameSky(sky, tun);
    renderer.setLights(lights, sky.flares);
  };
  const keys = new Set<string>();
  const look: [number, number] = [0, 0];
  window.addEventListener('keydown', (e) => keys.add(e.code));
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  canvas.addEventListener('click', () => canvas.requestPointerLock());
  window.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    look[0] += e.movementX;
    look[1] += e.movementY;
  });

  let frames = 0;
  let last = performance.now();
  let shown = 0;
  const waiting: { until: number; resolve: () => void }[] = [];
  let snapshot: ((stats: { mean: number; std: number }) => void) | null = null;

  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    cam.update(dt, keys, look);
    look[0] = 0;
    look[1] = 0;
    light();
    renderer.render(cam.pose, timeOfDay, now);
    frames++;
    if (snapshot) {
      const take = snapshot;
      snapshot = null;
      take(canvasStats());
    }
    if (!hooks.ready) {
      hooks.ready = true;
      hooks.ms = Math.round(now);
    }
    for (let i = waiting.length - 1; i >= 0; i--) {
      if (frames >= waiting[i].until) {
        waiting[i].resolve();
        waiting.splice(i, 1);
      }
    }
    if (now - shown > 250) {
      shown = now;
      const s = renderer.stats;
      const p = cam.pose.position.map((v) => v.toFixed(1)).join(', ');
      say(`TRENCHLINE  ${s.gpuMs === null ? '…' : `${s.gpuMs.toFixed(2)} ms GPU`}  ${s.res[0]}×${s.res[1]}  at ${p}`);
    }
    requestAnimationFrame(frame);
  };

  /** The canvas, shrunk to 160 × 100, as luminance statistics: a frame that is not blank has spread. */
  function canvasStats(): { mean: number; std: number } {
    const small = document.createElement('canvas');
    small.width = 160;
    small.height = 100;
    const g = small.getContext('2d')!;
    g.drawImage(canvas, 0, 0, 160, 100);
    const px = g.getImageData(0, 0, 160, 100).data;
    let sum = 0;
    let sq = 0;
    const n = px.length / 4;
    for (let i = 0; i < px.length; i += 4) {
      const l = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
      sum += l;
      sq += l * l;
    }
    const mean = sum / n;
    return { mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
  }

  Object.assign(hooks, {
    world,
    renderer,
    timings: world.timings,
    view(name: ViewName) {
      if (!VIEW_NAMES.includes(name)) throw new Error(`no view '${name}'`);
      const v = views[name];
      cam.pose = { position: [...v.position], yaw: v.yaw, pitch: v.pitch };
      timeOfDay = v.time;
    },
    setTimeOfDay(value: number) {
      timeOfDay = value;
    },
    frames: () => frames,
    waitFrames: (n: number) => new Promise<void>((resolve) => waiting.push({ until: frames + n, resolve })),
    stats: () => renderer.stats,
    snapshot: () => new Promise<{ mean: number; std: number }>((resolve) => (snapshot = resolve)),
    fingerprint: () => fingerprint(world.map),
  });
  requestAnimationFrame(frame);
}

start().catch(fail);
