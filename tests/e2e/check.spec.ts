import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// The same check Safari runs (npm run safari), here in Chrome: a 1.6 MP canvas, so the
// internal image is the high preset's 1.5 MP.
test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });

interface Report {
  run: string;
  timer: 'timestamps' | 'submitted-work';
  promptMs: number;
  fingerprint: string;
  views: { name: string; time: number; gpuMs: number; res: [number, number]; shot: string; spread: number }[];
  errors: string[];
}

test('the check reports the world, its timings and every view', async ({ page }) => {
  rmSync('artifacts/chrome-e2e', { recursive: true, force: true });
  await page.goto('/?check=chrome-e2e');
  await page.waitForFunction(() => (window as unknown as { __trenchline?: { checkReport?: unknown } }).__trenchline?.checkReport !== undefined, null, { timeout: 170_000 });
  const report = JSON.parse(readFileSync('artifacts/chrome-e2e/report.json', 'utf8')) as Report;
  expect(report.errors).toEqual([]);
  const golden = JSON.parse(readFileSync('tests/fixtures/golden.json', 'utf8')) as { fingerprint: string };
  expect(report.fingerprint).toBe(golden.fingerprint);
  expect(report.timer).toBe('timestamps');
  expect(report.promptMs).toBeGreaterThan(0);
  expect(report.views.map((v) => v.name)).toEqual(['bay', 'step', 'nml-night', 'overview', 'dugout', 'hamlet']);
  for (const v of report.views) {
    expect(v.gpuMs, v.name).toBeGreaterThan(0);
    expect(v.res[0] * v.res[1], v.name).toBeGreaterThan(1.48e6);
    expect(v.spread, v.name).toBeGreaterThan(4 / 255);
    const shot = `artifacts/chrome-e2e/${v.shot}`;
    expect(existsSync(shot), shot).toBe(true);
    expect(statSync(shot).size, shot).toBeGreaterThan(10_000);
  }
});

test('without timestamps, the check times every view by its submitted work', async ({ page }) => {
  rmSync('artifacts/chrome-submitted', { recursive: true, force: true });
  await page.goto('/?check=chrome-submitted&timer=submitted-work');
  await page.waitForFunction(() => (window as unknown as { __trenchline?: { checkReport?: unknown } }).__trenchline?.checkReport !== undefined, null, { timeout: 170_000 });
  const report = JSON.parse(readFileSync('artifacts/chrome-submitted/report.json', 'utf8')) as Report;
  console.log(`submitted-work ms: ${JSON.stringify(report.views.map((v) => [v.name, +v.gpuMs.toFixed(2)]))}`);
  expect(report.errors).toEqual([]);
  expect(report.timer).toBe('submitted-work');
  for (const v of report.views) {
    expect(v.gpuMs, v.name).toBeGreaterThan(1);
    expect(v.gpuMs, v.name).toBeLessThan(50);
  }
});
