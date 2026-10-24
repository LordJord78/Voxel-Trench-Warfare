import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// The same check Safari runs (npm run safari), here in Chrome: a 1.6 MP canvas, so the
// internal image is the high preset's 1.5 MP.
test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });

interface Report {
  run: string;
  timer: 'timestamps' | 'submitted-work';
  promptMs: number;
  timings: Record<string, number>;
  fingerprint: string;
  views: { name: string; hours: number; gpuMs: number; res: [number, number]; canvas: [number, number]; shot: string; spread: number }[];
  day: { hours: number; gpuMs: number }[];
  peak: {
    view: string;
    hours: number;
    frames: number;
    gpu: { p95: number; median: number; max: number } | null;
    submitted: { p95: number; median: number } | null;
    main: { p99: number; max: number };
    shots: number;
    shells: number;
    voices: number;
  }[];
  errors: string[];
}

const VIEWS = ['bay', 'step', 'nml-night', 'overview', 'dugout', 'hamlet'];
const KEYS = ['dusk', 'night', 'noon', 'dawn'];
// The overview through the day: every second hour, and round sunrise and sunset, the sun 0–2° up.
const DAY = ['00:00', '02:00', '04:00', '06:00', '08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '22:00', '06:40', '07:10', '17:50', '17:55'];
// The peak combat the check measures (src/app/peak-combat.ts): the overview and the bay, at dusk and at night.
const PEAK = ['overview dusk', 'overview night', 'bay dusk', 'bay night'];
// The check's wait for its report: 24 views and 16 hours, each settled and measured, and four peaks.
const REPORT_MS = 460_000;

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
  // Reported, the page draws no more frames: a browser left open on it does not hold the GPU.
  const frames = () => page.evaluate(() => (window as unknown as { __trenchline: { frames(): number } }).__trenchline.frames());
  const done = await frames();
  await page.waitForTimeout(500);
  expect(await frames()).toBe(done);
  const golden = JSON.parse(readFileSync('tests/fixtures/golden.json', 'utf8')) as { fingerprint: string };
  expect(report.fingerprint).toBe(golden.fingerprint);
  expect(report.timer).toBe('timestamps');
  expect(report.promptMs).toBeGreaterThan(0);
  // The load's phases, the pipelines' compile among them.
  for (const phase of ['fill', 'farField', 'compile']) expect(report.timings[phase], phase).toBeGreaterThan(0);
  expect(report.views.map((v) => v.shot)).toEqual(VIEWS.flatMap((name) => KEYS.map((key) => `${name}-${key}.png`)));
  expect(report.day.map((d) => hhmm(d.hours))).toEqual(DAY);
  for (const d of report.day) expect(d.gpuMs, hhmm(d.hours)).toBeGreaterThan(0);
  // Peak combat, by timestamps, inside the budgets; the check has no click, so no sound.
  expect(report.peak.map((p) => `${p.view} ${hhmm(p.hours) === '21:00' ? 'night' : 'dusk'}`)).toEqual(PEAK);
  for (const p of report.peak) {
    const at = JSON.stringify(p);
    expect(p.submitted, at).toBeNull();
    expect(p.gpu!.p95, at).toBeLessThanOrEqual(14);
    expect(p.main.p99, at).toBeLessThanOrEqual(8);
    expect(p.main.max, at).toBeLessThanOrEqual(20);
    expect(p.shots, at).toBeGreaterThan(50);
    expect(p.shells, at).toBeGreaterThanOrEqual(5);
    expect(p.voices, at).toBe(0);
  }
  for (const v of report.views) {
    expect(v.gpuMs, v.name).toBeGreaterThan(0);
    expect(v.res[0] * v.res[1], v.name).toBeGreaterThan(1.48e6);
    expect(v.spread, v.name).toBeGreaterThan(4 / 255);
    const shot = `artifacts/chrome-e2e/${v.shot}`;
    expect(existsSync(shot), shot).toBe(true);
    expect(statSync(shot).size, shot).toBeGreaterThan(10_000);
  }
});

// In a window of another shape, as Safari's may be: the check's canvas is still 1600 × 1000, so its
// views are framed and presented as here.
test.describe('in a window of another shape', () => {
  test.use({ viewport: { width: 1200, height: 900 } });
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
    for (const v of report.views) {
      expect(v.canvas, v.shot).toEqual([1600, 1000]);
      expect(v.res, v.shot).toEqual([1549, 968]);
    }
    // Its peak too, timed by submitted work.
    expect(report.peak.length).toBe(PEAK.length);
    for (const p of report.peak) {
      expect(p.gpu, p.view).toBeNull();
      expect(p.submitted!.p95, p.view).toBeGreaterThan(1);
      expect(p.submitted!.p95, p.view).toBeLessThan(50);
    }
  });
});
