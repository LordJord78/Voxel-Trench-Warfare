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
  views: { name: string; hours: number; gpuMs: number; res: [number, number]; shot: string; spread: number }[];
  day: { hours: number; gpuMs: number }[];
  errors: string[];
}

const VIEWS = ['bay', 'step', 'nml-night', 'overview', 'dugout', 'hamlet'];
const KEYS = ['dusk', 'night', 'noon', 'dawn'];
// The overview through the day: every second hour, and round sunrise and sunset, the sun 0–2° up.
const DAY = ['00:00', '02:00', '04:00', '06:00', '08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '22:00', '06:40', '07:10', '17:50', '17:55'];
// The check's wait for its report: 24 views and 16 hours, each settled and measured.
const REPORT_MS = 400_000;

/** An hour of the clock as HH:MM. */
function hhmm(hours: number): string {
  const m = Math.round(hours * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

test('the check reports the world, its timings, every view at the four keys and the overview through the day', async ({ page }) => {
  test.setTimeout(REPORT_MS + 30_000);
  rmSync('artifacts/chrome-e2e', { recursive: true, force: true });
  await page.goto('/?check=chrome-e2e');
  await page.waitForFunction(() => (window as unknown as { __trenchline?: { checkReport?: unknown } }).__trenchline?.checkReport !== undefined, null, { timeout: REPORT_MS });
  const report = JSON.parse(readFileSync('artifacts/chrome-e2e/report.json', 'utf8')) as Report;
  expect(report.errors).toEqual([]);
  const golden = JSON.parse(readFileSync('tests/fixtures/golden.json', 'utf8')) as { fingerprint: string };
  expect(report.fingerprint).toBe(golden.fingerprint);
  expect(report.timer).toBe('timestamps');
  expect(report.promptMs).toBeGreaterThan(0);
  expect(report.views.map((v) => v.shot)).toEqual(VIEWS.flatMap((name) => KEYS.map((key) => `${name}-${key}.png`)));
  expect(report.day.map((d) => hhmm(d.hours))).toEqual(DAY);
  for (const d of report.day) expect(d.gpuMs, hhmm(d.hours)).toBeGreaterThan(0);
  for (const v of report.views) {
    expect(v.gpuMs, v.name).toBeGreaterThan(0);
    expect(v.res[0] * v.res[1], v.name).toBeGreaterThan(1.48e6);
    expect(v.spread, v.name).toBeGreaterThan(4 / 255);
    const shot = `artifacts/chrome-e2e/${v.shot}`;
    expect(existsSync(shot), shot).toBe(true);
    expect(statSync(shot).size, shot).toBeGreaterThan(10_000);
  }
});

test('without timestamps, the check times every view and hour by its submitted work', async ({ page }) => {
  test.setTimeout(REPORT_MS + 30_000);
  rmSync('artifacts/chrome-submitted', { recursive: true, force: true });
  await page.goto('/?check=chrome-submitted&timer=submitted-work');
  await page.waitForFunction(() => (window as unknown as { __trenchline?: { checkReport?: unknown } }).__trenchline?.checkReport !== undefined, null, { timeout: REPORT_MS });
  const report = JSON.parse(readFileSync('artifacts/chrome-submitted/report.json', 'utf8')) as Report;
  console.log(`submitted-work ms: ${JSON.stringify(report.views.map((v) => [v.shot, +v.gpuMs.toFixed(2)]))}; the day: ${JSON.stringify(report.day.map((d) => [hhmm(d.hours), +d.gpuMs.toFixed(2)]))}`);
  expect(report.errors).toEqual([]);
  expect(report.timer).toBe('submitted-work');
  expect(report.views.length).toBe(VIEWS.length * KEYS.length);
  expect(report.day.length).toBe(DAY.length);
  for (const v of [...report.views.map((x) => ({ at: x.shot, gpuMs: x.gpuMs })), ...report.day.map((x) => ({ at: hhmm(x.hours), gpuMs: x.gpuMs }))]) {
    expect(v.gpuMs, v.at).toBeGreaterThan(1);
    expect(v.gpuMs, v.at).toBeLessThan(50);
  }
});
