import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { hooks } from './support/app';
import { servedBuild } from './support/build';

// The production build as a static host serves it (the showcase spec's row 1): under a sub-path, as
// GitHub Pages serves a project, its scripts, its workers and the world they generate are found.
const BASE = '/Voxel-Trench-Warfare/';

test('the production build, served under /Voxel-Trench-Warfare/, generates the world in its workers and plays', async ({ page }) => {
  test.setTimeout(240_000);
  const site = await servedBuild(BASE, 5331);
  try {
    // Nothing asked for at the host's root, where a project's site is not.
    expect(readFileSync(`${site.outDir}/index.html`, 'utf8').match(/(?:src|href)="\/[^"]*"/g) ?? []).toEqual([]);
    const errors: string[] = [];
    page.on('console', (m) => {
      // The destruction worker's fallback to cutting craters in-process says so only as a warning.
      if (m.type() === 'error' || (m.type() === 'warning' && m.text().startsWith('[destruction]'))) errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(e.message));
    // Everything the site asks for is there: its scripts, both workers, the still.
    const missing: string[] = [];
    page.on('response', (r) => {
      if (r.status() >= 400) missing.push(`${r.status()} ${r.url()}`);
    });
    page.on('requestfailed', (r) => missing.push(`failed ${r.url()}`));
    await page.goto(site.url);
    await page.waitForFunction(() => (window as unknown as { __trenchline?: { ready?: boolean } }).__trenchline?.ready === true, null, { timeout: 90_000 });
    const state = await hooks(page, (h) => ({ error: h.error, promptMs: (h as unknown as { promptMs: number }).promptMs }));
    expect(state.error).toBeUndefined();
    expect(state.promptMs).toBeGreaterThan(0);
    await page.locator('#play').click();
    await expect(page.locator('#loading')).toBeHidden();
    const drawn = await hooks(page, async (h) => {
      const from = h.frames();
      await h.waitFrames(60);
      return h.frames() - from;
    });
    expect(drawn).toBeGreaterThanOrEqual(60);
    expect(missing).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await site.close();
  }
});
