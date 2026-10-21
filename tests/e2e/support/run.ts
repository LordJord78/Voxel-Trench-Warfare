/** Node side of the GPU harness: open the harness page and call its cases. */
import type { Page } from '@playwright/test';

export async function openHarness(page: Page): Promise<void> {
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[page] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));
  await page.goto('/tests/e2e/harness.html');
  await page.waitForFunction(() => 'harness' in window, null, { timeout: 30_000 });
}

export function runCase<T>(page: Page, name: string, args?: unknown): Promise<T> {
  return page.evaluate(
    ([n, a]) => (window as unknown as { harness: Record<string, (x: unknown) => Promise<unknown>> }).harness[n as string](a),
    [name, args] as const,
  ) as Promise<T>;
}
