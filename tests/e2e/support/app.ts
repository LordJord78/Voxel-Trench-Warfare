/** Node side of the app tests: load the game and wait for its first frame. */
import type { Page } from '@playwright/test';

export interface Hooks {
  ready: boolean;
  error?: string;
  ms: number;
  view(name: string): void;
  setTimeOfDay(t: number): void;
  frames(): number;
  waitFrames(n: number): Promise<void>;
  stats(): { gpuMs: number | null; passes: Record<string, number>; res: [number, number]; frame: number };
  snapshot(): Promise<{ mean: number; std: number }>;
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
