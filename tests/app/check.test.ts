import { describe, expect, it } from 'vitest';
import { runCheck, type CheckGame, type CheckReport } from '../../src/app/check';
import { VIEW_NAMES } from '../../src/app/views';
import type { RenderStats } from '../../src/render/renderer';

function game(over: Partial<CheckGame> = {}): CheckGame {
  const stats = { gpuMs: 9.5, res: [1549, 968] } as unknown as RenderStats;
  return {
    timestamps: true,
    promptMs: 3500,
    timings: { fill: 1500 },
    setQuality: () => {},
    view: () => {},
    viewTime: (name) => (name === 'nml-night' ? 1 : 0),
    waitFrames: async () => {},
    waitConverged: async () => {},
    stats: () => stats,
    fingerprint: async () => 'abc',
    shot: async () => ({ png: new Blob(['png']), spread: 0.2 }),
    submittedWork: async (count) => Array.from({ length: count }, (_, i) => (i % 3 === 0 ? 30 : 11)),
    ...over,
  };
}

async function run(g: CheckGame): Promise<{ report: CheckReport; posted: string[] }> {
  const posted: string[] = [];
  const report = await runCheck('t', g, async (file) => void posted.push(file));
  return { report, posted };
}

describe('the check', () => {
  it('reports every view, its shot and the GPU time the timestamps give', async () => {
    const { report, posted } = await run(game());
    expect(report.timer).toBe('timestamps');
    expect(report.views.map((v) => v.name)).toEqual([...VIEW_NAMES]);
    expect(report.views.map((v) => v.gpuMs)).toEqual(VIEW_NAMES.map(() => 9.5));
    expect(report.views.find((v) => v.name === 'nml-night')!.shot).toBe('nml-night-night.png');
    expect(posted).toEqual([...report.views.map((v) => v.shot), 'report.json']);
  });
  it('without timestamps, times each view by the median of its submitted work', async () => {
    const { report } = await run(game({ timestamps: false }));
    expect(report.timer).toBe('submitted-work');
    // A third of the samples are 30 ms stalls; the median is the 11 ms the work takes.
    expect(report.views.every((v) => v.gpuMs === 11)).toBe(true);
  });
  it('still reports, with the error, when a step fails', async () => {
    const { report, posted } = await run(game({ fingerprint: async () => Promise.reject(new Error('crypto.subtle is unavailable')) }));
    expect(report.errors).toEqual(['crypto.subtle is unavailable']);
    expect(posted).toEqual(['report.json']);
  });
});
