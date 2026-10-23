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
  snapshot(): Promise<{ mean: number; std: number }>;
  setQuality(q: { preset?: 'high' | 'low'; dynres?: boolean; scale?: number; budgetMs?: number }): void;
  loseDevice(): void;
  simulateGap(ms: number): void;
  play(): void;
  walk(): void;
  teleport(at: { position: [number, number, number]; yaw: number; pitch: number }): void;
  player(): { position: [number, number, number]; velocity: [number, number, number]; stance: number; height: number; onGround: boolean; onFiringStep: boolean; wadeDepth: number };
  camera(): { position: [number, number, number]; yaw: number; pitch: number; fov?: number };
  mode(): 'loading' | 'ready' | 'playing' | 'paused' | 'fly';
  waitConverged(): Promise<void>;
  promptMs?: number;
  phases: string[];
  views: Record<string, { position: [number, number, number]; yaw: number; pitch: number; hours: number }>;
  world: { spawn: { position: [number, number, number] } };
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
