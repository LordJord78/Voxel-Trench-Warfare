/**
 * Bootstrap and the game loop.
 *
 * The page asks for WebGPU first and says at once if there is none. The world
 * generates in workers while the loading screen inks a trench trace; it is
 * uploaded, and the player is drawn standing in the front-line bay behind a
 * "click to play" prompt; in solo play, the click raises the range out in front
 * of the bay (range.ts). Playing, every frame turns the mouse, runs the
 * 60 Hz simulation over the frame's time, places the camera between the last
 * two ticks and draws. Esc (or losing the pointer lock) pauses to a menu with
 * the world still drawn behind it. Alt+Enter, or the menus' Fullscreen, takes
 * the whole page fullscreen and back (ui/fullscreen.ts). The standard views
 * are a free-flying camera (`fly`), and the backquote key toggles it. When the
 * game cannot run, or the GPU goes away, it stops and says why.
 * `window.__trenchline` exposes hooks the tests use.
 */

import { CLOCK_KEYS } from '../core/sky-clock';
import { loadTunables } from '../core/tunables';
import { Stance } from '../physics/character';
import { AudioEngine } from '../audio/engine';
import { audioTunables, planFeedback, planVoices } from '../audio/plan';
import { reportShape } from '../audio/voices';
import { cleanLoadout, type Loadout } from '../combat/arsenal';
import { gunModel, shovelModel } from '../combat/gun-models';
import { harmTunables } from '../combat/harm';
import { BILLBOARD_FLOATS } from '../combat/particles';
import { traceRifle } from '../combat/rifle-model';
import { cameraBasis, projectToPixel, rayDir, type CameraPose } from '../render/camera';
import { LIT_FLOATS, type SmokePuff, type TransientLight } from '../render/effects';
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
import { RoomBattle } from '../sim/room-battle';
import { idleIntent, Session, SHOVEL_HELD, type CombatEvents } from '../sim/session';
import { MAP_SEEDS, isMapId, type MapId } from '../world/generation/params';
import { facingYaw, pickSpawns } from '../world/generation/spawn';
import { relayUrl, Together, type Figure } from './together';
import { rangeAllowed, RangeView } from './range';
import { HitFeedback, hitFeedbackTunables } from './hit-feedback';
import { HitMarker, markerTunables } from '../ui/hit-marker';
import { Fullscreen, fullscreenButtons } from '../ui/fullscreen';
import { LoadingScreen } from '../ui/loading';
import { Overlay, placeName } from '../ui/overlay';
import { PauseMenu } from '../ui/pause';
import { Hud, type HudTag, type Reticle } from '../ui/hud';
import { Readout } from '../ui/readout';
import { kitSummary, loadLoadout, LoadoutMenu, saveLoadout } from '../ui/loadout';
import { MapView } from '../ui/map-view';
import type { SoldierDraw } from '../render/soldiers';
import { boxHitsSolid } from '../physics/collision';
import { Vec3 } from '../physics/vec';
import { battleDarkness, Director, noBattleEvents, type BattleEvents, type BattleInputs, type Strike } from '../battle/director';
import { matchHours } from '../net/clock';
import type { RoomConfig } from '../net/protocol';
import { fireChance, fireTunables } from '../battle/fires';
import { CharQueue, fuelNear } from '../world/char';
import { waterTunables } from '../battle/water';
import { glintsFrom, glintTerms, STILL_WATER, waterFrameTunables, type FrameWater } from '../render/water-frame';
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
import { groundTop, standTop } from '../world/raycast';
import { copyRegion, type RegionCopy } from '../world/region-copy';
import { CameraRig, rigTunables } from './camera-rig';
import { workerRunner } from './destruction-in-worker';
import { CHECK_CANVAS, reporter, runCheck } from './check';
import { BattleClock, catchUpRunner } from './battle-clock';
import { bloodCells, cellsHolding, pageFingerprint, sectorHashes } from './world-compare';
import { coverAt, daylightAt, EffectsFrameBuilder, effectsTunables, NO_BATTLE, type BuiltEffects, type ShownBattle, type DebugEmber, type DebugQuad, type DebugRibbon, type DebugTracer } from './effects-frame';
import { FlyCam } from './flycam';
import { generateInWorkers } from './generate-in-workers';
import { Input } from './input';
import { developerAction, fullscreenKeyName, gunSlot, isFullscreenKey, nextTimeKey, stepTime, type KeyAction } from './keys';
import { pointerLockAction } from './pointer';
import { standardViews, VIEW_NAMES, type ViewName } from './views';
import { fallbackReason, PHONE, placeHere, showFallback, type FallbackReason } from './fallback';
import { Warmup } from './tiers';

/** The map this page plays (`?map=`, the Ravine if none), and its seed: every player of a map generates the same world. */
const MAP: MapId = (() => {
  const asked = new URLSearchParams(location.search).get('map');
  return isMapId(asked) ? asked : 'ravine';
})();
const SEED = MAP_SEEDS[MAP];
/** A canvas resize settles this long before the internal images are reallocated. */
const RESIZE_SETTLE_MS = 150;

type Mode = 'loading' | 'ready' | 'playing' | 'paused' | 'fly';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const loading = new LoadingScreen(document);
const hooks: Record<string, unknown> = { ready: false, phases: loading.phases, map: MAP };
(window as unknown as { __trenchline: unknown }).__trenchline = hooks;
/** Set once the game has stopped for good: its message stays, and no more frames are drawn. */
let stopped = false;
/** Let go of the room's line, if the page has one (Together.letGo, set once it is made): a stopped page leaves its room. */
let letGo: (() => void) | null = null;
/** `?check=<run>`: measure and photograph the standard views and report them (check.ts). */
/** `?dev`: the developer keys (views, fly, time, quality) work; F3's overlay is the frame timings alone. */
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
  // Out of the room: the others see this player leave, rather than a frozen soldier they can kill
  // again and again, and the host role passes on.
  letGo?.();
  // The message goes over everything: a pause menu left open would hide it, and the HUD and the
  // periscope's frame would sit on it.
  document.getElementById('pause')!.hidden = true;
  document.getElementById('hud')!.hidden = true;
  document.getElementById('periscope')!.hidden = true;
  loading.fail(message);
  hooks.error = message;
  hooks.ready = true;
  hooks.ms ??= Math.round(performance.now());
  if (document.pointerLockElement) document.exitPointerLock();
  // And out of fullscreen: its buttons went with the menus, and in Chrome and Edge a short Esc is
  // still the page's, which no longer answers it.
  void fullscreen.exit();
  // A check that cannot run still reports why, so its runner is not left waiting.
  if (checkRun) void reporter(checkRun)('report.json', JSON.stringify({ run: checkRun, userAgent: navigator.userAgent, views: [], errors: [message] }));
}

function fail(error: unknown): void {
  stop(
    error instanceof GpuUnavailable && error.reason === 'no-webgpu'
      ? 'TRENCHLINE needs WebGPU: use Chrome, Edge or Safari\u00a026.'
      : `TRENCHLINE could not start: ${error instanceof Error ? error.message : String(error)}`,
  );
  // Where the game cannot start, its video in its place (fallback.ts); a check reports instead.
  if (!checkRun) fallBack(error instanceof GpuUnavailable && error.reason !== 'limits' ? error.reason : 'failed');
}

/** The game's video where it cannot run, once (fallback.ts); `tryAnyway` for touch. */
function fallBack(reason: FallbackReason, tryAnyway?: () => void): void {
  if (hooks.fallback) return;
  hooks.fallback = reason;
  showFallback(document, reason, tryAnyway && (() => {
    hooks.fallback = undefined;
    tryAnyway();
  }), navigator.userAgent);
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

/** A line at the top of the page for 8 s, over the loading screen or the game (#note). */
function showNote(text: string): void {
  const note = document.getElementById('note');
  if (!note) return;
  note.textContent = text;
  note.hidden = false;
  setTimeout(() => (note.hidden = true), 8000);
}

/**
 * Fullscreen (ui/fullscreen.ts): the whole page, from the buttons on the start screen, in the lobby
 * and in the pause menu, or Alt+Enter (Option+Return on a Mac) anywhere, from the first paint. A
 * refusal says what else to try, and play goes on. Fullscreen where the keyboard can be locked
 * (Chrome, Edge), Esc comes to the page: it pauses as ever, the page still fullscreen, and held
 * down it leaves. The canvas takes the new size as it takes any resize (followCanvas, each frame).
 */
const fullscreen = new Fullscreen(document, navigator);
const toggleFullscreen = () =>
  void fullscreen.toggle().then((ok) => {
    if (!ok) showNote("Fullscreen is not available here: try the browser's own (F11, or Ctrl+Cmd+F on a Mac).");
  });
fullscreenButtons(document.querySelectorAll<HTMLButtonElement>('button[data-fullscreen]'), fullscreen, fullscreenKeyName(navigator.userAgent), toggleFullscreen);
window.addEventListener('keydown', (e) => {
  if (!isFullscreenKey(e)) return;
  // Not also the Enter a focused button or form would take (Play, Resume, a game's code).
  e.preventDefault();
  if (!e.repeat) toggleFullscreen();
});

/** The next paint, so the loading screen can show a phase before work that holds the page. */
const nextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

const storage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();

/** The tab's own storage (the rooms' rejoin tokens: a reload in this tab gets its place back), or null where it is refused. */
function tabStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

async function start(): Promise<void> {
  loading.progress('Starting', null, 0.02);
  // The device comes up and the pipelines compile while the workers generate.
  const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));
  const gpuReady: Promise<Gpu | Error> = createGpu().catch(asError);
  // Without a GPU there is nothing to draw: say so at once, not after generating a world. A device lost
  // before the world is first drawn means the page cannot start (its video, fallback.ts); lost after, the
  // game stops and says so.
  void gpuReady.then((g) => {
    if (g instanceof Error) return fail(g);
    void g.device.lost.then((info) => {
      console.warn(`[gpu] device lost (${info.reason}): ${info.message}`);
      if (hooks.ready === true) stop(`The graphics device was lost (${info.reason}). Reload the page to continue.`);
      else fail(new Error(`the graphics device was lost (${info.reason})`));
    });
  });
  // How long the pipelines take to compile, from the device's coming up (a load timing).
  let compileMs = 0;
  const compiling = gpuReady.then((g) => {
    if (g instanceof Error) return g;
    const t0 = performance.now();
    return compileFrame(g.device).then((c) => ((compileMs = Math.round(performance.now() - t0)), c), asError);
  });
  const world = await generateInWorkers(
    SEED,
    MAP,
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
  // The GPU budget: the tunables', or ?budget=<ms> (a test's, to warm up a fast machine as a slow one).
  const budgetParam = Number(new URLSearchParams(location.search).get('budget'));
  const render = { ...rendererTunables(tun), ...(budgetParam > 0 ? { budgetMs: budgetParam } : {}) };
  const renderer = await Renderer.create(gpu, canvas, gpuWorld, world.plan, { ...render, far, compiled, dynres: true });

  const views = standardViews(world.plan, world.spawn);
  // Craters are cut in a worker, off the frame; a catch-up's cut ahead of their turn on a pool of more
  // ([destruction] catch_up_workers), one core left for the page and one for the session's worker.
  const runner = workerRunner(Math.max(0, Math.min(tun.i('destruction.catch_up_workers'), (navigator.hardwareConcurrency || 4) - 2)));
  const session = Session.create({ map: world.map, plan: world.plan, spawn: world.spawn, runner }, tun, SEED, views.bay.yaw);
  // Each team's starts, picked once from the world as loaded (before any crater): the starts the
  // room's shell field pins (net/shell-fields.ts), whose shells keep clear of them, for every deploy
  // and respawn.
  const starts = { red: pickSpawns(world.map, world.plan, 'front', 4), blue: pickSpawns(world.map, world.plan, 'enemy_front', 4) };
  // The visitor's loadout (ui/loadout.ts), kept between visits: in the hands from the first spawn.
  let loadout: Loadout = loadLoadout(storage);
  /** A loadout chosen mid-match with friends: taken at the next respawn. */
  let pendingLoadout: Loadout | null = null;
  session.equip(loadout);
  // Shells the tests drop: each one's waiter, told its crater's bricks when it settles, and when its cut was in.
  const craterWaiters = new Map<number, (bricks: number) => void>();
  const cutsIn = new Map<number, number>();
  let cratersLanded = 0;
  let shellsDropped = 0;
  /** The battle's harm the session reckoned on the player (CombatEvents.harms), by cause: how many and how much, this visit, told the room or not. */
  const harmed = { shell: { n: 0, hp: 0 }, round: { n: 0, hp: 0 } };
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
  const audio = new AudioEngine(hearing, reportShape(tun));
  let builtDrawn: BuiltEffects['drawn'] = [];
  let builtFlashes: BuiltEffects['flashes'] = [];
  let builtFrame: BuiltEffects['frame'] | null = null;
  let built: BuiltEffects['counts'] = { billboards: 0, tracers: 0, stars: 0, cores: 0, lights: 0, battleTracers: 0, flames: 0, heads: 0, ricochets: 0, embers: 0, ricochetsByKind: [0, 0, 0, 0], embersByKind: [0, 0, 0, 0] };
  /** Whether the rifle is in hand (tests put it down to read the world behind it). */
  let rifleHeld = true;
  const input = new Input();
  const fly = new FlyCam(views.bay);
  const pitchLimit = tun.f('player.pitch_limit');
  const periscopeScale = session.controller.t.stances[Stance.PERISCOPE].fovScale;
  let settings: Settings = loadSettings(storage, defaultSettings(tun));
  /** The backdrop's field of view: the default, the still's (npm run stills), whatever the visitor's own. */
  const backdropFov = defaultSettings(tun).fov;
  /** The frame the still fades from over the backdrop. */
  let revealAt = -1;
  /** The warm-up (tiers.ts) while it runs: the GPU samples seen, and its judge. */
  let warmup: { seen: number; judge: Warmup } | null = null;
  /** The warm-up ended before its judgement (a preset picked, or set by a test): the still fades next frame. */
  const endWarmup = () => {
    if (!warmup) return;
    warmup = null;
    revealAt = frames + 1;
  };
  // The front fires as the visitor chose; a check measures without it.
  session.front.intensity = checkRun ? 'off' : settings.intensity;
  session.artillery.intensity = session.front.intensity;
  renderer.setQuality({ preset: settings.preset });
  let mode: Mode = 'loading';
  /** For the peak-combat driver (peak-combat.ts): the camera held in fly mode while the session runs as if playing. */
  let spectating = false;
  /** For a test's fixed vantage: suppression's look at the session's level in every mode, flying too (the game shows it only while playing and paused). */
  let suppressionAlways = false;
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
  /**
   * In a room's match the battle runs on the match's clock (net/clock.ts), so every client's is at the
   * same moment of it: the match's seconds this frame (null out of a match), and the clock that gives
   * them to the battle, catching it up in chunks over frames when it is far behind (battle-clock.ts).
   */
  let matchNow: number | null = null;
  const battleClock = new BattleClock(tun.i('room_battle.catch_up_chunks'));
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
    // With friends the battle's tempo is the room's; its fire at the player stays off until the room runs it.
    const intensity = together.config?.intensity ?? session.front.intensity;
    return { intensity, darkness: battleDarkness(s.sunElevationDeg, s.flares, flareT), player: session.player.position.toArray() };
  };
  /** The battle's inputs at the match's second `s`: the room's tempo, the dark of the match's time of day then, the player's feet now. */
  const matchInputs = (config: RoomConfig, s: number): BattleInputs => {
    const sky = s === matchNow ? skyNow() : skyState(tun, matchHours(config, s));
    return { intensity: config.intensity, darkness: battleDarkness(sky.sunElevationDeg, sky.flares, flareT), player: session.player.position.toArray() };
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
  /** The battle's water as the lights last showed it, and the battle as the effects last drew it. */
  let water: FrameWater = STILL_WATER;
  let seen: ShownBattle = NO_BATTLE;
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
  /** A blast's strike at `at`: its fire drawn from its shell's seed, where it has one. */
  const strikeOf = (b: CombatEvents['blasts'][number], at: [number, number, number]): Strike => ({ at, material: b.material, crater: b.crater, ...(b.seed === undefined ? {} : { seed: b.seed }) });
  const strikesFrom = (events: CombatEvents): Strike[] => {
    const now: Strike[] = [];
    for (const b of events.blasts) {
      if (fireChance(b.material, fireT) > 0 && b.crater !== null) struck.push(b);
      else now.push(strikeOf(b, b.at));
    }
    const landed = new Set(events.craters.map((c) => c.id));
    struck = struck.filter((b) => {
      if (!landed.has(b.crater!) && (session.ticks - b.tick) * session.clock.dt < STRIKE_WAIT_S) return true;
      const at = fuelNear(session.map, b.at, b.radiusM + fireT.charM, voxelM);
      if (at) now.push(strikeOf(b, at));
      return false;
    });
    return now;
  };
  /** The lights, the horizon's flashes and the water, from the battle as it is now. */
  const showBattle = () => {
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
    // The battle's water: its rings, the wind on it, and its flares' and fires' glints; still at rest, and under a test's own lights.
    water =
      lightsHeld === 'rest' || lights !== planned
        ? STILL_WATER
        : { rings: shownBattle.rings(), ...shownBattle.roughness(), seconds: shownBattle.seconds, glints: glintsFrom(shownBattle.flares(), shownBattle.fires(), sky.flares, glintT) };
  };
  /** `strikes`: the session's shells landed this frame, which may start fires; `splashes`: its rounds and shells into water, which ripple it. */
  const light = (dt: number, eye: readonly number[], strikes: readonly Strike[] = [], splashes: NonNullable<BattleInputs['splashes']> = []) => {
    skyNow();
    battleEvents = noBattleEvents();
    if (mode !== 'paused' || matchNow !== null) {
      lightSeconds = matchNow ?? lightSeconds + dt;
      if (lightsHeld === null) {
        const inputs = { ...battleInputs(), strikes, splashes };
        if (matchNow !== null) {
          // On the match's clock: run on to it, never back, and with no pre-roll (a jump into the dark
          // is the match's own night). A jump past a second (a join, a hidden tab) is caught up unheard,
          // a second at a time at that second's dark, over frames; its chars kept (battle-clock.ts).
          // While the room's log is caught up, the catch-up runs it along the log (the hooks' catchUp), not the frames.
          if (together.caughtUp) {
            const config = together.config!;
            const ran = battleClock.frame(battle, matchNow, (s) => matchInputs(config, s), strikes, splashes);
            battleEvents = ran.heard;
            for (const c of ran.chars) chars.add(c.at);
          }
        } else {
          battleEvents = jumpedIntoDark(dt, inputs.darkness) ? battle.preRoll(flareT.preRollS, dt, inputs) : battle.tick(dt, inputs);
          for (const c of battleEvents.chars) chars.add(c.at);
        }
        ranAt = { hours: timeOfDay, darkness: inputs.darkness };
      }
    }
    // In a match a char waits while any crater is still to be cut there, queued too: its crater goes out
    // on the ground as it is then, and says what it struck there, the same on every client.
    chars.make(session.map, (box) => (together.inMatch ? session.destruction.overlapsPending(box) : session.destruction.overlapsOut(box)));
    // While the battle catches up on the match's clock, or the page on the room's log, what is shown of
    // it is held as it was: a past moment of it, run through seconds a frame, would strobe.
    if (!(matchNow !== null && battleClock.holdsShown(together.caughtUp))) showBattle();
    renderer.setLights(lit, sky.flares, eye);
    renderer.setHorizon(horizon);
    renderer.setWater(water);
  };

  /**
   * The visitor's settings (the pause menu, the keys): a preset they pick is theirs, kept and never moved
   * for them, and ends the warm-up. Only a pick changes the preset: a menu left open across the warm-up's
   * move still holds the preset it opened with.
   */
  const changeSettings = (change: Omit<Settings, 'presetChosen'>, picked: boolean) => {
    const preset = picked ? change.preset : settings.preset;
    if (preset !== renderer.quality.preset) renderer.setQuality({ preset });
    if (picked) endWarmup();
    const next: Settings = { ...change, preset, presetChosen: settings.presetChosen || picked };
    // With friends the battle is the room's: the menu does not set it.
    if (!together.inMatch) {
      session.front.intensity = next.intensity;
      session.artillery.intensity = next.intensity;
    }
    settings = next;
    // A preset not their own (the warm-up's move, for this visit) is kept as the default.
    saveSettings(storage, settings.presetChosen ? settings : { ...settings, preset: defaultSettings(tun).preset });
  };
  const overlay = new Overlay(document.body);
  const periscope = new PeriscopeFrame(document);
  const hud = new Hud(document);
  const mapView = new MapView(document.querySelector<HTMLCanvasElement>('#hud canvas.map')!, world.plan);
  const pauseMenu = new PauseMenu(document, {
    resume: () => resume(),
    change: changeSettings,
    time: (value) => (timeOfDay = value),
    lapse: (speed) => (lapse = speed),
    leave: () => together.leave(),
    endMatch: () => together.endMatch(),
  });
  // The loadout (ui/loadout.ts): chosen on the start screen, in the lobby, or from the pause menu.
  const loadoutMenu = new LoadoutMenu(document, tun);
  const showKit = () => {
    const line = kitSummary(loadout);
    for (const id of ['kit-line', 'deploy-kit']) {
      const el = document.getElementById(id);
      if (el) el.textContent = line;
    }
  };
  showKit();
  /** Take `l`: kept for the next visit; in the hands now, or (with friends, mid-match) at the next respawn. */
  const takeLoadout = (l: Loadout, now: boolean) => {
    loadout = l;
    saveLoadout(storage, l);
    showKit();
    if (now) {
      session.equip(l);
      pendingLoadout = null;
    } else pendingLoadout = l;
  };
  const openLoadout = (from: 'start' | 'lobby' | 'pause') => {
    if (from === 'start') {
      loadoutMenu.open(loadout, {
        action: 'Deploy',
        done: (l) => {
          takeLoadout(l, true);
          play(true);
        },
      });
    } else if (from === 'lobby') {
      // Not yet gone in: the lobby, or the match's way in. The kit is in the hands at once.
      loadoutMenu.open(loadout, { action: 'Done', done: (l) => takeLoadout(l, true) });
    } else {
      pauseMenu.close();
      const live = together.inMatch;
      loadoutMenu.open(loadout, {
        action: live ? 'Done' : 'Deploy',
        note: live ? 'Taken when you are next back in.' : undefined,
        done: (l) => {
          takeLoadout(l, !live);
          resume();
        },
        cancel: () => {
          pauseMenu.open(settings, timeOfDay, lapse);
          pauseMenu.together(together.inMatch, together.isOwner);
        },
      });
    }
  };
  document.getElementById('loadout-open')?.addEventListener('click', () => openLoadout('start'));
  document.getElementById('pause-loadout')?.addEventListener('click', () => openLoadout('pause'));
  for (const id of ['lobby-loadout', 'deploy-loadout']) document.getElementById(id)?.addEventListener('click', () => openLoadout('lobby'));
  /** The gun in the hands and how it fires, for the HUD. */
  const modeLabel = (): string => {
    if (session.held === SHOVEL_HELD) return '';
    const w = session.weapon;
    if (w.spec.pellets > 1) return 'Pump';
    return w.spec.automatic && !w.semi ? 'Auto' : 'Single';
  };
  const kitLine = (): string => {
    const s = session.arm.spec;
    const bits: string[] = [];
    if (session.held !== SHOVEL_HELD && session.weapon.rounds === 0 && !session.weapon.reloading) bits.push('Empty: R to reload');
    if (s.fit.side !== 'none') bits.push(session.lightOn ? (s.fit.side === 'laser' ? 'Laser on' : 'Light on') : s.fit.side === 'laser' ? 'L for the laser' : 'L for the light');
    bits.push(session.arms.map((a, i) => `${i + 1} ${a.spec.gun.name}`).join('  '));
    return bits.join(' · ');
  };
  /** What is over the middle of the view, aimed: the fitted sight's reticle (iron sights: none). */
  const reticleOf = (): Reticle => {
    if (session.held === SHOVEL_HELD) return 'cross';
    const o = session.arm.spec.fit.optic;
    return o === 'reddot' ? 'dot' : o === 'holo' ? 'holo' : o === 'scope' ? 'scope' : 'none';
  };
  /** The ticks' distance from the middle (vh): the cone's half-angle on the screen, at least the reference's 0.7. */
  const crosshairGap = (at: CameraPose): number => {
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    const halfV = Math.atan(Math.tan(((at.fov ?? 90) * Math.PI) / 360) * (h / w));
    return Math.max(0.7, (Math.tan((session.coneDeg() * Math.PI) / 180) / Math.tan(halfV)) * 50);
  };
  /** Teammates' marks where they stand on the page. */
  const tagsFor = (draws: readonly SoldierDraw[], at: CameraPose): HudTag[] => {
    const res: [number, number] = [Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight)];
    return together.tags(draws, at.position).flatMap((t) => {
      const px = projectToPixel(at, res, t.at);
      if (!px) return [];
      const distanceM = Math.hypot(t.at[0] - at.position[0], t.at[1] - at.position[1], t.at[2] - at.position[2]);
      return [{ x: px[0], y: px[1], name: t.name, team: t.team, distanceM }];
    });
  };
  /** The mouse turns by the sight's magnification, aimed. */
  const aimTurn = () => {
    const z = session.zoomAt();
    return z > 1.0001 ? session.hands.adsSensitivity / z : 1;
  };
  let wheelAt = Number.NEGATIVE_INFINITY;
  /** Soldiers a test stands in the world without a room (puppets). */
  let puppets: Figure[] = [];
  /** A team's starts: the line its players start and come back in at, as the world was loaded (starts). */
  const startOf = (team: 'red' | 'blue', k: number) => {
    const spawns = starts[team];
    return spawns[k % spawns.length];
  };
  // Hit feedback (hit-feedback.ts): the marker at the crosshair, HEADSHOT and KILL under it, the red
  // flash of being hit (hit-marker.ts), the voices of a hit, and bodies flinching and falling as they
  // were shot; on the range and in a room alike.
  const hitMarker = new HitMarker(document, markerTunables(tun));
  const hits = new HitFeedback(hitFeedbackTunables(tun), hitMarker, harmTunables(tun).frontDamageScale);
  // The catch-up's breath: a message on a channel of the page's own, which a hidden tab does not
  // throttle as it does a timer (to once a second or less), so a friend who tabs away while their page
  // catches up on the room's battle is not slowed to a breath a second. One breath at a time.
  const breathing = new MessageChannel();
  const breathe = () =>
    new Promise<void>((resolve) => {
      breathing.port1.onmessage = () => resolve();
      breathing.port2.postMessage(0);
    });
  /**
   * Each welcome's catch-up on this page, for the tests: when it began (performance.now: the welcome's
   * arrival, which starts it), how long it took (ms; null while it runs, or if it failed), each of
   * the log's entries done as it said (ms from its start, entries done) of how many (`total`), and
   * where its time went (`parts`, ms): the destruction workers' jobs done meanwhile, the ms they ran
   * there and the ms beyond that from post to result (RunnerStats); the session's destruction ticks
   * (the write-back, and each crater's copy and post); the battle's runs along the log, its chars made;
   * its breaths, and the ms spent awaiting them; and the page's frames meanwhile, and their main-thread ms.
   */
  type CatchUpParts = { jobs: number; jobMs: number; tripMs: number; ticks: number; tickMs: number; runs: number; runMs: number; breaths: number; breathMs: number; frames: number; frameMs: number };
  const catchUps: { from: number; ms: number | null; total: number; done: [number, number][]; parts: CatchUpParts }[] = [];
  /** The catch-up running, whose frames and destruction ticks are counted in its parts; null with none. And how many run. */
  let catching: CatchUpParts | null = null;
  let catchingUp = 0;
  const tickOf = session.destruction.tick.bind(session.destruction);
  session.destruction.tick = () => {
    const parts = catching;
    if (!parts) return tickOf();
    const t0 = performance.now();
    try {
      return tickOf();
    } finally {
      parts.ticks++;
      parts.tickMs += performance.now() - t0;
    }
  };
  // Playing with friends (together.ts): nothing happens until the player hosts or follows a link.
  const searchParams = new URLSearchParams(location.search);
  const together = new Together(document, relayUrl(searchParams, location.hostname, import.meta.env.DEV, import.meta.env.VITE_RELAY_URL), __TRENCHLINE_BUILD__, storage, {
    map: MAP,
    switchMap: (map, room) => {
      const url = new URL(location.href);
      url.searchParams.set('map', map);
      url.searchParams.set('room', room);
      location.assign(url);
    },
    showLobby: () => loading.hide(),
    startScreen: (text, busy) => loading.back(text, busy),
    deploy: (team, index, match) => {
      const at = startOf(team, index);
      session.team = team;
      session.equip(pendingLoadout ?? loadout);
      pendingLoadout = null;
      session.respawn(at.position, facingYaw(at.bay));
      timeOfDay = match.config.timeOfDay;
      lapse = match.config.lapse;
      // The match's battle from its start, on its clock: every client's the same moment of the same battle.
      battle = new Director(world.plan, tun, SEED, ground);
      battleClock.reset();
      // The front fires at the player from the line across from their team, at the room's intensity
      // (the shared-battle spec's "The front in a room"); the room sends the shells, not the artillery.
      session.frontFrom(team === 'red' ? 1 : 0);
      session.front.intensity = match.config.intensity;
      session.artillery.intensity = 'off';
    },
    play: () => play(true),
    ended: () => {
      pauseMenu.close();
      input.blur();
      mode = 'ready';
      if (document.pointerLockElement) document.exitPointerLock();
      // The battle is the visitor's again: the enemy's line, at their settings.
      session.frontFrom(1);
      session.front.intensity = settings.intensity;
      session.artillery.intensity = settings.intensity;
    },
    note: showNote,
    killed: () => {
      session.alive = false;
    },
    respawn: (team, spawn) => {
      const at = startOf(team, spawn);
      // A loadout chosen while dead (or mid-fight) is the one they come back with.
      if (pendingLoadout) {
        session.equip(pendingLoadout);
        pendingLoadout = null;
      }
      session.respawn(at.position, facingYaw(at.bay));
      renderer.resetHistory();
    },
    battle: () => new RoomBattle(session, fireT),
    // The room's log caught up (sim/room-battle.ts catchUp): in a match, the battle deploy has just
    // made at 0 run along it, a second at most a step, at each second's darkness (the match's time of
    // day then) and the player's feet, given each crater's strike first; its chars made at once, as
    // nothing is pending after a settle (battle-clock.ts catchUpRunner). With no match the battle and the
    // clock are the visitor's, and left alone. Then the battle's clock is given the second it reached,
    // and the frames run it on to now, catching up silently past SILENT_STEP_S. It is that battle
    // throughout: if the room ends the match and starts the next while the log is caught up, the
    // next's deploy makes its own, from 0. A catch-up that fails stops the game (`failed`). It breathes
    // through `breathe`, is patient with a crater by the page's own clock, and says how far it has come
    // (`progress`, which Together shows).
    catchUp: async (room, log, match, now, progress) => {
      const director = battle;
      const made = (events: BattleEvents) => {
        for (const c of events.chars) chars.add(c.at);
        chars.make(session.map, (box) => session.destruction.overlapsPending(box));
      };
      const ran = match ? catchUpRunner(director, (s) => matchInputs(match.config, s), made) : null;
      const parts: CatchUpParts = { jobs: -runner.stats.jobs, jobMs: -runner.stats.jobMs, tripMs: -runner.stats.tripMs, ticks: 0, tickMs: 0, runs: 0, runMs: 0, breaths: 0, breathMs: 0, frames: 0, frameMs: 0 };
      const record: (typeof catchUps)[number] = { from: performance.now(), ms: null, total: 0, done: [], parts };
      catchUps.push(record);
      const told = (done: number, total: number) => {
        record.total = total;
        record.done.push([performance.now() - record.from, done]);
        progress(done, total);
      };
      // Each part timed as it goes.
      const along = ran && {
        runTo: (s: number, strikes: readonly Strike[]) => {
          const t0 = performance.now();
          ran.runTo(s, strikes);
          parts.runs++;
          parts.runMs += performance.now() - t0;
        },
      };
      const breath = async () => {
        const t0 = performance.now();
        await breathe();
        parts.breaths++;
        parts.breathMs += performance.now() - t0;
      };
      catching = parts;
      catchingUp++;
      try {
        await room.catchUp(log, match?.startAt ?? null, now, along, breath, { clock: () => performance.now(), progress: told, ahead: tun.i('room_battle.catch_up_ahead') });
      } finally {
        if (catching === parts) catching = null;
        // The pool's work is done once no catch-up runs (each crater cut ahead is in, or was dropped): it goes.
        if (--catchingUp === 0) runner.rest();
        parts.jobs += runner.stats.jobs;
        parts.jobMs += runner.stats.jobMs;
        parts.tripMs += runner.stats.tripMs;
      }
      record.ms = performance.now() - record.from;
      renderer.largeEdit();
      if (ran && battle === director) battleClock.given = ran.reached;
    },
    // A crater that never goes in, or any other failure to catch up: the world can't be the room's,
    // so the game stops and says why.
    failed: (e) => {
      console.error(e);
      stop(`TRENCHLINE stopped: ${e instanceof Error ? e.message : String(e)}`);
    },
  }, hits, { tab: tabStorage(), silentS: tun.f('net.room_silent_s') });
  letGo = () => together.letGo();

  // The range (range.ts): solo play's dummies and steel plates in front of the spawn bay, from the
  // click that starts play. Never in a room or a check run, nor with ?range=0; and a test's world has
  // one only when it asks (hooks.range, which sets whether it may stand).
  const range = new RangeView(tun);
  const readout = new Readout(document.querySelector<HTMLElement>('#hud .readout'), range.t.readoutS);
  let rangeOn = rangeAllowed({ room: together.net !== null, check: checkRun !== null, param: searchParams.get('range') });
  /** Whether play has started: the range goes up with the first start. */
  let played = false;
  const raiseRange = () => {
    // Sighted from the step view: the eye of a player standing on the spawn bay's firing step.
    if (rangeOn && together.net === null) range.raise(session, world.spawn, views.step.position);
  };
  /** The soldiers given the renderer each frame: the others, then the range's dummies (one list, kept). */
  const soldiers: SoldierDraw[] = [];
  const lowerRange = () => {
    range.lower(session);
    readout.clear();
  };

  const play = (lock: boolean) => {
    if (stopped) return;
    loading.hide();
    // From the backdrop to the spawn: a cut, so the image starts afresh.
    if (mode === 'ready') renderer.resetHistory();
    // The range goes up with the click that starts play: until then the page's still holds.
    if (!played) {
      played = true;
      raiseRange();
    }
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
    pauseMenu.together(together.inMatch, together.isOwner);
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
        changeSettings({ ...settings, preset: settings.preset === 'high' ? 'low' : 'high' }, true);
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
      // Fullscreen with the keyboard locked (Chrome, Edge), Esc comes here: pause() lets the
      // pointer go, and the page stays fullscreen.
      pause();
      return;
    }
    if (mode === 'paused' || mode === 'loading') return;
    // In a match, Tab holds the board up (and does not move the page's focus).
    if (e.code === 'Tab' && together.inMatch) {
      e.preventDefault();
      together.boardOpen = true;
      return;
    }
    // The developer keys (views, fly, time, quality) need ?dev, so a visitor's 1 or T does nothing
    // strange; F3's overlay is the frame timings alone, and turns none of them on (keys.ts).
    const action = developerAction(e.code, devMode);
    if (e.code === 'Backquote' && !e.repeat) {
      if (action?.kind !== 'fly') return;
      if (mode === 'fly') mode = 'playing';
      else enterFly(lastPose);
      return;
    }
    held.add(e.code);
    if (mode === 'playing') input.keyDown(e.code, e.repeat);
    if (mode === 'playing' && !e.repeat) {
      // The guns by their numbers (the developer's views have them with ?dev), the keys' card, the map.
      const slot = gunSlot(e.code, devMode);
      if (slot !== null) {
        input.swap(slot);
        return;
      }
      if (e.code === 'KeyH') hud.toggleHelp();
      if (e.code === 'KeyM') mapView.show(true);
    }
    // Held keys repeat only the time steps.
    if (!action || action.kind === 'fly' || (e.repeat && action.kind !== 'time-step')) return;
    e.preventDefault();
    act(action);
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Tab') together.boardOpen = false;
    if (e.code === 'KeyM') mapView.show(false);
    held.delete(e.code);
    input.keyUp(e.code);
  });
  // Focus left the page: let go of everything, or the player walks on with W stuck down.
  window.addEventListener('blur', () => {
    held.clear();
    input.blur();
    mapView.show(false);
  });
  canvas.addEventListener('click', () => {
    if (mode === 'ready') play(true);
    else if ((mode === 'playing' || mode === 'fly') && document.pointerLockElement !== canvas) lockPointer();
  });
  document.addEventListener('pointerlockchange', () => {
    // Lost in play, a pause. Granted once play has stopped (Esc paused while the request was
    // pending, or the match ended), let go at once: fullscreen in Chrome and Edge, where Esc is
    // the page's, a short Esc would no longer free it.
    const action = pointerLockAction(!stopped && (mode === 'playing' || mode === 'fly'), document.pointerLockElement === canvas);
    if (action === 'pause') pause();
    else if (action === 'release') document.exitPointerLock();
  });
  // The trigger: the left button, with the pointer locked to the game (a click that locks it does not fire).
  window.addEventListener('mousedown', (e) => {
    if (e.button === 0 && mode === 'playing' && document.pointerLockElement === canvas) input.trigger(true);
    // The sights: the right button.
    if (e.button === 2 && mode === 'playing' && document.pointerLockElement === canvas) input.aim(true);
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) input.trigger(false);
    if (e.button === 2) input.aim(false);
  });
  // The right button is the sights', not the page's menu, over the game.
  window.addEventListener('contextmenu', (e) => {
    if (document.pointerLockElement === canvas || e.target === canvas) e.preventDefault();
  });
  // The wheel: the other gun, a turn of it at a time.
  window.addEventListener(
    'wheel',
    (e) => {
      if (mode !== 'playing' || document.pointerLockElement !== canvas || e.deltaY === 0) return;
      const now = performance.now();
      if (now - wheelAt < 180) return;
      wheelAt = now;
      input.cycle();
    },
    { passive: true },
  );
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
  let hudAmmo = '';
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
  // test reads back stays put. A frame redrawn (redraw) is drawn at the same moment as the last: no
  // time passes in it, so the same frame is drawn again (the capture tool's control, with its burst hidden).
  let frozen = false;
  let steps = 0;
  let still = 0;
  /** How far apart a frozen loop's frames are (ms): a sixtieth of a second unless a test asks for a faster display's. */
  let frozenMs = 1000 / 60;
  /** For tests: the view turned this many degrees a second, as the mouse turns it; swinging as a sine of `periodS` if given (a look back and forth). */
  let turning: { degPerS: number; periodS: number; since: number } | null = null;
  /**
   * For tests: each frame's drawn gun as the camera sees it (its 3 × 4 transform in the camera's right,
   * up and forward, metres), the frame's time, and the session's tick and its share of the next.
   */
  let gunFrames: { left: number; out: { ms: number; ticks: number; alpha: number; m: number[] | null }[]; done: (frames: { ms: number; ticks: number; alpha: number; m: number[] | null }[]) => void } | null = null;
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
    const advance = frozen && still > 0 ? 0 : frozenMs;
    if (frozen && still > 0) still--;
    try {
      const t0 = performance.now();
      step(frozen ? last - skipped + advance : time);
      const ms = performance.now() - t0;
      mainMs[mainFrames++ % MAIN_FRAMES] = ms;
      if (catching) {
        catching.frames++;
        catching.frameMs += ms;
      }
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
    // In a match the time of day is the match's, on the room's clock, the same on every client (the
    // darkness follows it, so the hamlet's fires light at the match's nightfall); out of one, the lapse creeps it on.
    matchNow = together.inMatch ? together.net!.matchSeconds() : null;
    if (matchNow !== null) timeOfDay = matchHours(together.config!, matchNow);
    else if (lapse > 0 && mode !== 'loading') timeOfDay = (timeOfDay + (lapse * dt) / 60) % 24;
    // A room joined takes the range down: there is none in a room.
    if (range.up && together.net !== null) lowerRange();
    // The others posed, given to the session to strike, and their shots fired, before its ticks run;
    // the range's dummies posed, the standing ones given to it as targets (the player's rounds alone);
    // each flinching and falling as its hits say.
    const draws = together.prepare(session, dt, puppets, now);
    const dummies = range.frame(session, session.ticks * session.clock.dt, (id) => hits.figureOverlay(id, now));
    let pose: CameraPose;
    if (mode === 'fly') {
      fly.sensitivity = settings.sensitivity;
      fly.update(dt, held, look);
      look[0] = 0;
      look[1] = 0;
      pose = { ...fly.pose, fov: settings.fov };
      periscope.set(0);
      if (spectating && together.caughtUp) {
        session.intent = input.intent();
        if (session.advance(ms / 1000) > 0) input.ticked();
      }
    } else {
      // With friends the world does not wait for a paused player: they stand while the menu is open.
      // Nor for one still on the deploy screen once the match is on: its shells land and its craters
      // are cut there too; but nobody draws or shoots them (together.frame sends nothing until they go in).
      // Nor while the room's log is caught up: the catch-up lands it on the world (together.ts caughtUp).
      const live = mode === 'playing' || (mode === 'paused' && together.inMatch);
      const runs = together.caughtUp && (live || (mode === 'ready' && together.begun));
      if (runs) {
        if (mode === 'playing') {
          if (turning) {
            const swing = turning.periodS > 0 ? Math.sin((2 * Math.PI * (now - turning.since)) / 1000 / turning.periodS) : 1;
            input.mouse((turning.degPerS * swing * dt) / (settings.sensitivity * aimTurn()), 0);
          }
          input.look(session.player, settings.sensitivity * aimTurn(), pitchLimit);
          session.intent = input.intent();
        } else {
          session.intent = idleIntent();
        }
        // The battle's wind as the lights last showed it carries the loose smoke, dust and blood; none at rest, as the water is still.
        if (lightsHeld === 'rest' || lights !== planned) session.particles.wind = [0, 0, 0];
        else {
          const [wx, wz] = shownBattle.wind.at(shownBattle.seconds);
          session.particles.wind = [wx, 0, wz];
        }
        if (session.advance(ms / 1000) > 0 && mode === 'playing') input.ticked();
        if (!session.player.onFiringStep) input.lowerPeriscope();
      }
      together.frame(session, live);
      // Until the click, the world is drawn from the firing step over the parapet at dusk at the default
      // field of view, as the page's still is (npm run stills); the click starts play at the spawn, in the
      // bay, at the visitor's own.
      const backdrop = views.step;
      pose = mode === 'loading' || mode === 'ready' ? { position: [...backdrop.position], yaw: backdrop.yaw, pitch: backdrop.pitch, fov: backdropFov } : rig.pose(session, dt, settings.fov);
      // Killed: the view goes down with the body, and over.
      const dead = together.deadFor(performance.now());
      if (dead !== null && (mode === 'playing' || mode === 'paused')) {
        const f = Math.min(1, dead / 0.7) ** 2;
        const feet = session.player.position.y;
        pose = { ...pose, position: [pose.position[0], feet + 0.6 + (pose.position[1] - feet - 0.6) * (1 - f), pose.position[2]], pitch: pose.pitch * (1 - f) + 12 * f, roll: 32 * f };
      }
      periscope.set((1 - rig.fovScale) / (1 - periscopeScale));
    }
    // What is in the hands, while playing (paused too), not through the periscope or flying: the
    // gun with its fit, or the shovel; through a scope, nothing (its circle is the HUD's).
    const inHands = session.arm.spec;
    renderer.setRifleModel(session.held === SHOVEL_HELD ? shovelModel() : gunModel(inHands.gun.key, inHands.fit));
    const scoped = session.held !== SHOVEL_HELD && inHands.fit.optic === 'scope' && session.aimed >= 0.85;
    let rifle: RiflePose | null = null;
    if (rifleHeld && session.alive && !scoped && (mode === 'playing' || mode === 'paused') && session.player.stance !== Stance.PERISCOPE) rifle = rig.rifle(session, pose);
    else rig.hideRifle();
    renderer.setRifle(rifle);
    if (gunFrames) {
      // The drawn gun in the camera's frame: its axes and its place along the camera's right, up and forward.
      let m: number[] | null = null;
      if (rifle) {
        const b = cameraBasis(pose.yaw, pose.pitch, pose.roll ?? 0);
        const w = rifle.toWorld;
        const rel = (v: readonly number[]) => [b.right, b.up, b.forward].map((a) => a[0] * v[0] + a[1] * v[1] + a[2] * v[2]);
        m = [...rel([w[0], w[1], w[2]]), ...rel([w[3], w[4], w[5]]), ...rel([w[6], w[7], w[8]]), ...rel([w[9] - pose.position[0], w[10] - pose.position[1], w[11] - pose.position[2]])];
      }
      gunFrames.out.push({ ms: dt * 1000, ticks: session.ticks, alpha: session.clock.alpha, m });
      if (--gunFrames.left <= 0) {
        const g = gunFrames;
        gunFrames = null;
        g.done(g.out);
      }
    }
    // Under fire the picture greys and closes in, while playing (and paused); not flying, unless a test asks.
    const shaken = mode === 'playing' || mode === 'paused' || suppressionAlways;
    renderer.setSuppressionLook(shaken ? session.suppression.desaturation : 0, shaken ? session.suppression.vignette : 0);
    // What this frame's ticks did, once: seen, from the rifle as it is drawn, and heard.
    const events = session.drainEvents();
    for (const m of events.harms) {
      harmed[m.cause].n++;
      harmed[m.cause].hp += m.amount;
    }
    // A crater of more than 64 bricks: the key's shadow map is traced outright once they are up.
    if (events.craters.some((c) => c.bricks > 64)) renderer.largeEdit();
    for (const c of events.cuts) if (craterWaiters.has(c.id)) cutsIn.set(c.id, performance.now());
    for (const c of events.craters) {
      cratersLanded++;
      craterWaiters.get(c.id)?.(c.bricks);
      craterWaiters.delete(c.id);
    }
    // The battle seen (its flares, flashes, smoke, tracers, and fires' flames and plumes) as the lights last showed it; none at rest.
    // Held as it was while the battle catches up on the match's clock, or the page on the room's log, as the lights are (light()).
    if (!(matchNow !== null && battleClock.holdsShown(together.caughtUp))) seen = lightsHeld === 'rest' || lights !== planned ? NO_BATTLE : { seconds: shownBattle.seconds, flares: shownBattle.flares(), flashes: shownBattle.flashes(), smoke: shownBattle.smoke(), tracers: shownBattle.tracers(), flames: shownBattle.flames(), plumes: shownBattle.plumes() };
    // The dummies after any others: the renderer has eight soldiers' slots.
    if (dummies.length > 0) {
      soldiers.length = 0;
      for (const d of draws) soldiers.push(d);
      for (const d of dummies) soldiers.push(d);
      renderer.setSoldiers(soldiers);
    } else renderer.setSoldiers(draws);
    together.after(session, events, draws, performance.now());
    // The player's rounds on the range (once a frame: its events are the readout's too), first, so
    // the hit feedback knows the dummies they killed and gives nothing for the rounds after.
    const ranged = range.after(events, session.ticks * session.clock.dt);
    // What the frame's hits show and sound (hit-feedback.ts), with what a kill, a plate or the player's
    // death made since the last frame; the bodies drawn say where each chest is, for a kill. In a room's
    // match (session.room, as Together.prepare set it) the front's rounds and the shells hurt the player too,
    // but not on the deploy screen: the match's world runs there and its shells land, but the player is
    // not in it (and the room is never told of that harm).
    const feedback = hits.frame(session, events, now, dummies.length > 0 ? soldiers : draws, range.killed(), mode !== 'ready');
    // The range's events read out under the marker; its kills and plates fed back at once, their
    // voices with the next frame's.
    readout.show(ranged, now / 1000);
    readout.tick(now / 1000);
    for (const e of ranged) {
      if (e.kind === 'kill') hits.kill(e.id, true, null, now, session, e.zone);
      else if (e.kind === 'plate') {
        const plate = range.state().plates[e.index];
        if (plate) hits.plate(e, plate.at, now);
      }
    }
    hitMarker.tick(now);
    // The tracers burn brighter by day, by the sun the frame is lit with, and while it is up their light
    // covers the haze behind them.
    const sun = skyNow().sunElevationDeg;
    const frameEffects = effects.build(session, events, rifle, pose.position, seen, skyNow().flares, draws, daylightAt(sun, effects.t), coverAt(sun, effects.t));
    audio.listen(pose);
    // The battle's events from the last frame's lights (light() below runs the battle's clock); the hits' feedback.
    audio.play([...planVoices(hearing, events, pose.position, battleEvents), ...planFeedback(hearing, feedback, pose.position)]);
    renderer.setEffects(frameEffects.frame);
    renderer.setTransientLights(frameEffects.lights);
    renderer.setBlasts(frameEffects.blasts);
    renderer.setSmoke(frameEffects.smoke);
    built = frameEffects.counts;
    builtDrawn = frameEffects.drawn;
    builtFlashes = frameEffects.flashes;
    builtFrame = frameEffects.frame;
    // In a match the battle's strikes are the room's shells' (sim/room-battle.ts): each on what its crater
    // struck as it went out, its fire standing from the match's second its shell landed.
    const strikes = together.inMatch ? (together.battle?.strikes(events, together.net!.match!.startAt) ?? []) : strikesFrom(events);
    light(dt, pose.position, strikes, events.splashes.map((w) => ({ at: w.at, energyJ: w.energyJ })));
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
    // The warm-up's frames: each one's scale, and the GPU time newly measured with it (tiers.ts).
    if (warmup) {
      const s = renderer.stats;
      warmup.judge.frame(s.scale, s.gpuSamples > warmup.seen ? s.gpuLastMs : null);
      warmup.seen = s.gpuSamples;
      if (warmup.judge.done) {
        const q = renderer.quality;
        const moved = !stopped && !settings.presetChosen && q.preset === 'high' && q.dynres && warmup.judge.pick(render.budgetMs) === 'low';
        if (moved) {
          renderer.setQuality({ preset: 'low' });
          // For this visit: not the visitor's own, so not kept (changeSettings saves the default).
          settings = { ...settings, preset: 'low' };
          showNote('Quality set to Low for this machine — change it in the pause menu (Esc).');
        }
        warmup = null;
        // The preset's new textures start the histories afresh: the still waits for them again.
        revealAt = frames + (moved ? render.denoise.historyMax + 8 : 1);
      }
    }
    // The still fades once the world behind it has settled (the denoiser's history and its margin), or the warm-up has judged it.
    if (mode === 'ready' && frames === revealAt) loading.reveal();
    if (mode === 'loading') {
      mode = 'ready';
      // A first visit at the high preset, not the visitor's own, is warmed up (tiers.ts), the still over it meanwhile.
      if (!checkRun && !settings.presetChosen && settings.preset === 'high' && gpu.timestamps && renderer.quality.dynres) warmup = { seen: renderer.stats.gpuSamples, judge: new Warmup() };
      revealAt = warmup ? -1 : frames + render.denoise.historyMax + 8;
      loading.ready(() => play(true), together.relay ? { host: () => void together.host(), join: (code) => together.join(code) } : undefined, {
        now: MAP,
        pick: (map) => {
          const url = new URL(location.href);
          url.searchParams.set('map', map);
          url.searchParams.delete('room');
          location.assign(url);
        },
      });
      // A friend's link: straight to their game's lobby.
      const room = searchParams.get('room');
      if (room && together.relay) together.join(room);
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
    hud.room(hud.visible ? together.roomline() : null);
    if (hud.visible) {
      // Every frame: the compass, the sight, teammates' marks, and the map while M is held.
      hud.compass(pose.yaw);
      hud.sight(reticleOf(), session.held === SHOVEL_HELD ? 0 : session.aimed, crosshairGap(pose));
      hud.tags(tagsFor(draws, pose));
      if (mapView.open) {
        const team = together.team;
        const p = session.player;
        mapView.draw({ x: p.position.x, z: p.position.z, yaw: p.yaw, team }, draws.filter((d) => team !== null && d.team === team).map((d) => ({ x: d.feet[0], z: d.feet[2], team: d.team })));
      }
    }
    // The HUD's lines ten times a second, and at once when the gun's count or its reload changes, so
    // the count is a shot's own frame's (G3 Task 4's captures: frame 0 of a hit still showed the
    // count before its shot, the 100 ms throttle's lag, in play as when stepped).
    const ammo = `${session.held}:${session.weapon.rounds}:${session.weapon.reloading}`;
    if (hud.visible && (now - hudShown >= 100 || ammo !== hudAmmo)) {
      hudShown = now;
      hudAmmo = ammo;
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
        crosshair: p.stance !== Stance.PERISCOPE && session.alive && session.aimed < 0.5,
        weapon: session.held === SHOVEL_HELD ? 'Shovel' : session.arm.spec.gun.name,
        mode: modeLabel(),
        kit: kitLine(),
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
  // For tests: the rifle as the CPU traces it through the last frame's pixels (the model in the hands).
  /** Metres along pixel (x, y)'s ray to the rifle as the last frame drew it, or null. */
  const traceRiflePixel = (s: RifleDrawn, x: number, y: number): number | null => {
    const m = s.toWorld!;
    const cam = s.camera!;
    const d = rayDir(cam, s.res, x + 0.5, y + 0.5);
    const o = [cam.position[0] - m[9], cam.position[1] - m[10], cam.position[2] - m[11]];
    const along = (v: readonly number[], c: number) => v[0] * m[c * 3] + v[1] * m[c * 3 + 1] + v[2] * m[c * 3 + 2];
    const hit = traceRifle(renderer.rifleModel(), [along(o, 0), along(o, 1), along(o, 2)], [along(d, 0), along(d, 1), along(d, 2)]);
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
    /** Where a foot stands at (x, z) metres: the top of the highest voxel neither air nor water (world/raycast.ts standTop), metres; null, none. */
    footAt: (x: number, z: number) => standTop(session.map, x, z, voxelM),
    /** The visitor's settings as they stand (the pause menu's; their battle's intensity among them). */
    settings: () => ({ ...settings }),
    /** Playing with friends: the room, this player's seat, the seats, and the others as drawn. */
    together: {
      relay: () => together.relay,
      room: () => together.net?.room ?? null,
      you: () => together.net?.you ?? -1,
      owner: () => together.net?.owner ?? -1,
      /** The match's seconds on the room's clock; 0 with no match. */
      matchSeconds: () => together.net?.matchSeconds() ?? 0,
      seats: () => together.net?.seats ?? [],
      phase: () => together.net?.phase ?? null,
      begun: () => together.begun,
      deadFor: () => together.deadFor(performance.now()),
      score: () => together.net?.score ?? null,
      claimed: () => together.claimed,
      /** Each player's kills and deaths, as the room last told them: [seat, kills, deaths]. */
      tallies: () => [...(together.net?.tallies ?? new Map<number, { kills: number; deaths: number }>()).entries()].map(([id, t]) => [id, t.kills, t.deaths]),
      /** The start screen's word on a join (its note under Join), and whether the start screen is up. */
      joinNote: () => ({ up: !document.getElementById('loading')!.hidden, text: document.getElementById('join-note')?.textContent ?? '' }),
      others: () => together.others().map(({ seat, state }) => ({ id: seat.id, team: seat.team, name: seat.name, position: state.position, stance: state.stance })),
      /**
       * The room's shells on this page (sim/room-battle.ts), this match's: how many it has heard (landed
       * or in the air), those landed (id, where as [x, z] metres, how big) in the order they landed, and
       * the next to land (its id, where, and in how long on the room's clock; null with none in the air).
       * A page that stayed holds the match's from its start; one caught up on the log (a reload, a late
       * join) the match's too, as RoomBattle.catchUp lists only this match's shells (an earlier match's
       * land quietly, unlisted), with the same ids. Their ids run on from the last match's (the room
       * numbers them across matches), so a match is told from another by its ids. Out of a match, none:
       * the last match's, as its end left them, are lastLanded's.
       */
      shells: () => {
        const battle = together.battle;
        const air = battle?.waiting ?? [];
        const next = air.reduce<(typeof air)[number] | null>((a, s) => (a === null || s.landAt < a.landAt ? s : a), null);
        const now = together.net?.serverNow() ?? 0;
        return {
          heard: (battle?.landed.length ?? 0) + air.length,
          landed: (battle?.landed ?? []).map((s) => ({ id: s.id, at: [s.at[0], s.at[1]], radius: s.radius })),
          next: next ? { id: next.id, at: [next.at[0], next.at[1]], landsInS: (next.landAt - now) / 1000 } : null,
        };
      },
      /** Whether the room's log is caught up on this page (together.ts caughtUp). */
      caughtUp: () => together.caughtUp,
      /** The scoops this player sent, and the others' the room relayed to this page, this visit. */
      digs: () => ({ sent: together.net?.digsSent ?? 0, heard: together.net?.digsHeard ?? 0 }),
      /**
       * The world's work still to do: craters queued or out, others' scoops held behind them, and those
       * the last match handed on to the next (Together.carriedScoops). In the lobby the session runs no
       * frame, so a match's end leaves its last craters queued until the next match's frames cut them.
       */
      pending: () => session.destruction.pending + (together.battle?.held.length ?? 0) + together.carriedScoops,
      /** The ids of the shells the last match's battle landed, as its end left it (Together.lastBattle); [] before any match has ended here. */
      lastLanded: () => (together.lastBattle?.landed ?? []).map((s) => s.id),
      /** The battle's harms this player told the room, this visit (NetClient.hurtsSent). */
      hurts: () => together.net?.hurtsSent ?? 0,
      /**
       * The battle's harm the session reckoned on this player, this visit (CombatEvents.harms), by cause
       * (a shell's blast, the front's round): how many, and how much. Reckoned wherever the body stands in
       * a match, the deploy screen's too; what was told the room of it is hurts(), and on the deploy
       * screen nothing is (Together.after), nor felt (HitFeedback.frame's `felt`).
       */
      harmed: () => ({ shell: { ...harmed.shell }, round: { ...harmed.round } }),
      /** The owner's: the match ended for everyone, as the pause menu's End match does. */
      end: () => together.endMatch(),
      /** The room's log as the last welcome gave it (NetClient.log). */
      log: () => together.net?.log ?? null,
      /** Each welcome's catch-up on this page (main.ts's catchUp hook): when it began, how long it took (null: running, or failed), and each entry done, as it said. */
      catchUps: () => catchUps,
      /** Every voxel holding a BLOOD_* id, as packed cells (world-compare.ts): per page, and masked when pages compare worlds. */
      blood: () => bloodCells(world.map),
      /** Every voxel holding one of `ids`, as packed cells (world-compare.ts): a char one page made and the other did not, masked when they compare worlds. */
      cells: (ids: readonly number[]) => cellsHolding(world.map, ids),
      /** Each 32-voxel sector's content hash (world-compare.ts): where two pages' worlds differ, when they do. */
      sectorHashes: () => sectorHashes(world.map),
    },
    /** Soldiers stood in the world without a room, for the tests and the perf gate (seat 100 on, so they never share a probe with a player's). */
    puppets(list: (Pick<Figure, 'team' | 'position' | 'yaw' | 'pitch' | 'height'> & Partial<Pick<Figure, 'velocity' | 'deadFor' | 'gear' | 'flags'>>)[]) {
      puppets = list.map((p, i) => ({ seat: 100 + i, velocity: [0, 0, 0], deadFor: null, ...p }));
    },
    soldiersDrawn: () => renderer.soldiersDrawn(),
    /**
     * The range (range.ts) allowed or not, for this visit: up or down at once once play has started
     * (the start screen left), or at the click that starts it; never in a room.
     */
    range(on: boolean) {
      rangeOn = on;
      if (!on) lowerRange();
      else if (mode !== 'loading' && mode !== 'ready') raiseRange();
    },
    /** The range as it stands: its dummies (body ids 200 on), its plates, and the readout's words (null when none shows). */
    rangeState: () => ({ ...range.state(), readout: readout.text }),
    /** A dummy's health set (1 to 100), as if just hit: a test's, so a pull starts from a known health (Range.setHealth). Never the game's. */
    rangeHp(id: number, hp: number) {
      range.setHealth(id, hp);
    },
    /**
     * The hit feedback (hit-feedback.ts): the marker showing and the words under it (null, none);
     * the voices it has made by kind, the red flashes, and the markers shown by kind (not those a
     * greater marker still showing kept from showing).
     */
    hitFeedback: () => ({ ...hitMarker.state(), ...hits.state() }),
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
    /** The sights, as the right button raises them with the pointer locked; for tests. */
    aim(held: boolean) {
      input.aim(held);
    },
    /**
     * What is in the hands: the gun's or the shovel's, how far up, how far aimed, the light; the sprint's
     * blend, the reload's phase (null, none), the rounds in the magazine, and the box the last frame drew
     * the gun in (corner and size, pixels of the internal image) and that image's size.
     */
    hands: () => {
      const g = renderer.rifleState();
      return {
        held: session.held,
        ready: session.ready,
        aimed: session.aimed,
        gun: session.arm.spec.gun.key,
        light: session.lightOn,
        model: renderer.rifleModel().dims,
        sprint: session.handling.sprint,
        reload: session.weapon.reloadPhase,
        rounds: session.weapon.rounds,
        drawn: g.visible,
        box: g.box,
        res: g.res,
      };
    },
    /** The view turned `degPerS` degrees a second while playing, as the mouse turns it, swinging as a sine of `periodS` if given; 0 stops it. */
    turn(degPerS: number, periodS = 0) {
      turning = degPerS === 0 ? null : { degPerS, periodS, since: performance.now() };
    },
    /** The next `n` frames' drawn gun as the camera sees it (null where none is drawn), each frame's time (ms) and the session's tick and share of the next. */
    gunFrames: (n: number) => new Promise((resolve) => (gunFrames = { left: Math.max(1, n), out: [], done: resolve })),
    /** Suppression's look at the session's level in every mode, the flying camera's too (a test's fixed vantage); false: only while playing and paused, as the game has it. */
    suppressionLook(always: boolean) {
      suppressionAlways = always;
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
    /** For the tracer captures: the session's tracers of the last frame on the canvas (CSS pixels, by the frame's camera) and where they are drawn (`headM`, `tailM`: metres; `struck`, a round's last streak, ending where it struck), the rifle's drawn box scaled to it, and the weapon's state. */
    tracerPixels: () => {
      const res: [number, number] = [Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight)];
      const g = renderer.rifleState();
      const k = g.res[0] > 0 ? res[0] / g.res[0] : 1;
      return {
        res,
        frame: frames,
        pose: lastPose,
        gun: g.visible ? [g.box[0] * k, g.box[1] * k, g.box[2] * k, g.box[3] * k] : null,
        weapon: { automatic: session.weapon.spec.automatic, semi: session.weapon.semi, rounds: session.weapon.rounds, magazine: session.weapon.spec.magazine, id: session.arm.spec.gun.name },
        tracers: builtDrawn.map((d) => ({ kind: d.kind, flown: d.flown, headDrawn: d.headDrawn, head: projectToPixel(lastPose, res, d.head), tail: projectToPixel(lastPose, res, d.tail), headM: d.head, tailM: d.tail, joinsM: d.joinsM, struck: d.struck })),
      };
    },
    /**
     * For the hands' captures and tests: each shot's flash of the last frame on the canvas (CSS pixels, by
     * the frame's camera; `atM`, `tipsM`: metres), its prongs' tips and the up they roll toward (the
     * drawn gun's), and the canvas (its middle the reticle, the line of sight).
     */
    flashPixels: () => {
      const res: [number, number] = [Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight)];
      return {
        res,
        frame: frames,
        pose: lastPose,
        flashes: builtFlashes.map((f) => ({ remote: f.remote, at: projectToPixel(lastPose, res, f.at), tips: f.tips.map((p) => projectToPixel(lastPose, res, p)), atM: f.at, tipsM: f.tips, up: f.up })),
      };
    },
    /** The session's particles as the last frame drew them (the shot's flash and brass held to the drawn gun): each billboard's kind, centre and half its size (metres). */
    particleBillboards: () => {
      const f = builtFrame;
      if (!f) return [];
      return Array.from({ length: effects.debugAt }, (_, i) => {
        const o = i * BILLBOARD_FLOATS;
        return { kind: f.billboards[o + 8], at: [f.billboards[o], f.billboards[o + 1], f.billboards[o + 2]] as [number, number, number], half: f.billboards[o + 3] };
      });
    },
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
    debugTracer(tracer: DebugTracer | null) {
      effects.debugTracers = tracer ? [tracer] : [];
    },
    debugEmber(ember: DebugEmber | null) {
      effects.debugEmbers = ember ? [ember] : [];
    },
    sharpAt: async (box: [number, number, number, number]) => Array.from(await renderer.readColour(box, 'sharp')),
    debugLit: async () => {
      const lit = await renderer.readEffectsLit(effects.debugAt, effects.debug.length);
      return Array.from({ length: lit.length / LIT_FLOATS }, (_, i) => Array.from(lit.subarray(i * LIT_FLOATS + 4, i * LIT_FLOATS + 8)));
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
    audio: () => ({ state: audio.state, voices: audio.voices, kinds: { ...audio.kinds }, held: audio.held, dropped: audio.dropped, time: audio.time, convolvers: audio.convolvers }),
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
      return m ? throughPose(m, session.arm.spec.muzzle) : null;
    },
    /** The loadout, and one taken (into the hands at once), for tests. */
    loadout: () => loadout,
    setLoadout: (l: unknown) => takeLoadout(cleanLoadout(l), true),
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
    bloomWeight: () => renderer.bloomWeight(),
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
    /** Frozen: frames drawn only when stepped, `hz` of them a second of the world's time (60 unless given: a faster display's, as a test asks). */
    freeze(hz = 60) {
      frozen = true;
      steps = 0;
      frozenMs = 1000 / hz;
    },
    thaw() {
      frozen = false;
    },
    stepFrames(n: number) {
      steps += n;
      return waitFrames(n);
    },
    /** Frozen: `n` frames drawn at the moment the last was, no time passing (the same frame again, its TAA's jitter aside). */
    redraw(n: number) {
      steps += n;
      still += n;
      return waitFrames(n);
    },
    /** A hit's burst, the particles' blood and sparks, left out of the frames drawn (effects-frame.ts hideBurst), or put back. */
    hideBurst(on: boolean) {
      effects.hideBurst = on;
    },
    waitConverged: () => waitFrames(render.denoise.historyMax + 8),
    stats: () => renderer.stats,
    hud: () => ({ visible: hud.visible, crosshair: hud.visible && hud.crosshair, text: hud.text }),
    snapshot: (region?: readonly number[]) =>
      new Promise<{ mean: number; std: number; saturation: number; edge: number; middle: number; region: number }>((resolve) => {
        snapshotRegion = region;
        snapshot = resolve;
      }),
    /**
     * The world's fingerprint; with `mask` (packed cells), with those voxels as air, each put back after
     * (world-compare.ts): only while the page's frames are held (freeze), as two pages' worlds are
     * compared. Unheld, a mask is refused.
     */
    fingerprint: (mask?: readonly number[]) => pageFingerprint(world.map, mask, frozen),
    setQuality: (q: Partial<Quality> & { budgetMs?: number }) => {
      renderer.setQuality(q);
      if (q.preset) {
        settings = { ...settings, preset: q.preset };
        endWarmup();
      }
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

// Without WebGPU nothing is generated: the page falls back at once. A phone or tablet (touch alone) is
// shown the game's video first, and may try it anyway (fallback.ts).
const why = fallbackReason(placeHere(window));
if (why === 'no-webgpu') fail(new GpuUnavailable('no-webgpu', 'This browser has no WebGPU.'));
else if (why === 'phone') {
  // A phone or tablet without WebGPU: no browser would make it a computer, so it is told how the game is played.
  stop(PHONE);
  if (!checkRun) fallBack('phone');
}
else if (why === 'touch' && !checkRun) fallBack('touch', () => void start().catch(fail));
else start().catch(fail);
