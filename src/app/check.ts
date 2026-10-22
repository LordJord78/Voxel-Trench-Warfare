/**
 * The check (`?check=<run>`): once the game is ready, measure and photograph
 * the six standard views, each at its own time of day, at the high preset's
 * full resolution with dynamic resolution off, and post a report and the PNGs
 * to the dev server (tools/vite-plugin-report.ts). Chrome runs it in the e2e
 * suite and Safari through `npm run safari`; whoever reads the report judges
 * it, against the golden fingerprint among other things.
 *
 * GPU time comes from timestamp queries where the browser has them, and
 * otherwise from how long each frame's submitted work takes to finish.
 */

import { CLOCK_KEYS, clockText } from '../core/sky-clock';
import type { RenderStats } from '../render/renderer';
import { VIEW_NAMES, type ViewName } from './views';

export interface CheckGame {
  timestamps: boolean;
  promptMs: number;
  timings: Record<string, number>;
  setQuality(q: { preset: 'high'; dynres: false }): void;
  view(name: ViewName): void;
  /** The clock's hour a view is seen at. */
  viewHours(name: ViewName): number;
  waitFrames(n: number): Promise<void>;
  waitConverged(): Promise<void>;
  stats(): RenderStats;
  fingerprint(): Promise<string>;
  /** The next frame's canvas, copied in the frame that drew it: PNG bytes, and its luminance spread. */
  shot(): Promise<{ png: Blob; spread: number }>;
  /** Milliseconds from each of the next `count` frames' submit to its work finishing. */
  submittedWork(count: number): Promise<number[]>;
}

export interface CheckView {
  name: ViewName;
  hours: number;
  gpuMs: number;
  res: [number, number];
  shot: string;
  spread: number;
}

export interface CheckReport {
  run: string;
  userAgent: string;
  timer: 'timestamps' | 'submitted-work';
  promptMs: number;
  timings: Record<string, number>;
  fingerprint: string;
  views: CheckView[];
  errors: string[];
}

export type Post = (file: string, body: Blob | string) => Promise<void>;

/** A shot's name for an hour: the clock key it is (dusk, night, dawn, noon), or its time, as 1840. */
export function clockName(hours: number): string {
  const key = (Object.entries(CLOCK_KEYS) as [string, number][]).find(([, h]) => Math.abs(h - hours) < 1e-9);
  return key ? key[0] : clockText(hours).replace(':', '');
}

/** Post to the dev server's report endpoint for `run`. */
export function reporter(run: string): Post {
  return async (file, body) => {
    const response = await fetch(`/__report/${run}/${file}`, { method: 'POST', body });
    if (!response.ok) throw new Error(`the report endpoint refused ${file}: ${response.status}`);
  };
}

function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length ? sorted[sorted.length >> 1] : 0;
}

export async function runCheck(run: string, game: CheckGame, post: Post): Promise<CheckReport> {
  const report: CheckReport = {
    run,
    userAgent: navigator.userAgent,
    timer: game.timestamps ? 'timestamps' : 'submitted-work',
    promptMs: game.promptMs,
    timings: game.timings,
    fingerprint: '',
    views: [],
    errors: [],
  };
  // Where the check has got to, so a run that stalls says where.
  const progress = (stage: string) => post('progress.json', JSON.stringify({ stage }));
  try {
    await progress('fingerprint');
    report.fingerprint = await game.fingerprint();
    game.setQuality({ preset: 'high', dynres: false });
    for (const name of VIEW_NAMES) {
      await progress(`view ${name}`);
      game.view(name);
      await game.waitConverged();
      await game.waitFrames(30);
      const gpuMs = game.timestamps ? (game.stats().gpuMs ?? 0) : median(await game.submittedWork(30));
      const { png, spread } = await game.shot();
      const hours = game.viewHours(name);
      const shot = `${name}-${clockName(hours)}.png`;
      await post(shot, png);
      report.views.push({ name, hours, gpuMs, res: game.stats().res, shot, spread });
    }
    await progress('done');
  } catch (e) {
    report.errors.push(e instanceof Error ? e.message : String(e));
  }
  await post('report.json', JSON.stringify(report, null, 2));
  return report;
}
