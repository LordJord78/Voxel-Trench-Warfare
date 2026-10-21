/**
 * Bootstrap and the game loop.
 *
 * The page asks for WebGPU first and says at once if there is none. The world
 * generates in workers while the loading screen inks a trench trace; it is
 * uploaded, and the player is drawn standing in the front-line bay behind a
 * "click to play" prompt. Playing, every frame turns the mouse, runs the
 * 60 Hz simulation over the frame's time, places the camera between the last
 * two ticks and draws. Esc (or losing the pointer lock) pauses to a menu with
 * the world still drawn behind it. The standard views are a free-flying
 * camera (`fly`), and the backquote key toggles it. When the game cannot run,
 * or the GPU goes away, it stops and says why. `window.__trenchline` exposes
 * hooks the tests use.
 */

import { loadTunables } from '../core/tunables';
import { Stance } from '../physics/character';
import type { CameraPose } from '../render/camera';
import { createGpu, GpuUnavailable, type Gpu } from '../render/device';
import { FarFieldGpu } from '../render/farfield-gpu';
import { GpuWorld } from '../render/gpu-world';
import { sceneLights } from '../render/lights';
import { rendererTunables } from '../render/quality';
import { compileFrame, Renderer, type Quality } from '../render/renderer';
import { frameSky, skyState } from '../render/sky-state';
import { Session } from '../sim/session';
import { LoadingScreen } from '../ui/loading';
import { Overlay, placeName } from '../ui/overlay';
import { PauseMenu } from '../ui/pause';
import { PeriscopeFrame } from '../ui/periscope';
import { defaultSettings, loadSettings, saveSettings, type Settings } from '../ui/settings';
import { fingerprint } from '../world/fingerprint';
import { CameraRig, rigTunables } from './camera-rig';
import { reporter, runCheck } from './check';
import { FlyCam } from './flycam';
import { generateInWorkers } from './generate-in-workers';
import { Input } from './input';
import { actionFor, nextTimeKey, stepTime, type KeyAction } from './keys';
import { standardViews, VIEW_NAMES, type ViewName } from './views';

const SEED = 7;
/** A canvas resize settles this long before the internal images are reallocated. */
const RESIZE_SETTLE_MS = 150;

type Mode = 'loading' | 'ready' | 'playing' | 'paused' | 'fly';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const loading = new LoadingScreen(document);
const hooks: Record<string, unknown> = { ready: false, phases: loading.phases };
(window as unknown as { __trenchline: unknown }).__trenchline = hooks;
/** Set once the game has stopped for good: its message stays, and no more frames are drawn. */
let stopped = false;
/** `?check=<run>`: measure and photograph the standard views and report them (check.ts). */
const checkRun = (() => {
  const run = new URLSearchParams(location.search).get('check');
  return run && /^[a-z0-9-]+$/.test(run) ? run : null;
})();

function stop(message: string): void {
  if (stopped) return;
  stopped = true;
  loading.fail(message);
  hooks.error = message;
  hooks.ready = true;
  hooks.ms ??= Math.round(performance.now());
  if (document.pointerLockElement) document.exitPointerLock();
  // A check that cannot run still reports why, so its runner is not left waiting.
  if (checkRun) void reporter(checkRun)('report.json', JSON.stringify({ run: checkRun, userAgent: navigator.userAgent, views: [], errors: [message] }));
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

/** Ask for the pointer; a refusal (headless, too soon after Esc, the user) leaves play running without it. */
function lockPointer(): void {
  try {
    const request = canvas.requestPointerLock() as unknown;
    if (request instanceof Promise) request.catch(() => {});
  } catch {
    // Pointer lock is unavailable here: the mouse simply does not turn the view.
  }
}

/** The next paint, so the loading screen can show a phase before work that holds the page. */
const nextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

const storage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();

async function start(): Promise<void> {
  loading.progress('Starting', null, 0.02);
  // The device comes up and the pipelines compile while the workers generate.
  const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));
  const gpuReady: Promise<Gpu | Error> = createGpu().catch(asError);
  // Without a GPU there is nothing to draw: say so at once, not after generating a world.
  void gpuReady.then((g) => g instanceof Error && fail(g));
  const compiling = gpuReady.then((g) => (g instanceof Error ? g : compileFrame(g.device).catch(asError)));
  const world = await generateInWorkers(
    SEED,
    (phase, done, total) => {
      if (phase === 'fill') loading.progress('Digging the trenches', `strip ${done} of ${total}`, 0.05 + 0.6 * (done / total));
    },
    async () => {
      loading.progress("Shelling no man's land", null, 0.7);
      await nextPaint();
    },
  );
  const gpu = await gpuReady;
  if (gpu instanceof Error || stopped) return;
  void gpu.device.lost.then((info) => {
    console.warn(`[gpu] device lost (${info.reason}): ${info.message}`);
    stop(`The graphics device was lost (${info.reason}). Reload the page to continue.`);
  });
  loading.progress('Sending the world to the GPU', null, 0.88);
  await nextPaint();

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
  const render = rendererTunables(tun);
  const renderer = await Renderer.create(gpu, canvas, gpuWorld, world.plan, { ...render, far, compiled, dynres: true });

  const views = standardViews(world.plan, world.spawn);
  const session = Session.create({ map: world.map, plan: world.plan, spawn: world.spawn }, tun, SEED, views.bay.yaw);
  const rig = new CameraRig(rigTunables(tun));
  const input = new Input();
  const fly = new FlyCam(views.bay);
  const pitchLimit = tun.f('player.pitch_limit');
  const periscopeScale = session.controller.t.stances[Stance.PERISCOPE].fovScale;
  let settings: Settings = loadSettings(storage, defaultSettings(tun));
  renderer.setQuality({ preset: settings.preset });
  let mode: Mode = 'loading';
  /** The mode a pause returns to. */
  let resumeTo: 'playing' | 'fly' = 'playing';
  let timeOfDay = 0;

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

  const changeSettings = (next: Settings) => {
    if (next.preset !== settings.preset) renderer.setQuality({ preset: next.preset });
    settings = next;
    saveSettings(storage, settings);
  };
  const overlay = new Overlay(document.body);
  const periscope = new PeriscopeFrame(document);
  const pauseMenu = new PauseMenu(document, {
    resume: () => resume(),
    change: changeSettings,
    time: (value) => (timeOfDay = value),
  });

  const play = (lock: boolean) => {
    if (stopped) return;
    loading.hide();
    mode = 'playing';
    if (lock) lockPointer();
  };
  const pause = () => {
    if (mode !== 'playing' && mode !== 'fly') return;
    resumeTo = mode;
    mode = 'paused';
    input.blur();
    held.clear();
    // The menu needs the cursor; an Esc the browser did not act on can leave the lock held.
    if (document.pointerLockElement) document.exitPointerLock();
    pauseMenu.open(settings, timeOfDay);
  };
  const resume = () => {
    if (mode !== 'paused') return;
    pauseMenu.close();
    mode = resumeTo;
    lockPointer();
  };
  const enterFly = (pose: CameraPose) => {
    loading.hide();
    fly.pose = { position: [...pose.position], yaw: pose.yaw, pitch: pose.pitch };
    mode = 'fly';
    renderer.resetHistory();
  };
  const goTo = (name: ViewName) => {
    enterFly(views[name]);
    timeOfDay = views[name].time;
  };

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
        changeSettings({ ...settings, preset: settings.preset === 'high' ? 'low' : 'high' });
        break;
      case 'dynres':
        renderer.setQuality({ dynres: !renderer.quality.dynres });
        break;
      case 'overlay':
        overlay.toggle();
        break;
    }
  };
  /** Keys held, for the fly camera. */
  const held = new Set<string>();
  const look: [number, number] = [0, 0];
  window.addEventListener('keydown', (e) => {
    // Leave the browser's own shortcuts (reload, find) alone.
    if (e.metaKey || e.ctrlKey || e.altKey || stopped) return;
    if (e.code === 'Escape') {
      // With the pointer locked the browser takes Esc itself, and the lost lock pauses instead.
      pause();
      return;
    }
    if (mode === 'paused' || mode === 'loading') return;
    if (e.code === 'Backquote' && !e.repeat) {
      if (mode === 'fly') mode = 'playing';
      else enterFly(lastPose);
      return;
    }
    held.add(e.code);
    if (mode === 'playing') input.keyDown(e.code, e.repeat);
    const action = actionFor(e.code);
    // Held keys repeat only the time steps.
    if (!action || (e.repeat && action.kind !== 'time-step')) return;
    e.preventDefault();
    act(action);
  });
  window.addEventListener('keyup', (e) => {
    held.delete(e.code);
    input.keyUp(e.code);
  });
  // Focus left the page: let go of everything, or the player walks on with W stuck down.
  window.addEventListener('blur', () => {
    held.clear();
    input.blur();
  });
  canvas.addEventListener('click', () => {
    if (mode === 'ready') play(true);
    else if ((mode === 'playing' || mode === 'fly') && document.pointerLockElement !== canvas) lockPointer();
  });
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement !== canvas && (mode === 'playing' || mode === 'fly')) pause();
  });
  window.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    if (mode === 'playing') input.mouse(e.movementX, e.movementY);
    else if (mode === 'fly') {
      look[0] += e.movementX;
      look[1] += e.movementY;
    }
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
  let lastPose: CameraPose = rig.pose(session, 0, settings.fov);
  const waiting: { until: number; resolve: () => void }[] = [];
  let snapshot: ((stats: { mean: number; std: number }) => void) | null = null;
  let shot: ((taken: { png: Blob; spread: number }) => void) | null = null;
  let work: { count: number; left: number; samples: number[]; done: (samples: number[]) => void } | null = null;

  const frame = (time: number) => {
    if (stopped) return;
    const now = time + skipped;
    const ms = now - last;
    if (ms > 0 && ms < 250) interval = interval === 0 ? ms : interval * 0.95 + ms * 0.05;
    const dt = Math.min(0.1, Math.max(0, ms) / 1000);
    last = now;
    followCanvas(now);
    let pose: CameraPose;
    if (mode === 'fly') {
      fly.sensitivity = settings.sensitivity;
      fly.update(dt, held, look);
      look[0] = 0;
      look[1] = 0;
      pose = { ...fly.pose, fov: settings.fov };
      periscope.set(0);
    } else {
      if (mode === 'playing') {
        input.look(session.player, settings.sensitivity, pitchLimit);
        session.intent = input.intent();
        session.advance(ms / 1000);
        if (!session.player.onFiringStep) input.lowerPeriscope();
      }
      pose = rig.pose(session, dt, settings.fov);
      periscope.set((1 - rig.fovScale) / (1 - periscopeScale));
    }
    light();
    renderer.render(pose, timeOfDay, now);
    lastPose = pose;
    frames++;
    if (work && work.left > 0) {
      // From this frame's submit to its work finishing: the GPU's time where no timestamps say it.
      work.left--;
      const w = work;
      const t0 = performance.now();
      void gpu.device.queue.onSubmittedWorkDone().then(() => {
        w.samples.push(performance.now() - t0);
        if (w.samples.length === w.count) w.done(w.samples);
      });
    }
    if (snapshot) {
      const take = snapshot;
      snapshot = null;
      take(canvasStats(canvas));
    }
    if (shot) {
      // A WebGPU canvas holds this frame only until it is presented: copy it now, encode later.
      const take = shot;
      shot = null;
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      copy.getContext('2d')!.drawImage(canvas, 0, 0);
      const spread = canvasStats(copy).std;
      copy.toBlob((png) => take({ png: png!, spread }), 'image/png');
    }
    if (mode === 'loading') {
      mode = 'ready';
      loading.ready(() => play(true));
      hooks.promptMs = Math.round(performance.now());
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
        position: pose.position,
        yaw: pose.yaw,
        pitch: pose.pitch,
        timeOfDay,
        place: placeName(world.plan, pose.position[0], pose.position[2]),
      });
    }
    requestAnimationFrame(frame);
  };

  /** An image shrunk to 160 × 100, as luminance statistics: a frame that is not blank has spread. */
  function canvasStats(source: HTMLCanvasElement): { mean: number; std: number } {
    const small = document.createElement('canvas');
    small.width = 160;
    small.height = 100;
    const g = small.getContext('2d')!;
    g.drawImage(source, 0, 0, 160, 100);
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

  const waitFrames = (n: number) => new Promise<void>((resolve) => waiting.push({ until: frames + n, resolve }));
  Object.assign(hooks, {
    world,
    renderer,
    session,
    views,
    timings: world.timings,
    view(name: ViewName) {
      if (!VIEW_NAMES.includes(name)) throw new Error(`no view '${name}'`);
      goTo(name);
    },
    walk() {
      if (mode === 'fly') mode = 'playing';
    },
    play: () => play(false),
    teleport(at: { position: [number, number, number]; yaw: number; pitch: number }) {
      session.teleport(at.position, at.yaw, at.pitch);
      renderer.resetHistory();
    },
    player() {
      const p = session.player;
      return {
        position: p.position.toArray(),
        velocity: p.velocity.toArray(),
        stance: p.stance,
        height: p.height,
        onGround: p.onGround,
        onFiringStep: p.onFiringStep,
        wadeDepth: p.wadeDepth,
      };
    },
    camera: () => lastPose,
    mode: () => mode,
    setTimeOfDay(value: number) {
      timeOfDay = value;
    },
    timeOfDay: () => timeOfDay,
    frames: () => frames,
    waitFrames,
    waitConverged: () => waitFrames(render.denoise.historyMax + 8),
    stats: () => renderer.stats,
    snapshot: () => new Promise<{ mean: number; std: number }>((resolve) => (snapshot = resolve)),
    fingerprint: () => fingerprint(world.map),
    setQuality: (q: Partial<Quality> & { budgetMs?: number }) => {
      renderer.setQuality(q);
      if (q.preset) settings = { ...settings, preset: q.preset };
    },
    loseDevice: () => gpu.device.destroy(),
    simulateGap: (ms: number) => {
      skipped += ms;
    },
  });
  requestAnimationFrame(frame);

  if (checkRun) {
    // After the first frame, so the prompt's time is known.
    await waitFrames(1);
    hooks.checkReport = await runCheck(
      checkRun,
      {
        // `&timer=submitted-work` times by submitted work even where timestamps exist, as Safari may have to.
        timestamps: gpu.timestamps && new URLSearchParams(location.search).get('timer') !== 'submitted-work',
        promptMs: hooks.promptMs as number,
        timings: world.timings,
        setQuality: (q) => renderer.setQuality(q),
        view: goTo,
        viewTime: (name) => views[name].time,
        waitFrames,
        waitConverged: () => waitFrames(render.denoise.historyMax + 8),
        stats: () => renderer.stats,
        fingerprint: () => fingerprint(world.map),
        shot: () => new Promise((resolve) => (shot = resolve)),
        submittedWork: (count) => new Promise((resolve) => (work = { count, left: count, samples: [], done: resolve })),
      },
      reporter(checkRun),
    );
  }
}

start().catch(fail);
