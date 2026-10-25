import { CLOCK_KEYS, clockText } from '../../src/core/sky-clock';
import { describe, expect, it } from 'vitest';
import { CHECK_KEYS, CHECK_PEAK, DAY_HOURS, PEAK_S, runCheck, type CheckGame, type CheckReport } from '../../src/app/check';
import { VIEW_NAMES } from '../../src/app/views';
import type { RenderStats } from '../../src/render/renderer';

/** A game for the check; `seen` gathers where it is sent, a view and then its hour. */
function game(over: Partial<CheckGame> = {}, seen: string[] = []): CheckGame {
  const stats = { gpuMs: 9.5, res: [1549, 968], canvas: [1600, 1000], passes: { primary: 4.5, lighting: 1.5 }, own: { primary: 4.6, lighting: 1.5 } } as unknown as RenderStats;
  return {
    timestamps: true,
    promptMs: 3500,
    timings: { fill: 1500 },
    setQuality: () => {},
    view: (name) => void seen.push(name),
    setTimeOfDay: (hours) => void seen.push(clockText(hours)),
    waitFrames: async () => {},
    waitConverged: async () => {},
    stats: () => stats,
    fingerprint: async () => 'abc',
    shot: async () => ({ png: new Blob(['png']), spread: 0.2 }),
    submittedWork: async (count) => Array.from({ length: count }, (_, i) => (i % 3 === 0 ? 30 : 11)),
    gpuErrors: () => [],
    underFire: async (view, hours, seconds) => {
      seen.push(`under fire ${view} ${clockText(hours)} ${seconds} s`);
      return { view, hours, frames: 360, gpu: { p95: 12, median: 11, max: 13 }, submitted: null, main: { p99: 5, max: 8 }, shots: 66, shells: 6, skipped: 0, voices: 0, drift: 0, battle: null };
    },
    ...over,
  };
}

/** The run's report, and the files it posted besides its progress. */
async function run(g: CheckGame): Promise<{ report: CheckReport; posted: string[] }> {
  const posted: string[] = [];
  const report = await runCheck('t', g, async (file) => void (file !== 'progress.json' && posted.push(file)));
  return { report, posted };
}

describe('the check', () => {
  it('reports every view at each of the four keys, its shot and the GPU time the timestamps give', async () => {
    const { report, posted } = await run(game());
    expect(report.timer).toBe('timestamps');
    expect(report.views.map((v) => v.shot)).toEqual(VIEW_NAMES.flatMap((n) => CHECK_KEYS.map((k) => `${n}-${k}.png`)));
    expect(report.views.map((v) => v.hours)).toEqual(VIEW_NAMES.flatMap(() => CHECK_KEYS.map((k) => CLOCK_KEYS[k])));
    expect(report.views.every((v) => v.gpuMs === 9.5)).toBe(true);
    expect(posted).toEqual([...report.views.map((v) => v.shot), 'report.json']);
  });
  it('reports the overview through the day: every second hour, and round sunrise and sunset', async () => {
    const { report } = await run(game());
    expect(report.day.map((d) => clockText(d.hours))).toEqual([
      '00:00', '02:00', '04:00', '06:00', '08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '22:00', '06:40', '07:10', '17:50', '17:55',
    ]);
    expect(report.day.every((d) => d.gpuMs === 9.5)).toBe(true);
  });
  it('reports every view under peak combat, at dusk and at night, after the day', async () => {
    const seen: string[] = [];
    const { report } = await run(game({}, seen));
    expect(report.peak.map((p) => `${p.view} ${clockText(p.hours)}`)).toEqual(CHECK_PEAK.map(([v, k]) => `${v} ${clockText(CLOCK_KEYS[k])}`));
    expect(CHECK_PEAK.length).toBe(VIEW_NAMES.length * 2);
    expect(seen.slice(-CHECK_PEAK.length)).toEqual(CHECK_PEAK.map(([v, k]) => `under fire ${v} ${clockText(CLOCK_KEYS[k])} ${PEAK_S} s`));
  });
  it("carries each view's and hour's passes, with timestamps, and the canvas each view was drawn to", async () => {
    const { report } = await run(game());
    for (const x of [...report.views, ...report.day]) {
      expect(x.passes).toEqual({ primary: 4.5, lighting: 1.5 });
      expect(x.own).toEqual({ primary: 4.6, lighting: 1.5 });
    }
    expect(report.views.every((v) => v.canvas[0] === 1600 && v.canvas[1] === 1000)).toBe(true);
    const { report: untimed } = await run(game({ timestamps: false }));
    for (const x of [...untimed.views, ...untimed.day]) expect([x.passes, x.own]).toEqual([{}, {}]);
  });
  it('sends the game to each view and then sets its hour, the view setting its own first', async () => {
    const seen: string[] = [];
    await run(game({}, seen));
    const pairs = [...VIEW_NAMES.flatMap((n) => CHECK_KEYS.map((k) => [n, clockText(CLOCK_KEYS[k])])), ...DAY_HOURS.map((h) => ['overview', clockText(h)])];
    // Then the peak, which places its own views (peak-combat.ts).
    expect(seen).toEqual([...pairs.flat(), ...CHECK_PEAK.map(([v, k]) => `under fire ${v} ${clockText(CLOCK_KEYS[k])} ${PEAK_S} s`)]);
  });
  it('without timestamps, times each view and hour by the median of its submitted work', async () => {
    const { report } = await run(game({ timestamps: false }));
    expect(report.timer).toBe('submitted-work');
    // A third of the samples are 30 ms stalls; the median is the 11 ms the work takes.
    expect(report.views.every((v) => v.gpuMs === 11)).toBe(true);
    expect(report.day.every((d) => d.gpuMs === 11)).toBe(true);
  });
  it("reports the GPU's uncaptured errors as errors, so a format a browser refuses is not measured as a pass", async () => {
    const { report } = await run(game({ gpuErrors: () => ["Texture format 'rg11b10ufloat' is not supported for storage"] }));
    expect(report.errors).toEqual(["GPU: Texture format 'rg11b10ufloat' is not supported for storage"]);
    expect(report.views.length).toBeGreaterThan(0);
  });
  it('still reports, with the error, when a step fails', async () => {
    const { report, posted } = await run(game({ fingerprint: async () => Promise.reject(new Error('crypto.subtle is unavailable')) }));
    expect(report.errors).toEqual(['crypto.subtle is unavailable']);
    expect(posted).toEqual(['report.json']);
  });
});

describe('the check, as it runs', () => {
  it('reports its progress view by view, so a stalled run says where it stopped', async () => {
    const posted: string[] = [];
    await runCheck('t', game(), async (file, body) => void posted.push(file === 'progress.json' ? `progress:${JSON.parse(body as string).stage}` : file));
    const progress = posted.filter((p) => p.startsWith('progress:'));
    expect(progress).toEqual([
      'progress:fingerprint',
      ...VIEW_NAMES.flatMap((n) => CHECK_KEYS.map((k) => `progress:view ${n} at ${k}`)),
      ...DAY_HOURS.map((h) => `progress:the overview at ${clockText(h)}`),
      ...CHECK_PEAK.map(([v, k]) => `progress:peak combat at ${v} at ${k}`),
      'progress:done',
    ]);
  });
});
