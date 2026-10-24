/**
 * The check (`?check=<run>`): once the game is ready, measure and photograph
 * the six standard views at each of the clock's four keys, then measure the
 * overview through the day, then the overview and the bay under peak combat
 * (peak-combat.ts) at dusk and at night, at the high preset's full resolution
 * with dynamic resolution off, and post a report and the PNGs to the dev server
 * (tools/vite-plugin-report.ts). Chrome runs it in the e2e
 * suite and Safari through `npm run safari`; whoever reads the report judges
 * it, against the golden fingerprint among other things.
 *
 * GPU time comes from timestamp queries where the browser has them, and
 * otherwise from how long each frame's submitted work takes to finish.
 */

import { CLOCK_KEYS, clockText } from '../core/sky-clock';
import type { RenderStats } from '../render/renderer';
import type { PeakResult } from './peak-combat';
import { VIEW_NAMES, type ViewName } from './views';

export interface CheckGame {
  timestamps: boolean;
  promptMs: number;
  timings: Record<string, number>;
  setQuality(q: { preset: 'high'; dynres: false }): void;
  view(name: ViewName): void;
  /** Set the clock, after view() (which sets the view's own hour). */
  setTimeOfDay(hours: number): void;
  waitFrames(n: number): Promise<void>;
  waitConverged(): Promise<void>;
  stats(): RenderStats;
  fingerprint(): Promise<string>;
  /** The next frame's canvas, copied in the frame that drew it: PNG bytes, and its luminance spread. */
  shot(): Promise<{ png: Blob; spread: number }>;
  /** Milliseconds from each of the next `count` frames' submit to its work finishing. */
  submittedWork(count: number): Promise<number[]>;
  /** The GPU's uncaptured errors so far (a format or binding a browser refuses only logs one). */
  gpuErrors(): readonly string[];
  /** A view at an hour under peak combat for `seconds`, measured (peak-combat.ts). */
  underFire(view: ViewName, hours: number, seconds: number): Promise<PeakResult>;
}

export interface CheckView {
  name: ViewName;
  hours: number;
  gpuMs: number;
  /** Each pass's share of the frame and its own time (ms; timing.ts's passTimes), by timestamps; none by submitted work. */
  passes: Record<string, number>;
  own: Record<string, number>;
  res: [number, number];
  /** The canvas the internal image is presented to, in pixels. */
  canvas: [number, number];
  shot: string;
  spread: number;
}

/** The overview at an hour of the day. */
export interface CheckHour {
  hours: number;
  gpuMs: number;
  passes: Record<string, number>;
  own: Record<string, number>;
}

export interface CheckReport {
  run: string;
  userAgent: string;
  timer: 'timestamps' | 'submitted-work';
  promptMs: number;
  timings: Record<string, number>;
  fingerprint: string;
  views: CheckView[];
  day: CheckHour[];
  /** The overview and the bay under peak combat, at dusk and at night. */
  peak: PeakResult[];
  errors: string[];
}

/**
 * The check's canvas in pixels, whatever the window and its pixel density: the e2e runs' (1600 × 1000
 * at a density of 1), so every browser frames each view alike and presents the same image.
 */
export const CHECK_CANVAS: readonly [number, number] = [1600, 1000];

/** The clock's keys each view is seen at, in turn. */
export const CHECK_KEYS = ['dusk', 'night', 'noon', 'dawn'] as const;

/**
 * The hours the overview is measured at through the day: every second hour, and round sunrise and
 * sunset, where the sun 0-2° up makes the key light's rays skim the ground (07:10 0.1°, 17:55 1.4°).
 */
export const DAY_HOURS: readonly number[] = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 6 + 40 / 60, 7 + 10 / 60, 17 + 50 / 60, 17 + 55 / 60];

/**
 * Peak combat in the check: the overview (the farthest field) and the bay (the nearest walls), which
 * bound its cost, at dusk and at night, each for PEAK_S seconds; Chrome's perf gate measures all six views.
 */
export const CHECK_PEAK: readonly (readonly [ViewName, 'dusk' | 'night'])[] = [['overview', 'dusk'], ['overview', 'night'], ['bay', 'dusk'], ['bay', 'night']];
export const PEAK_S = 6;

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
    day: [],
    peak: [],
    errors: [],
  };
  // Where the check has got to, so a run that stalls says where.
  const progress = (stage: string) => post('progress.json', JSON.stringify({ stage }));
  // A view at an hour, settled: its GPU time, and its passes' if timestamps give them.
  const measure = async (name: ViewName, hours: number) => {
    game.view(name);
    game.setTimeOfDay(hours);
    await game.waitConverged();
    await game.waitFrames(30);
    if (!game.timestamps) return { gpuMs: median(await game.submittedWork(30)), passes: {}, own: {} };
    const s = game.stats();
    return { gpuMs: s.gpuMs ?? 0, passes: { ...s.passes }, own: { ...s.own } };
  };
  try {
    await progress('fingerprint');
    report.fingerprint = await game.fingerprint();
    game.setQuality({ preset: 'high', dynres: false });
    for (const name of VIEW_NAMES) {
      for (const key of CHECK_KEYS) {
        await progress(`view ${name} at ${key}`);
        const hours = CLOCK_KEYS[key];
        const { gpuMs, passes, own } = await measure(name, hours);
        const { png, spread } = await game.shot();
        const shot = `${name}-${clockName(hours)}.png`;
        await post(shot, png);
        const { res, canvas } = game.stats();
        report.views.push({ name, hours, gpuMs, passes, own, res, canvas, shot, spread });
      }
    }
    for (const hours of DAY_HOURS) {
      await progress(`the overview at ${clockText(hours)}`);
      report.day.push({ hours, ...(await measure('overview', hours)) });
    }
    for (const [name, key] of CHECK_PEAK) {
      await progress(`peak combat at ${name} at ${key}`);
      report.peak.push(await game.underFire(name, CLOCK_KEYS[key], PEAK_S));
    }
    await progress('done');
  } catch (e) {
    report.errors.push(e instanceof Error ? e.message : String(e));
  }
  report.errors.push(...game.gpuErrors().map((e) => `GPU: ${e}`));
  await post('report.json', JSON.stringify(report, null, 2));
  return report;
}
