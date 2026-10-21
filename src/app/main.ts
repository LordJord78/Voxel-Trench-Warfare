/**
 * Bootstrap: generate the world in workers while the GPU device comes up,
 * upload it, compile the renderer, and draw it from a fly camera at the
 * front-line bay at dusk. Keys (keys.ts) jump between views and change the
 * time of day and quality; F3 shows what every frame costs. When the game
 * cannot run, or the GPU goes away, it stops and says why in the status line.
 * `window.__trenchline` exposes hooks the tests use.
 */

import { loadTunables } from '../core/tunables';
import { createGpu, GpuUnavailable, type Gpu } from '../render/device';
import { FarFieldGpu } from '../render/farfield-gpu';
import { GpuWorld } from '../render/gpu-world';
import { sceneLights } from '../render/lights';
import { rendererTunables } from '../render/quality';
import { compileFrame, Renderer, type Quality } from '../render/renderer';
import { frameSky, skyState } from '../render/sky-state';
import { Overlay, placeName } from '../ui/overlay';
import { fingerprint } from '../world/fingerprint';
import { FlyCam } from './flycam';
import { generateInWorkers } from './generate-in-workers';
import { actionFor, nextTimeKey, stepTime, type KeyAction } from './keys';
import { standardViews, VIEW_NAMES, type ViewName } from './views';

/** A canvas resize settles this long before the internal images are reallocated. */
const RESIZE_SETTLE_MS = 150;

const statusEl = document.getElementById('status')!;
const canvas = document.getElementById('view') as HTMLCanvasElement;
const hooks: Record<string, unknown> = { ready: false };
(window as unknown as { __trenchline: unknown }).__trenchline = hooks;
/** Set once the game has stopped for good: its message stays, and no more frames are drawn. */
let stopped = false;

function say(text: string): void {
  if (!stopped) statusEl.textContent = text;
}

function stop(message: string): void {
  say(message);
  stopped = true;
  hooks.error = message;
  hooks.ready = true;
  hooks.ms ??= Math.round(performance.now());
}

function fail(error: unknown): void {
  stop(
    error instanceof GpuUnavailable && error.reason === 'no-webgpu'
      ? 'TRENCHLINE needs WebGPU: use Chrome, Edge or Safari 26.'
      : `TRENCHLINE could not start: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/** The canvas in device pixels: its CSS size at up to twice the CSS pixel density. */
function canvasTarget(): [number, number] {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  return [Math.max(1, Math.floor(canvas.clientWidth * dpr)), Math.max(1, Math.floor(canvas.clientHeight * dpr))];
}

async function start(): Promise<void> {
  say('TRENCHLINE — generating the world…');
  // The device comes up and the pipelines compile while the workers generate.
  const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));
  const gpuReady: Promise<Gpu | Error> = createGpu().catch(asError);
  // Without a GPU there is nothing to draw: say so at once, not after generating a world.
  void gpuReady.then((g) => g instanceof Error && fail(g));
  const compiling = gpuReady.then((g) => (g instanceof Error ? g : compileFrame(g.device).catch(asError)));
  const world = await generateInWorkers(7, (phase, done, total) => say(`TRENCHLINE — generating: ${phase} ${done}/${total}`));
  const gpu = await gpuReady;
  if (gpu instanceof Error || stopped) return;
  void gpu.device.lost.then((info) => {
    console.warn(`[gpu] device lost (${info.reason}): ${info.message}`);
    stop(`The graphics device was lost (${info.reason}). Reload the page to continue.`);
  });

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
  [canvas.width, canvas.height] = canvasTarget();
  const tun = loadTunables();
  const renderer = await Renderer.create(gpu, canvas, gpuWorld, world.plan, { ...rendererTunables(tun), far, compiled, dynres: true });

  const views = standardViews(world.plan, world.spawn);
  const cam = new FlyCam(views.bay);
  let timeOfDay = views.bay.time;
  const goTo = (name: ViewName) => {
    const v = views[name];
    cam.pose = { position: [...v.position], yaw: v.yaw, pitch: v.pitch };
    timeOfDay = v.time;
  };
  // The light follows the time of day; the flares burn as it says.
  const lights = sceneLights(world.plan, tun);
  let litFor = Number.NaN;
  const light = () => {
    if (timeOfDay === litFor) return;
    litFor = timeOfDay;
    const sky = skyState(tun, timeOfDay);
    renderer.sky = frameSky(sky, tun);
    renderer.setLights(lights, sky.flares);
  };

  const overlay = new Overlay(document.body);
  const act = (a: KeyAction) => {
    switch (a.kind) {
      case 'view':
        goTo(a.name);
        break;
      case 'time-next':
        timeOfDay = nextTimeKey(timeOfDay);
        break;
      case 'time-step':
        timeOfDay = stepTime(timeOfDay, a.by);
        break;
      case 'preset':
        renderer.setQuality({ preset: renderer.quality.preset === 'high' ? 'low' : 'high' });
        break;
      case 'dynres':
        renderer.setQuality({ dynres: !renderer.quality.dynres });
        break;
      case 'overlay':
        overlay.toggle();
        break;
    }
  };
  const keys = new Set<string>();
  const look: [number, number] = [0, 0];
  window.addEventListener('keydown', (e) => {
    keys.add(e.code);
    // Leave the browser's own shortcuts (reload, find) alone; held keys repeat only the time steps.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const action = actionFor(e.code);
    if (!action || (e.repeat && action.kind !== 'time-step')) return;
    e.preventDefault();
    act(action);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  canvas.addEventListener('click', () => canvas.requestPointerLock());
  window.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    look[0] += e.movementX;
    look[1] += e.movementY;
  });

  // A new canvas size is applied once it has held for RESIZE_SETTLE_MS, so dragging a window
  // edge does not reallocate every frame; until then the browser stretches the last image.
  let resizing: { size: [number, number]; since: number } | null = null;
  const followCanvas = (now: number) => {
    const want = canvasTarget();
    if (want[0] === canvas.width && want[1] === canvas.height) {
      resizing = null;
    } else if (!resizing || resizing.size[0] !== want[0] || resizing.size[1] !== want[1]) {
      resizing = { size: want, since: now };
    } else if (now - resizing.since >= RESIZE_SETTLE_MS) {
      renderer.resize(...want);
      resizing = null;
    }
  };

  let frames = 0;
  let last = performance.now();
  let shown = 0;
  /** Smoothed frame interval, for the frame rate. */
  let interval = 0;
  /** Added to the clock, to test a long pause (simulateGap). */
  let skipped = 0;
  const waiting: { until: number; resolve: () => void }[] = [];
  let snapshot: ((stats: { mean: number; std: number }) => void) | null = null;

  const frame = (time: number) => {
    if (stopped) return;
    const now = time + skipped;
    const ms = now - last;
    if (ms > 0 && ms < 250) interval = interval === 0 ? ms : interval * 0.95 + ms * 0.05;
    const dt = Math.min(0.1, ms / 1000);
    last = now;
    followCanvas(now);
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
      const p = cam.pose;
      say(`TRENCHLINE  ${s.gpuMs === null ? '…' : `${s.gpuMs.toFixed(2)} ms GPU`}  ${s.res[0]}×${s.res[1]}  F3 for more`);
      overlay.show({
        gpuMs: s.gpuMs,
        passes: s.passes,
        fps: interval > 0 ? 1000 / interval : 0,
        res: s.res,
        alloc: s.alloc,
        scale: s.scale,
        preset: s.preset,
        dynres: s.dynres,
        world: gpuWorld.stats,
        position: p.position,
        yaw: p.yaw,
        pitch: p.pitch,
        timeOfDay,
        place: placeName(world.plan, p.position[0], p.position[2]),
      });
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
      goTo(name);
    },
    setTimeOfDay(value: number) {
      timeOfDay = value;
    },
    frames: () => frames,
    waitFrames: (n: number) => new Promise<void>((resolve) => waiting.push({ until: frames + n, resolve })),
    stats: () => renderer.stats,
    snapshot: () => new Promise<{ mean: number; std: number }>((resolve) => (snapshot = resolve)),
    fingerprint: () => fingerprint(world.map),
    setQuality: (q: Partial<Quality> & { budgetMs?: number }) => renderer.setQuality(q),
    loseDevice: () => gpu.device.destroy(),
    simulateGap: (ms: number) => {
      skipped += ms;
    },
  });
  requestAnimationFrame(frame);
}

start().catch(fail);
