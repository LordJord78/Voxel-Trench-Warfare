/** Node side of the app tests: load the game and wait for its first frame. */
import type { Page } from '@playwright/test';

export interface Hooks {
  ready: boolean;
  error?: string;
  ms: number;
  view(name: string): void;
  /** The clock, in hours. */
  setTimeOfDay(t: number): void;
  timeOfDay(): number;
  /** The exposure the last frame was presented at. */
  exposure(): Promise<number>;
  /** The exposure's adaptation after the last frame: the base reckoned from the light, the correction and its want, the metered mean (stops). */
  exposureState(): Promise<{ base: number; correction: number; want: number; metered: number }>;
  /** The point lights the last frame was lit with. */
  lights(): { position: [number, number, number]; radius: number; colour: [number, number, number]; intensity: number; kind: 'lantern' | 'flare'; phase: number }[];
  /** Hold the lights still: as the plan placed them (their motion is new since the approved views), or as they are `seconds` into their motion. */
  holdLights(seconds?: number): void;
  /** Light the scene with these lights in place of its own (they move from their phases as its own do). */
  useLights(lights: { position: [number, number, number]; radius: number; colour: [number, number, number]; intensity: number; kind: 'lantern' | 'flare'; phase: number }[]): void;
  /** Let the lights move with their own clock again. */
  runLights(): void;
  /** The sun's elevation the last frame was lit at, in degrees. */
  sunElevation(): number;
  frames(): number;
  waitFrames(n: number): Promise<void>;
  /** Draw frames only when stepped (`stepFrames`), so what a test reads back stays put; `thaw` to run freely again. */
  freeze(): void;
  thaw(): void;
  stepFrames(n: number): Promise<void>;
  stats(): {
    gpuMs: number | null;
    /** The latest measured frame's GPU time, unsmoothed, and how many frames have been measured. */
    gpuLastMs: number | null;
    gpuSamples: number;
    passes: Record<string, number>;
    own: Record<string, number>;
    res: [number, number];
    alloc: [number, number];
    canvas: [number, number];
    scale: number;
    preset: 'high' | 'low';
    dynres: boolean;
    reset: boolean;
    frame: number;
  };
  snapshot(): Promise<{ mean: number; std: number; saturation: number; edge: number; middle: number }>;
  setQuality(q: { preset?: 'high' | 'low'; dynres?: boolean; scale?: number; budgetMs?: number }): void;
  loseDevice(): void;
  simulateGap(ms: number): void;
  play(): void;
  walk(): void;
  flyTo(pose: { position: [number, number, number]; yaw: number; pitch: number }): void;
  teleport(at: { position: [number, number, number]; yaw: number; pitch: number }): void;
  player(): { position: [number, number, number]; velocity: [number, number, number]; stance: number; height: number; onGround: boolean; onFiringStep: boolean; wadeDepth: number };
  camera(): { position: [number, number, number]; yaw: number; pitch: number; fov?: number };
  mode(): 'loading' | 'ready' | 'playing' | 'paused' | 'fly';
  waitConverged(): Promise<void>;
  promptMs?: number;
  phases: string[];
  views: Record<string, { position: [number, number, number]; yaw: number; pitch: number; hours: number }>;
  world: {
    spawn: { position: [number, number, number]; bay: { longAxis: 0 | 2; facing: 1 | -1 } };
    map: { get(x: number, y: number, z: number): number; set(x: number, y: number, z: number, p: number): void; fillBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, p: number): void };
  };
  /** The trigger, as the left mouse button sets it with the pointer locked; for tests that play without the lock. */
  trigger(held: boolean): void;
  session: {
    weapon: { rounds: number };
    suppression: { level: number };
    front: { intensity: 'off' | 'light' | 'heavy' };
    entrenching: { cleared: number; inReach: boolean };
    digging: boolean;
    player: { position: { x: number; y: number; z: number }; yaw: number };
  };
  /** The HUD as drawn: whether it shows, whether its crosshair does, and its words. */
  hud(): { visible: boolean; crosshair: boolean; text: string };
  /** The front's shells alone, for a test: the rifle fire is left as it is. */
  setShelling(i: 'off' | 'light' | 'heavy'): void;
  /** The front's fire, for this visit (the pause menu's choice is what is kept). */
  setIntensity(i: 'off' | 'light' | 'heavy'): void;
  /** What the last frame's effects held: particles' billboards, tracers, flash stars, transient lights. */
  effects(): { billboards: number; tracers: number; stars: number; lights: number };
  /** Test quads (metres, metres across, linear colour) drawn with the effects from the next frame, emissive or `lit` as dust is; [] for none. */
  debugQuads(quads: { position: [number, number, number]; size: number; colour: [number, number, number]; lit?: boolean; square?: boolean }[]): void;
  /** Emissive test ribbons (metres; metres across; linear colour), as tracers are drawn, from the next frame; [] for none. */
  debugRibbons(ribbons: { tail: [number, number, number]; head: [number, number, number]; width: number; colour: [number, number, number] }[]): void;
  /** The key light's map texels the last frame traced (all of them, a sixteenth, or none), the map's texels, and the slots it is traced in by turns. */
  keyTexels(): { traced: number; all: number; slots: number };
  /** Puffs of smoke in the haze (metres; density per metre), added to the next frames' own; [] for none. */
  debugSmoke(puffs: { centre: number[]; radiusM: number; density: number }[]): void;
  /** Shells' blast lights, added to the next frames' own (as a blast's, shadowed, outside the denoiser); [] for none. */
  debugBlasts(lights: { position: number[]; radiusM: number; colour: number[]; intensity: number }[]): void;
  /** The last frame's sharpened image, the effects drawn over it, over a box of the internal image: linear rgb, a row at a time. */
  sharpAt(box: [number, number, number, number]): Promise<number[]>;
  /** The last frame's test quads as the effects lit them: linear rgb premultiplied, and alpha. */
  debugLit(): Promise<[number, number, number, number][]>;
  /** Transient lights (as a shot's flash) added to the next frames' own; [] for none. */
  debugLights(lights: { position: [number, number, number]; radiusM: number; colour: [number, number, number]; intensity: number }[]): void;
  /** The last frame's shaded image (before TAA and the effects) over a box of the internal image: its mean linear rgb. */
  colourAt(box: [number, number, number, number]): Promise<[number, number, number]>;
  /** The G-buffer's depth at pixels of the internal image, in metres along each pixel's ray. */
  depthAt(points: [number, number][]): Promise<number[]>;
  /** GPU validation errors so far. */
  gpuErrors(): string[];
  /** The frame's sub-pixel jitter on (the game's) or off (so a pixel's ray is its centre's). */
  jitter(on: boolean): void;
  /** Whether the last frame drew the rifle. */
  rifleVisible(): boolean;
  /** Hold the rifle (the game's) or put it down, for a test reading the world behind it. */
  showRifle(on: boolean): void;
  /** The rifle's muzzle as the last frame drew it, in metres. */
  rifleMuzzle(): [number, number, number];
  /**
   * The last frame's rifle: whether it was drawn, and `n` × `n` pixels across its screen box, each
   * with the G-buffer's depth there and the CPU's trace of the model along the pixel's ray (null
   * where it misses), in metres.
   */
  rifleCheck(n: number): Promise<{ visible: boolean; samples: { px: [number, number]; gpu: number; cpu: number | null }[] }>;
  /** The mean luminance (linear) of the rifle's pixels in the last frame's shaded image. */
  rifleLuminance(): Promise<number>;
  /**
   * A shell landing at `at` (metres; its y is ignored, the ground's top is used) of `radiusM`: it
   * resolves once its crater has settled in the world, with the times from the drop until its cut
   * was in (`cutMs`) and until it settled (`ms`), and the bricks its settling wrote.
   */
  shell(at: [number, number, number], radiusM: number): Promise<{ ms: number; bricks: number; cutMs: number }>;
  /** As shell, and once it settles, whether the world's bricks over its region are what an in-process detonate on a copy taken at the drop cuts. */
  shellCheck(at: [number, number, number], radiusM: number): Promise<{ ms: number; bricks: number; cutMs: number; equal: boolean }>;
  /** Craters landed. */
  craters(): number;
  /** Each of the last 600 frames' main-thread time, ms, from the frame's start to its render's return. */
  mainMs(): number[];
  /** The sound: its context's state ('none' before the click that starts play) and how many voices have started. */
  audio(): { state: 'none' | 'suspended' | 'running' | 'closed'; voices: number };
}

export async function openGame(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { __trenchline?: Hooks }).__trenchline?.ready === true, null, { timeout: 90_000 });
  // The views were approved, and their looks are measured, with the lights still: from the next
  // frame. (A game that stopped before it had a world has no lights to hold.)
  await hooks(page, async (h) => {
    if (h.error !== undefined) return;
    h.holdLights();
    // The front holds its fire unless a test asks for it (a visitor's default is light).
    h.setIntensity('off');
    await h.waitFrames(1);
  });
  return errors;
}

export function hooks<T>(page: Page, fn: (h: Hooks, arg: unknown) => T | Promise<T>, arg?: unknown): Promise<T> {
  return page.evaluate(
    ([source, a]) => {
      const h = (window as unknown as { __trenchline: Hooks }).__trenchline;
      return new Function('h', 'arg', `return (${source})(h, arg)`)(h, a);
    },
    [fn.toString(), arg] as const,
  ) as Promise<T>;
}
