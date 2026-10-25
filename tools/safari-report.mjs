// The Safari report run (npm run safari): serve the dev build, which carries the report
// endpoint, open the check page in Safari, wait for its report, and judge it by the spec's
// "done" table: the click-to-play prompt within 8 s, the golden world bytes, every standard
// view at each of the clock's four keys within the 14 ms GPU budget at the high preset's
// 1.5 MP, the overview within it through the day, and every view at dusk and at night under
// peak combat on the battle's peak (the combat spec's row 6 on the battle spec's: the GPU within
// 14 ms at the 95th percentile, the main thread within 8 ms at the 99th, the battle at its peak —
// at night the most flares, a barrage and tracers, at dusk a barrage, and twelve fires; no sound,
// as the check has no click).
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'vite';

const PORT = 5340;
const RUN = 'safari';
const WAIT_MS = 10 * 60_000;
const MAIN_BUDGET_MS = 8;
const PROMPT_BUDGET_MS = 8000;
const GPU_BUDGET_MS = 14;

process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING ??= 'true';
const golden = JSON.parse(readFileSync('tests/fixtures/golden.json', 'utf8')).fingerprint;
/** A measurement's passes, by timestamps: their shares' sum (the time the GPU was busy), and the four longest by their own time. */
const passSum = (passes) => Object.values(passes ?? {}).reduce((a, b) => a + b, 0);
const longest = (own) =>
  Object.entries(own ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name, ms]) => `${name} ${ms.toFixed(2)}`)
    .join(', ');
/** An hour of the clock as HH:MM. */
const hhmm = (hours) => {
  const m = Math.round(hours * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const reportFile = `artifacts/${RUN}/report.json`;
rmSync(`artifacts/${RUN}`, { recursive: true, force: true });

const server = await (await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' })).listen();
let failed = false;
try {
  const url = `http://localhost:${PORT}/?check=${RUN}`;
  await new Promise((resolve, reject) => execFile('open', ['-a', 'Safari', url], (e) => (e ? reject(e) : resolve())));
  console.log(`Opened ${url} in Safari; waiting for its report.`);
  const started = Date.now();
  const progressFile = `artifacts/${RUN}/progress.json`;
  while (!existsSync(reportFile)) {
    if (Date.now() - started > WAIT_MS) {
      const stage = existsSync(progressFile) ? JSON.parse(readFileSync(progressFile, 'utf8')).stage : null;
      throw new Error(
        stage
          ? `Safari stalled at "${stage}" and never reported.`
          : 'Safari never started the page: is the Mac unlocked, with Safari in front, and WebGPU enabled (Safari 26 or later)?',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  // The endpoint writes the file in one call; give it a moment to land before reading.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  const check = (ok, line) => {
    console.log(`${ok ? 'pass' : 'FAIL'}  ${line}`);
    if (!ok) failed = true;
  };
  console.log(report.userAgent);
  check(report.errors.length === 0, `errors: ${report.errors.length ? report.errors.join('; ') : 'none'}`);
  if (report.errors.length === 0) {
    check(report.promptMs <= PROMPT_BUDGET_MS, `click to play at ${report.promptMs} ms (budget ${PROMPT_BUDGET_MS})`);
    check(report.fingerprint === golden, `world bytes ${report.fingerprint.slice(0, 12)}… ${report.fingerprint === golden ? 'match' : 'differ from'} Chrome's golden`);
    console.log(`GPU time by ${report.timer}${report.timer === 'submitted-work' ? ' (an overestimate: it includes submitting and completing)' : ''}; the canvas ${report.views[0]?.canvas?.join('×')}`);
    // With timestamps, each line's passes: their sum, and the longest where the line fails.
    const passes = (x, ok) => (report.timer === 'timestamps' ? ` (busy ${passSum(x.passes).toFixed(2)}${ok ? '' : `: ${longest(x.own)}`})` : '');
    for (const v of report.views) {
      const mp = (v.res[0] * v.res[1]) / 1e6;
      const ok = v.gpuMs <= GPU_BUDGET_MS && mp >= 1.48 && v.spread > 4 / 255;
      check(ok, `${v.shot.replace('.png', '').padEnd(16)} ${v.gpuMs.toFixed(2)} ms at ${v.res.join('×')} (${mp.toFixed(2)} MP), spread ${v.spread.toFixed(3)}${passes(v, ok)}`);
    }
    check(report.views.length === 24 && report.day.length === 16, `${report.views.length} views (six at four keys) and ${report.day.length} hours of the day`);
    for (const d of report.day) check(d.gpuMs <= GPU_BUDGET_MS, `overview at ${hhmm(d.hours)}  ${d.gpuMs.toFixed(2)} ms${passes(d, d.gpuMs <= GPU_BUDGET_MS)}`);
    const peak = report.peak ?? [];
    check(peak.length === 12, `${peak.length} peaks of combat (every view, at dusk and at night)`);
    for (const p of peak) {
      const by = p.gpu ? p.gpu : p.submitted;
      const gpu = by ? by.p95 : Number.NaN;
      const b = p.battle;
      const night = hhmm(p.hours) === '21:00';
      const peaked = !!b && b.barrages > 0 && b.fires === 12 && (!night || (b.flares >= 15 && b.tracers > 0));
      const ok = gpu <= GPU_BUDGET_MS && p.main.p99 <= MAIN_BUDGET_MS && p.main.max <= 20 && peaked;
      check(
        ok,
        `peak ${p.view} at ${hhmm(p.hours)}  GPU p95 ${gpu.toFixed(2)} ms, median ${by ? by.median.toFixed(2) : '?'}${p.gpu ? `, worst ${p.gpu.max.toFixed(2)}` : ' (submitted work)'}; ` +
          `main thread p99 ${p.main.p99.toFixed(1)} ms, worst ${p.main.max.toFixed(1)}; ${p.frames} frames, ${p.shots} shots, ${p.shells} shells; ` +
          (b ? `the battle ${b.at} s in: ${b.flares} flares, ${b.barrages} barrages, ${b.tracers} tracers, ${b.fires} fires` : 'not on the battle'),
      );
    }
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  failed = true;
} finally {
  await server.close();
  // The run's tab: the page has stopped drawing, but runs should not pile tabs up.
  const tab = `localhost:${PORT}/?check=${RUN}`;
  await new Promise((resolve) => execFile('osascript', ['-e', `tell application "Safari" to close (every tab of every window whose URL contains "${tab}")`], () => resolve()));
}
process.exitCode = failed ? 1 : 0;
