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

import { CLOCK_KEYS } from '../core/sky-clock';
import { loadTunables } from '../core/tunables';
import { Stance } from '../physics/character';
import { AudioEngine } from '../audio/engine';
import { audioTunables, planVoices } from '../audio/plan';
import { rifleModel, traceRifle } from '../combat/rifle-model';
import { rayDir, type CameraPose } from '../render/camera';
import type { SmokePuff, TransientLight } from '../render/effects';
import { FLAGS, horizonTerms, type HorizonFlash } from '../render/frame-uniforms';
import { throughPose, type RifleDrawn, type RiflePose } from '../render/rifle';
import { createGpu, GpuUnavailable, type Gpu } from '../render/device';
import { FarFieldGpu } from '../render/farfield-gpu';
import { GpuWorld } from '../render/gpu-world';
import { KEY_MAP_SIZE, KEY_SLOTS } from '../render/key-shadow';
import { lightMotion, lightsAt } from '../render/light-motion';
import { battleFireLights, battleFlareLights, sceneLights, type SceneLight } from '../render/lights';
import { rendererTunables } from '../render/quality';
import { compileFrame, Renderer, type Quality } from '../render/renderer';
import { frameSky, skyState } from '../render/sky-state';
import { Session, type CombatEvents } from '../sim/session';
import { LoadingScreen } from '../ui/loading';
import { Overlay, placeName } from '../ui/overlay';
import { PauseMenu } from '../ui/pause';
import { Hud } from '../ui/hud';
import { boxHitsSolid } from '../physics/collision';
import { Vec3 } from '../physics/vec';
import { battleDarkness, Director, noBattleEvents, type BattleEvents, type BattleInputs, type Strike } from '../battle/director';
import { fireChance, fireTunables } from '../battle/fires';
import { CharQueue, fuelNear } from '../world/char';
import { waterTunables } from '../battle/water';
import { glintsFrom, glintTerms, STILL_WATER, waterFrameTunables } from '../render/water-frame';
import { flareTunables } from '../battle/flares';
import { flashPower, flashTunables } from '../battle/barrages';
import { farHeightM } from '../world/generation/farfield';
import { clearOf, underFire, type PeakGame } from './peak-combat';
import { battlePeak } from './peak-battle';
import { PeriscopeFrame } from '../ui/periscope';
import { defaultSettings, loadSettings, saveSettings, type Settings } from '../ui/settings';
import { UNIFORM } from '../world/bricks';
import { DETONATION_MARGIN, DETONATION_WIDEN, detonationRegion, runDetonation } from '../world/detonation';
import { fingerprint } from '../world/fingerprint';
import { groundTop } from '../world/raycast';
import { copyRegion, type RegionCopy } from '../world/region-copy';
import { CameraRig, rigTunables } from './camera-rig';
import { workerRunner } from './destruction-in-worker';
import { CHECK_CANVAS, reporter, runCheck } from './check';
import { EffectsFrameBuilder, effectsTunables, NO_BATTLE, type BuiltEffects, type DebugQuad, type DebugRibbon } from './effects-frame';
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
/** `?dev`: the developer keys work without F3's overlay open. */
const devMode = new URLSearchParams(location.search).has('dev');
const checkRun = (() => {
  const run = new URLSearchParams(location.search).get('check');
  return run && /^[a-z0-9-]+$/.test(run) ? run : null;
})();
// A check reports how far loading got, so a run that stalls says where.
if (checkRun) loading.onPhase = (stage) => void reporter(checkRun)('progress.json', JSON.stringify({ stage })).catch(() => {});

function stop(message: string): void {
  if (stopped) return;
  stopped = true;
  // The message goes over everything: a pause menu left open would hide it, and the HUD would sit on it.
  document.getElementById('pause')!.hidden = true;
  document.getElementById('hud')!.hidden = true;
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

/** The canvas in device pixels: its CSS size at up to twice the CSS pixel density (a check's, CHECK_CANVAS). */
function canvasTarget(): [number, number] {
  if (checkRun) return [CHECK_CANVAS[0], CHECK_CANVAS[1]];
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
  // How long the pipelines take to compile, from the device's coming up (a load timing).
  let compileMs = 0;
  const compiling = gpuReady.then((g) => {
    if (g instanceof Error) return g;
    const t0 = performance.now();
    return compileFrame(g.device).then((c) => ((compileMs = Math.round(performance.now() - t0)), c), asError);
  });
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
  world.timings.compile = compileMs;
  [canvas.width, canvas.height] = canvasTarget();
  const tun = loadTunables();
  const render = rendererTunables(tun);
  const renderer = await Renderer.create(gpu, canvas, gpuWorld, world.plan, { ...render, far, compiled, dynres: true });

  const views = standardViews(world.plan, world.spawn);
  // Craters are cut in a worker, off the frame.
  const session = Session.create({ map: world.map, plan: world.plan, spawn: world.spawn, runner: workerRunner() }, tun, SEED, views.bay.yaw);
  // Shells the tests drop: each one's waiter, told its crater's bricks when it settles, and when its cut was in.
  const craterWaiters = new Map<number, (bricks: number) => void>();
  const cutsIn = new Map<number, number>();
  let cratersLanded = 0;
  let shellsDropped = 0;
  const voxelM = world.plan.params.voxel;
  const dropShell = (at: readonly number[], radiusM: number, keep: boolean) => {
    const x = at[0] / voxelM;
    const z = at[2] / voxelM;
    const top = groundTop(session.map, x, z);
    if (top === null) throw new Error(`no ground at ${at[0]}, ${at[2]}`);
    const centre: [number, number, number] = [x, top, z];
    const radius = radiusM / voxelM;
    const seed = 0x5eed0000 + shellsDropped++;
    // For a check: a copy wide enough for two widenings, taken before the shell goes out.
    const wide = keep ? detonationRegion(session.map.dims, centre, radius, session.destruction.t.options.loosen, DETONATION_MARGIN + 2 * DETONATION_WIDEN) : null;
    const copy: RegionCopy | null = wide ? copyRegion(session.map, wide) : null;
    const t0 = performance.now();
    const id = session.land(at[0], at[2], radiusM, seed);
    if (id === null) throw new Error(`no ground at ${at[0]}, ${at[2]}`);
    const landed = new Promise<{ ms: number; bricks: number; cutMs: number }>((resolve) =>
      craterWaiters.set(id, (bricks) => {
        const now = performance.now();
        resolve({ ms: now - t0, bricks, cutMs: (cutsIn.get(id) ?? now) - t0 });
        cutsIn.delete(id);
      }),
    );
    return { id, centre, radius, seed, copy, landed };
  };
  const rig = new CameraRig(rigTunables(tun));
  const effects = new EffectsFrameBuilder(effectsTunables(tun));
  const hearing = audioTunables(tun);
  const audio = new AudioEngine(hearing, { lowHz: tun.f('viewkick.defaults.report_low_hz'), lengthS: tun.f('viewkick.defaults.report_length_s') });
  let built: BuiltEffects['counts'] = { billboards: 0, tracers: 0, stars: 0, lights: 0, battleTracers: 0, flames: 0 };
  /** Whether the rifle is in hand (tests put it down to read the world behind it). */
  let rifleHeld = true;
  const input = new Input();
  const fly = new FlyCam(views.bay);
  const pitchLimit = tun.f('player.pitch_limit');
  const periscopeScale = session.controller.t.stances[Stance.PERISCOPE].fovScale;
  let settings: Settings = loadSettings(storage, defaultSettings(tun));
  // The front fires as the visitor chose; a check measures without it.
  session.front.intensity = checkRun ? 'off' : settings.intensity;
  session.artillery.intensity = session.front.intensity;
  renderer.setQuality({ preset: settings.preset });
  let mode: Mode = 'loading';
  /** For the peak-combat driver (peak-combat.ts): the camera held in fly mode while the session runs as if playing. */
  let spectating = false;
  /** The mode a pause returns to. */
  let resumeTo: 'playing' | 'fly' = 'playing';
  /** The clock, in hours; it opens at dusk. */
  let timeOfDay: number = CLOCK_KEYS.dusk;
  /** How fast the clock runs, in game minutes a second: held (0), or time-lapse. */
  let lapse = 0;

  // The light follows the clock; the flares burn as it says. The point lights move with a clock of
  // their own, which runs whenever the world is drawn but paused (tests can hold them still, as
  // planned or at a moment of their motion), and are written every frame.
  // The scene's lights as planned. A test may give its own instead (useLights): they replace these,
  // the battle's flares and all, and move as sub-project 2's did.
  const planned = sceneLights(world.plan, tun);
  let lights = planned;
  const motion = lightMotion(tun);
  let lightSeconds = 0;
  // The check measures its views with the lights as planned, as they were approved.
  let lightsHeld: number | 'rest' | null = checkRun ? 'rest' : null;
  let lit: SceneLight[] = lights;
  let litFor = Number.NaN;
  let sky = skyState(tun, timeOfDay);
  // The battle around the player (src/battle): on the lights' clock, so every view sees it. At rest
  // the six planned flares hang instead; held at a moment, the director is sought to it.
  // Where a far shell stands: the far field's ground under it.
  const ground = (x: number, z: number) => farHeightM(world.farField, x, z, world.plan.params.voxel);
  let battle = new Director(world.plan, tun, SEED, ground);
  const flashT = flashTunables(tun);
  renderer.horizonTerms = horizonTerms(tun);
  renderer.waterTerms = { frame: waterFrameTunables(tun), ripples: waterTunables(tun) };
  const glintT = glintTerms(tun);
  /** The distant shells' flashes the frame was last given. */
  let horizon: HorizonFlash[] = [];
  const flareT = flareTunables(tun);
  const fireT = fireTunables(tun);
  /** The sky at the time of day, worked out again whenever the clock has been set since it was last asked. */
  const skyNow = () => {
    if (timeOfDay !== litFor) {
      litFor = timeOfDay;
      sky = skyState(tun, timeOfDay);
      renderer.sky = frameSky(sky, tun);
    }
    return sky;
  };
  const battleInputs = (): BattleInputs => {
    const s = skyNow();
    return { intensity: session.front.intensity, darkness: battleDarkness(s.sunElevationDeg, s.flares, flareT), player: session.player.position.toArray() };
  };
  /**
   * The clock and the dark when the battle last ran live. A jump of the clock into the dark from there
   * (a view, the time key, the pause menu; not the lapse's creep) finds a night already under way: the
   * battle is run a flare's climb and burn first, its launches unheard.
   */
  let ranAt: { hours: number; darkness: number } | null = null;
  const jumpedIntoDark = (dt: number, darkness: number) => {
    if (darkness <= flareT.darkAbove) return false;
    if (ranAt === null) return true;
    const crept = (ranAt.hours + (lapse * dt) / 60) % 24;
    const off = Math.abs(timeOfDay - crept);
    return ranAt.darkness <= flareT.darkAbove && Math.min(off, 24 - off) > 1e-6;
  };
  let battleEvents: BattleEvents = noBattleEvents();
  let shownBattle: Director = battle;
  let sought: { at: number; inputs: string; d: Director } | null = null;
  const battleAt = (t: number) => {
    const inputs = battleInputs();
    const key = JSON.stringify([inputs.intensity, inputs.darkness]);
    if (!sought || sought.at !== t || sought.inputs !== key) sought = { at: t, inputs: key, d: Director.at(t, world.plan, tun, SEED, inputs, ground) };
    return sought.d;
  };
  /** What the fires burned, charred once no crater's region about it is out (world/char.ts). */
  const chars = new CharQueue(fireT.charM, voxelM);
  /**
   * The session's shells on what burns, held until their craters are in: a shell cuts away what it
   * struck, so the fire it starts stands on what its crater left, the nearest fuel within its radius
   * and char_m (world/char.ts fuelNear); none where it left nothing. A crater that never comes (a
   * shell off the map) lets its strike go after STRIKE_WAIT_S of the world's time. Strikes on what
   * cannot burn go to the battle at once (each strike draws its chance whatever it struck).
   */
  const STRIKE_WAIT_S = 20;
  let struck: (CombatEvents['blasts'][number])[] = [];
  const strikesFrom = (events: CombatEvents): Strike[] => {
    const now: Strike[] = [];
    for (const b of events.blasts) {
      if (fireChance(b.material, fireT) > 0 && b.crater !== null) struck.push(b);
      else now.push({ at: b.at, material: b.material, crater: b.crater });
    }
    const landed = new Set(events.craters.map((c) => c.id));
    struck = struck.filter((b) => {
      if (!landed.has(b.crater!) && (session.ticks - b.tick) * session.clock.dt < STRIKE_WAIT_S) return true;
      const at = fuelNear(session.map, b.at, b.radiusM + fireT.charM, voxelM);
      if (at) now.push({ at, material: b.material, crater: b.crater });
      return false;
    });
    return now;
  };
  /** `strikes`: the session's shells landed this frame, which may start fires; `splashes`: its rounds and shells into water, which ripple it. */
  const light = (dt: number, eye: readonly number[], strikes: readonly Strike[] = [], splashes: NonNullable<BattleInputs['splashes']> = []) => {
    skyNow();
    battleEvents = noBattleEvents();
    if (mode !== 'paused') {
      lightSeconds += dt;
      if (lightsHeld === null) {
        const inputs = { ...battleInputs(), strikes, splashes };
        battleEvents = jumpedIntoDark(dt, inputs.darkness) ? battle.preRoll(flareT.preRollS, dt, inputs) : battle.tick(dt, inputs);
        for (const c of battleEvents.chars) chars.add(c.at);
        ranAt = { hours: timeOfDay, darkness: inputs.darkness };
      }
    }
    chars.make(session.map, (box) => session.destruction.overlapsOut(box));
    horizon = [];
    if (lightsHeld === 'rest') {
      lit = lights;
      renderer.setFlareGlow(1);
    } else if (lights !== planned) {
      lit = lightsAt(lights, lightsHeld ?? lightSeconds, motion);
      renderer.setFlareGlow(1);
    } else {
      shownBattle = lightsHeld === null ? battle : battleAt(lightsHeld);
      const flares = shownBattle.flares();
      const now = shownBattle.seconds;
      lit = [...lightsAt(lights.filter((l) => l.kind !== 'flare'), lightsHeld ?? lightSeconds, motion), ...battleFlareLights(flares, flareT), ...battleFireLights(shownBattle.fires(), now, fireT)];
      renderer.setFlareGlow(Math.min(2, flares.reduce((sum, f) => sum + f.glow, 0) / flareT.meanLight));
      horizon = shownBattle.flashes().map((f) => ({ position: f.position, power: flashPower(f, now, flashT), glow: !f.far }));
    }
    renderer.setLights(lit, sky.flares, eye);
    renderer.setHorizon(horizon);
    // The battle's water: its rings, the wind on it, and its flares' and fires' glints; still at rest, and under a test's own lights.
    renderer.setWater(
      lightsHeld === 'rest' || lights !== planned
        ? STILL_WATER
        : { rings: shownBattle.rings(), ...shownBattle.roughness(), seconds: shownBattle.seconds, glints: glintsFrom(shownBattle.flares(), shownBattle.fires(), sky.flares, glintT) },
    );
  };

  const changeSettings = (next: Settings) => {
    if (next.preset !== settings.preset) renderer.setQuality({ preset: next.preset });
    session.front.intensity = next.intensity;
    session.artillery.intensity = next.intensity;
    settings = next;
    saveSettings(storage, settings);
  };
  const overlay = new Overlay(document.body);
  const periscope = new PeriscopeFrame(document);
  const hud = new Hud(document);
  const pauseMenu = new PauseMenu(document, {
    resume: () => resume(),
    change: changeSettings,
    time: (value) => (timeOfDay = value),
    lapse: (speed) => (lapse = speed),
  });

  const play = (lock: boolean) => {
    if (stopped) return;
    loading.hide();
    mode = 'playing';
    // The click that starts play is where the browser lets the sound start.
    audio.start();
    if (lock) lockPointer();
  };
  const pause = () => {
    if (stopped || (mode !== 'playing' && mode !== 'fly')) return;
    resumeTo = mode;
    mode = 'paused';
    input.blur();
    held.clear();
    // The menu needs the cursor; an Esc the browser did not act on can leave the lock held.
    if (document.pointerLockElement) document.exitPointerLock();
    audio.suspend();
    pauseMenu.open(settings, timeOfDay, lapse);
  };
  const resume = () => {
    if (stopped || mode !== 'paused') return;
    pauseMenu.close();
    mode = resumeTo;
    audio.start();
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
    timeOfDay = views[name].hours;
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
    // The developer keys (views, fly, time, quality) wait behind F3, so a visitor's 1 or T does nothing strange.
    const developer = overlay.visible || devMode;
    if (e.code === 'Backquote' && !e.repeat) {
      if (!developer) return;
      if (mode === 'fly') mode = 'playing';
      else enterFly(lastPose);
      return;
    }
    held.add(e.code);
    if (mode === 'playing') input.keyDown(e.code, e.repeat);
    const action = actionFor(e.code);
    // Held keys repeat only the time steps.
    if (!action || (e.repeat && action.kind !== 'time-step') || (action.kind !== 'overlay' && !developer)) return;
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
  // The trigger: the left button, with the pointer locked to the game (a click that locks it does not fire).
  window.addEventListener('mousedown', (e) => {
    if (e.button === 0 && mode === 'playing' && document.pointerLockElement === canvas) input.trigger(true);
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) input.trigger(false);
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
  let hudShown = Number.NEGATIVE_INFINITY;
  /** Smoothed frame interval, for the frame rate. */
  let interval = 0;
  /** Added to the clock, to test a long pause (simulateGap). */
  let skipped = 0;
  let lastPose: CameraPose = rig.pose(session, 0, settings.fov);
  const waiting: { until: number; resolve: () => void }[] = [];
  let snapshot: ((stats: ReturnType<typeof canvasStats>) => void) | null = null;
  let snapshotRegion: readonly number[] | undefined;
  let shot: ((taken: { png: Blob; spread: number }) => void) | null = null;
  let work: { count: number; left: number; samples: number[]; done: (samples: number[]) => void } | null = null;

  // For tests: a frozen loop draws only the frames it is stepped, a sixtieth of a second apart
  // whatever time passes between steps (a longer gap would start the histories afresh), so what a
  // test reads back stays put.
  let frozen = false;
  let steps = 0;
  // Each of the last MAIN_FRAMES frames' main-thread time (the hooks' mainMs).
  const MAIN_FRAMES = 600;
  const mainMs = new Float64Array(MAIN_FRAMES);
  let mainFrames = 0;
  const frame = (time: number) => {
    if (stopped) return;
    if (frozen && steps === 0) {
      requestAnimationFrame(frame);
      return;
    }
    if (frozen) steps--;
    try {
      const t0 = performance.now();
      step(frozen ? last - skipped + 1000 / 60 : time);
      mainMs[mainFrames++ % MAIN_FRAMES] = performance.now() - t0;
    } catch (e) {
      // A frame that throws would otherwise freeze the last image without a word.
      console.error(e);
      stop(`TRENCHLINE stopped: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    requestAnimationFrame(frame);
  };

  const step = (time: number) => {
    const now = time + skipped;
    const ms = now - last;
    if (ms > 0 && ms < 250) interval = interval === 0 ? ms : interval * 0.95 + ms * 0.05;
    const dt = Math.min(0.1, Math.max(0, ms) / 1000);
    last = now;
    followCanvas(now);
    if (lapse > 0 && mode !== 'loading') timeOfDay = (timeOfDay + (lapse * dt) / 60) % 24;
    let pose: CameraPose;
    if (mode === 'fly') {
      fly.sensitivity = settings.sensitivity;
      fly.update(dt, held, look);
      look[0] = 0;
      look[1] = 0;
      pose = { ...fly.pose, fov: settings.fov };
      periscope.set(0);
      if (spectating) {
        session.intent = input.intent();
        if (session.advance(ms / 1000) > 0) input.ticked();
      }
    } else {
      if (mode === 'playing') {
        input.look(session.player, settings.sensitivity, pitchLimit);
        session.intent = input.intent();
        if (session.advance(ms / 1000) > 0) input.ticked();
        if (!session.player.onFiringStep) input.lowerPeriscope();
      }
      // Until the click, the world is drawn from the firing step over the parapet at dusk (the page's
      // still is that view); the click starts play at the spawn, in the bay.
      const step = views.step;
      pose = mode === 'loading' || mode === 'ready' ? { position: [...step.position], yaw: step.yaw, pitch: step.pitch, fov: settings.fov } : rig.pose(session, dt, settings.fov);
      periscope.set((1 - rig.fovScale) / (1 - periscopeScale));
    }
    // The rifle in hand while playing (paused too), not through the periscope or flying.
    let rifle: RiflePose | null = null;
    if (rifleHeld && (mode === 'playing' || mode === 'paused') && session.player.stance !== Stance.PERISCOPE) rifle = rig.rifle(session, pose);
    else rig.hideRifle();
    renderer.setRifle(rifle);
    // Under fire the picture greys and closes in, while playing (and paused); not flying.
    const shaken = mode === 'playing' || mode === 'paused';
    renderer.setSuppressionLook(shaken ? session.suppression.desaturation : 0, shaken ? session.suppression.vignette : 0);
    // What this frame's ticks did, once: seen, from the rifle as it is drawn, and heard.
    const events = session.drainEvents();
    // A crater of more than 64 bricks: the key's shadow map is traced outright once they are up.
    if (events.craters.some((c) => c.bricks > 64)) renderer.largeEdit();
    for (const c of events.cuts) if (craterWaiters.has(c.id)) cutsIn.set(c.id, performance.now());
    for (const c of events.craters) {
      cratersLanded++;
      craterWaiters.get(c.id)?.(c.bricks);
      craterWaiters.delete(c.id);
    }
    // The battle seen (its flares, flashes, smoke, tracers, and fires' flames and plumes) as the lights last showed it; none at rest.
    const seen = lightsHeld === 'rest' || lights !== planned ? NO_BATTLE : { seconds: shownBattle.seconds, flares: shownBattle.flares(), flashes: shownBattle.flashes(), smoke: shownBattle.smoke(), tracers: shownBattle.tracers(), flames: shownBattle.flames(), plumes: shownBattle.plumes() };
    const frameEffects = effects.build(session, events, rifle, pose.position, seen, skyNow().flares);
    audio.listen(pose);
    // The battle's events from the last frame's lights (light() below runs the battle's clock).
    audio.play(planVoices(hearing, events, pose.position, battleEvents));
    renderer.setEffects(frameEffects.frame);
    renderer.setTransientLights(frameEffects.lights);
    renderer.setBlasts(frameEffects.blasts);
    renderer.setSmoke(frameEffects.smoke);
    built = frameEffects.counts;
    light(dt, pose.position, strikesFrom(events), events.splashes.map((w) => ({ at: w.at, energyJ: w.energyJ })));
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
      take(canvasStats(canvas, snapshotRegion));
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
    // The HUD only in play (not over the loading screen, the pause menu or flying), redrawn ten times a second.
    hud.visible = mode === 'playing';
    if (hud.visible && now - hudShown >= 100) {
      hudShown = now;
      const p = session.player;
      hud.update({
        stance: p.stance,
        exposure: session.exposure(),
        rounds: session.weapon.rounds,
        magazine: session.weapon.spec.magazine,
        reloading: session.weapon.reloading,
        digging: session.digging,
        digFraction: session.entrenching.fraction,
        digInReach: session.entrenching.inReach,
        crosshair: p.stance !== Stance.PERISCOPE,
      });
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
  };

  /** An image shrunk to 160 × 100, as luminance statistics: a frame that is not blank has spread. */
  /**
   * The picture at 160 × 100: its mean luminance and their spread; its saturation, the mean of
   * (max − min) / max per pixel; and the mean luminance of its outer tenth (`edge`) and of its
   * middle half (`middle`), for suppression's look.
   */
  /** The canvas's luminance (0 to 1) on a 160 × 100 grid: its mean, spread and saturation, its edge's and middle's means, and `region`'s ([x0, y0, x1, y1] in fractions of it), if given. */
  function canvasStats(source: HTMLCanvasElement, region?: readonly number[]): { mean: number; std: number; saturation: number; edge: number; middle: number; region: number } {
    const small = document.createElement('canvas');
    small.width = 160;
    small.height = 100;
    const g = small.getContext('2d')!;
    g.drawImage(source, 0, 0, 160, 100);
    const px = g.getImageData(0, 0, 160, 100).data;
    let sum = 0;
    let sq = 0;
    let saturation = 0;
    const edge = [0, 0];
    const middle = [0, 0];
    const inRegion = [0, 0];
    const n = px.length / 4;
    for (let i = 0; i < px.length; i += 4) {
      const l = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
      sum += l;
      sq += l * l;
      const hi = Math.max(px[i], px[i + 1], px[i + 2]);
      if (hi > 0) saturation += (hi - Math.min(px[i], px[i + 1], px[i + 2])) / hi;
      const x = (i / 4) % 160;
      const y = Math.floor(i / 4 / 160);
      if (x < 16 || x >= 144 || y < 10 || y >= 90) {
        edge[0] += l;
        edge[1]++;
      } else if (x >= 40 && x < 120 && y >= 25 && y < 75) {
        middle[0] += l;
        middle[1]++;
      }
      if (region && x >= region[0] * 160 && x < region[2] * 160 && y >= region[1] * 100 && y < region[3] * 100) {
        inRegion[0] += l;
        inRegion[1]++;
      }
    }
    const mean = sum / n;
    return { mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)), saturation: saturation / n, edge: edge[0] / edge[1], middle: middle[0] / middle[1], region: inRegion[1] > 0 ? inRegion[0] / inRegion[1] : Number.NaN };
  }

  const waitFrames = (n: number) => new Promise<void>((resolve) => waiting.push({ until: frames + n, resolve }));
  // For tests: the rifle as the CPU traces it through the last frame's pixels.
  const rifleShape = rifleModel();
  /** Metres along pixel (x, y)'s ray to the rifle as the last frame drew it, or null. */
  const traceRiflePixel = (s: RifleDrawn, x: number, y: number): number | null => {
    const m = s.toWorld!;
    const cam = s.camera!;
    const d = rayDir(cam, s.res, x + 0.5, y + 0.5);
    const o = [cam.position[0] - m[9], cam.position[1] - m[10], cam.position[2] - m[11]];
    const along = (v: readonly number[], c: number) => v[0] * m[c * 3] + v[1] * m[c * 3 + 1] + v[2] * m[c * 3 + 2];
    const hit = traceRifle(rifleShape, [along(o, 0), along(o, 1), along(o, 2)], [along(d, 0), along(d, 1), along(d, 2)]);
    return hit ? hit.t : null;
  };
  /** n × n pixels across the last frame's rifle box: the G-buffer's depth there and the CPU's trace (metres). */
  const rifleCheck = async (n: number) => {
    const s = renderer.rifleState();
    if (!s.visible || !s.toWorld || !s.camera) return { visible: false, samples: [] };
    const [x0, y0, w, h] = s.box;
    const depth = await renderer.readDepthBox(s.box);
    const samples: { px: [number, number]; gpu: number; cpu: number | null }[] = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = x0 + Math.floor(((i + 0.5) * w) / n);
        const y = y0 + Math.floor(((j + 0.5) * h) / n);
        samples.push({ px: [x, y], gpu: depth[(y - y0) * w + (x - x0)], cpu: traceRiflePixel(s, x, y) });
      }
    }
    return { visible: true, samples };
  };
  const lastMainMs = () => {
    const n = Math.min(mainFrames, MAIN_FRAMES);
    return Array.from({ length: n }, (_, k) => mainMs[(mainFrames - n + k) % MAIN_FRAMES]);
  };
  const submittedWork = (count: number) => new Promise<number[]>((resolve) => (work = { count, left: count, samples: [], done: resolve }));
  const eyeM = world.plan.params.eye.standing * voxelM;
  /** The battle sought to `seconds` from its start, at the inputs of the moment, and running on from there. */
  const seekBattle = (seconds: number) => {
    const inputs = battleInputs();
    battle = Director.at(seconds, world.plan, tun, SEED, inputs, ground);
    ranAt = { hours: timeOfDay, darkness: inputs.darkness };
    lightsHeld = null;
  };
  /** The battle run on by `seconds` at once, as it is (its strikes' fires kept), at the inputs of the moment, `strikes` struck and `splashes` splashed as it starts: its fires' chars made, the rest unheard. */
  const runBattle = (seconds: number, strikes: Strike[] = [], splashes: NonNullable<BattleInputs['splashes']> = []) => {
    for (const c of battle.tick(seconds, { ...battleInputs(), strikes, splashes }).chars) chars.add(c.at);
  };
  const peakGame: PeakGame = {
    views,
    standAt: (pose) => {
      const body = session.controller.t;
      const standing = body.stances[Stance.STANDING].height;
      const blocked = (x: number, y: number, z: number) => boxHitsSolid(session.controller.grid, new Vec3(x, y, z), body.radius, standing);
      session.teleport(clearOf([pose.position[0], pose.position[1] - eyeM, pose.position[2]], blocked, voxelM, 0.5), pose.yaw, pose.pitch);
      renderer.resetHistory();
      // Playing without the click that starts play, so without sound (as the check has no click).
      if (!spectating && mode !== 'playing') {
        loading.hide();
        mode = 'playing';
      }
    },
    spectate: (pose) => {
      if (pose) {
        enterFly(pose);
        spectating = true;
      } else {
        spectating = false;
        if (mode === 'fly') mode = 'playing';
      }
    },
    setTimeOfDay: (hours) => {
      timeOfDay = hours;
    },
    setFront: (intensity) => {
      session.front.intensity = intensity;
      session.artillery.intensity = 'off';
    },
    trigger: (held) => input.trigger(held),
    rounds: () => session.weapon.rounds,
    refill: () => {
      session.weapon.rounds = session.weapon.spec.magazine;
    },
    shotsFired: () => session.weapon.shotsFired,
    feet: () => session.player.position.toArray(),
    onMap: (x, z) => groundTop(session.map, x / voxelM, z / voxelM) !== null,
    shell: (x, z, radiusM) => dropShell([x, 0, z], radiusM, false).landed,
    pending: () => session.destruction.pending,
    waitFrames,
    frames: () => frames,
    stats: () => renderer.stats,
    mainMs: lastMainMs,
    timestamps: gpu.timestamps,
    submittedWork,
    voices: () => audio.voices,
    eyeYaw: () => (mode === 'fly' ? fly.pose.yaw : session.player.yaw),
    groundTop: (x, z) => {
      const top = groundTop(session.map, x / voxelM, z / voxelM);
      return top === null ? null : top * voxelM;
    },
    dark: () => battleInputs().darkness > flareT.darkAbove,
    seekBattle,
    runBattle,
    battleNow: () => ({
      seconds: battle.seconds,
      flares: battle.flares().filter((f) => f.stage === 'burning').length,
      barrages: battle.barrages.running,
      tracers: battle.tracers().length,
      fires: battle.fires().filter((f) => !f.dying).length,
      hamlet: battle.fires().filter((f) => !f.dying && f.hamlet).length,
    }),
  };
  Object.assign(hooks, {
    world,
    renderer,
    session,
    views,
    /** The camera held at `pose` while the session runs (null: play again); peak-combat.ts's. */
    spectate(pose: CameraPose | null) {
      peakGame.spectate(pose);
    },
    /** Stand the player at a standard view, their body clear of solid (peak-combat.ts's standAt). */
    standAt(view: ViewName) {
      peakGame.standAt(views[view]);
    },
    /** The battle brought to its peak where the player stands, at the time of day (peak-battle.ts). */
    battlePeak: () => battlePeak(peakGame, timeOfDay),
    /** `view` at `hours` under peak combat for `seconds`, measured; under the battle's peak too, if asked (peak-combat.ts). */
    underFire: (view: ViewName, hours: number, seconds: number, options?: { battle?: boolean }) => underFire(peakGame, view, hours, seconds, options),
    timings: world.timings,
    view(name: ViewName) {
      if (!VIEW_NAMES.includes(name)) throw new Error(`no view '${name}'`);
      goTo(name);
    },
    walk() {
      if (mode === 'fly') mode = 'playing';
    },
    /** The camera flown to `pose`, the player left where they are: a test's fixed vantage (`walk` returns to them). */
    flyTo(pose: { position: [number, number, number]; yaw: number; pitch: number }) {
      enterFly({ ...pose, fov: settings.fov });
    },
    /** The flying camera moved to `pose` without starting its histories afresh: a camera moving smoothly (the video's shots, tools/record-video.mjs). */
    glide(pose: { position: [number, number, number]; yaw: number; pitch: number }) {
      fly.pose = { position: [...pose.position], yaw: pose.yaw, pitch: pose.pitch };
    },
    /** The trigger, as the left button sets it with the pointer locked; for tests that play without the lock. */
    trigger(held: boolean) {
      input.trigger(held);
    },
    /** The front's shells alone, for a test. */
    setShelling(i: 'off' | 'light' | 'heavy') {
      session.artillery.intensity = i;
    },
    /** The front's fire, for this visit (the pause menu's choice is what is kept). */
    setIntensity(i: 'off' | 'light' | 'heavy') {
      session.front.intensity = i;
      session.artillery.intensity = i;
    },
    effects: () => built,
    debugQuads(quads: DebugQuad[]) {
      effects.debug = quads;
    },
    debugLights(lights: TransientLight[]) {
      effects.debugLights = lights;
    },
    debugBlasts(lights: TransientLight[]) {
      effects.debugBlasts = lights;
    },
    debugSmoke(puffs: SmokePuff[]) {
      effects.debugSmoke = puffs;
    },
    keyTexels: () => ({ traced: renderer.keyTraced(), all: KEY_MAP_SIZE * KEY_MAP_SIZE, slots: KEY_SLOTS }),
    debugRibbons(ribbons: DebugRibbon[]) {
      effects.debugRibbons = ribbons;
    },
    sharpAt: async (box: [number, number, number, number]) => Array.from(await renderer.readColour(box, 'sharp')),
    debugLit: async () => {
      const lit = await renderer.readEffectsLit(effects.debugAt, effects.debug.length);
      return Array.from({ length: lit.length / 8 }, (_, i) => Array.from(lit.subarray(i * 8 + 4, i * 8 + 8)));
    },
    depthAt: (points: [number, number][]) => renderer.readDepth(points),
    hazeAt: (points: [number, number][]) => renderer.readHaze(points),
    colourAt: async (box: [number, number, number, number]) => {
      const rgb = await renderer.readColour(box);
      const n = rgb.length / 3;
      const sum = [0, 0, 0];
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) sum[c] += rgb[i * 3 + c];
      return sum.map((v) => v / Math.max(1, n));
    },
    gpuErrors: () => gpu.errors,
    jitter(on: boolean) {
      renderer.flags = on ? renderer.flags & ~FLAGS.JITTER_OFF : renderer.flags | FLAGS.JITTER_OFF;
    },
    audio: () => ({ state: audio.state, voices: audio.voices, kinds: { ...audio.kinds }, held: audio.held, dropped: audio.dropped, time: audio.time }),
    shell: (at: [number, number, number], radiusM: number) => dropShell(at, radiusM, false).landed,
    shellCheck: async (at: [number, number, number], radiusM: number) => {
      const drop = dropShell(at, radiusM, true);
      const { ms, bricks, cutMs } = await drop.landed;
      const copy = drop.copy!;
      const map = session.map;
      const r = runDetonation({ id: drop.id, centre: drop.centre, radius: drop.radius, seed: drop.seed, options: session.destruction.t.options, copy, world: map.dims });
      if (!('patches' in r)) return { ms, bricks, cutMs, equal: false };
      // Over the copy's region: the bricks the job changed as it left them, the rest as they were.
      const changed = new Map(r.patches.map((p) => [map.brickIndex(p.at[0], p.at[1], p.at[2]), p]));
      const got = new Uint8Array(512);
      const want = new Uint8Array(512);
      let equal = true;
      for (let i = 0; i < copy.entries.length && equal; i++) {
        const bx = i % copy.size[0];
        const by = ((i - bx) / copy.size[0]) % copy.size[1];
        const bz = (i - bx - by * copy.size[0]) / (copy.size[0] * copy.size[1]);
        const bi = map.brickIndex(copy.origin[0] + bx, copy.origin[1] + by, copy.origin[2] + bz);
        map.readBrick(bi, got);
        const p = changed.get(bi);
        const e = copy.entries[i];
        if (p) {
          if (p.voxels) want.set(p.voxels);
          else want.fill(p.entry & 0xff);
        } else if (e === 0 || e & UNIFORM) want.fill(e & 0xff);
        else want.set(copy.dense.subarray((e - 1) * 512, e * 512));
        for (let v = 0; v < 512 && equal; v++) equal = got[v] === want[v];
      }
      return { ms, bricks, cutMs, equal };
    },
    craters: () => cratersLanded,
    mainMs: lastMainMs,
    rifleVisible: () => renderer.rifleState().visible,
    showRifle(on: boolean) {
      rifleHeld = on;
    },
    rifleMuzzle: () => {
      const m = renderer.rifleState().toWorld;
      return m ? throughPose(m, rifleModel().muzzle) : null;
    },
    rifleCheck: (n: number) => rifleCheck(n),
    // Over every other pixel of the box where the rifle was drawn: the CPU's trace meets it, and
    // the G-buffer's depth there is the rifle's.
    rifleLuminance: async () => {
      const s = renderer.rifleState();
      if (!s.visible) return 0;
      const [x0, y0, w, h] = s.box;
      const [colour, depth] = await Promise.all([renderer.readColour(s.box), renderer.readDepthBox(s.box)]);
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y0 + h; y += 2) {
        for (let x = x0; x < x0 + w; x += 2) {
          const t = traceRiflePixel(s, x, y);
          const k = (y - y0) * w + (x - x0);
          if (t === null || Math.abs(depth[k] - t) > 1e-3) continue;
          sum += 0.2126 * colour[k * 3] + 0.7152 * colour[k * 3 + 1] + 0.0722 * colour[k * 3 + 2];
          count++;
        }
      }
      return count === 0 ? 0 : sum / count;
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
    exposure: () => renderer.exposure(),
    exposureState: () => renderer.exposureState(),
    lights: () => lit,
    battle: () => ({ seconds: shownBattle.seconds, flares: shownBattle.flares(), flashes: shownBattle.flashes(), smoke: shownBattle.smoke(), tracers: shownBattle.tracers(), fires: shownBattle.fires(), plumes: shownBattle.plumes() }),
    horizon: () => horizon,
    holdLights(seconds?: number) {
      lightsHeld = seconds ?? 'rest';
    },
    advanceBattle: runBattle,
    /** Run the lights' clock; from `seconds` into the battle (sought there at the inputs of the moment), if given. */
    runLights(seconds?: number) {
      if (seconds !== undefined) seekBattle(seconds);
      lightsHeld = null;
    },
    useLights(next: SceneLight[]) {
      lights = next;
    },
    sunElevation: () => skyNow().sunElevationDeg,
    frames: () => frames,
    waitFrames,
    freeze() {
      frozen = true;
      steps = 0;
    },
    thaw() {
      frozen = false;
    },
    stepFrames(n: number) {
      steps += n;
      return waitFrames(n);
    },
    waitConverged: () => waitFrames(render.denoise.historyMax + 8),
    stats: () => renderer.stats,
    hud: () => ({ visible: hud.visible, crosshair: hud.visible && hud.crosshair, text: hud.text }),
    snapshot: (region?: readonly number[]) =>
      new Promise<{ mean: number; std: number; saturation: number; edge: number; middle: number; region: number }>((resolve) => {
        snapshotRegion = region;
        snapshot = resolve;
      }),
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
    // `&timer=submitted-work` times by submitted work even where timestamps exist, as Safari may have to.
    const timestamps = gpu.timestamps && new URLSearchParams(location.search).get('timer') !== 'submitted-work';
    hooks.checkReport = await runCheck(
      checkRun,
      {
        timestamps,
        promptMs: hooks.promptMs as number,
        timings: world.timings,
        setQuality: (q) => renderer.setQuality(q),
        view: goTo,
        setTimeOfDay: (hours) => {
          timeOfDay = hours;
        },
        waitFrames,
        waitConverged: () => waitFrames(render.denoise.historyMax + 8),
        stats: () => renderer.stats,
        fingerprint: () => fingerprint(world.map),
        shot: () => new Promise((resolve) => (shot = resolve)),
        submittedWork,
        gpuErrors: () => gpu.errors,
        underFire: (view, hours, seconds, options) => underFire({ ...peakGame, timestamps }, view, hours, seconds, options),
      },
      reporter(checkRun),
    );
    // Reported: no more frames, so a browser left open on the page does not hold the GPU.
    stopped = true;
  }
}

start().catch(fail);
