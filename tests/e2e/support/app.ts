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
  /** The sun's elevation the last frame was lit at, in degrees. */
  sunElevation(): number;
  frames(): number;
  waitFrames(n: number): Promise<void>;
  stats(): {
    gpuMs: number | null;
    passes: Record<string, number>;
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
