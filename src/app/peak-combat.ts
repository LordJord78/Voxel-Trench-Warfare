/**
 * Peak combat, as the combat spec's done table defines it (row 6): a magazine
 * on full auto, shells landing 20–50 m off at one a second, and the front's
 * fire at the heavy rate. The player plays a standing view with the rifle in
 * hand; the overview, 48 m up, is watched spectating — the camera held at its
 * pose while the session runs — with the player firing from the bay below. The
 * magazine is topped up so the fire never stops for a reload; a shell whose
 * point is off the map turns until it lands, or is skipped. Each view's frames
 * are measured while it lasts: the GPU's own time a frame (by timestamps, or by
 * submitted work where a browser has none) and the main thread's. Chrome's perf
 * gate and the check run (Safari's report) both measure through this.
 */

import type { CameraPose } from '../render/camera';
import type { ViewName } from './views';

/** Seconds between shells; their distance from the player and their radius, metres. */
export const PEAK_SHELL_S = 1;
export const PEAK_RANGE_M: readonly [number, number] = [20, 50];
export const PEAK_RADIUS_M: readonly [number, number] = [2.2, 3.4];
/** Radians between one shell's bearing and the next's: about a ninth of a turn short of a third. */
const TURN = 1.9;
/** Tries at a bearing on the map before a shell is skipped. */
const TRIES = 5;
/** Frames for a view's histories to settle before it is measured. */
const SETTLE_FRAMES = 90;
/** The magazine is topped up below this. */
const TOP_UP_BELOW = 5;

/** The k-th shell's point (x, z, metres) from the player's feet, turned until it is on the map; null if nowhere it tried was. */
export function shellPoint(k: number, from: readonly number[], onMap: (x: number, z: number) => boolean): [number, number] | null {
  const d = PEAK_RANGE_M[0] + (k % 5) * ((PEAK_RANGE_M[1] - PEAK_RANGE_M[0] - 2) / 4);
  for (let t = 0; t < TRIES; t++) {
    const bearing = 0.7 + (k + t) * TURN;
    const x = from[0] + Math.cos(bearing) * d;
    const z = from[2] + Math.sin(bearing) * d;
    if (onMap(x, z)) return [x, z];
  }
  return null;
}

/** The k-th shell's radius, metres: 2.2 to 3.4 in turn. */
export function shellRadius(k: number): number {
  return PEAK_RADIUS_M[0] + (k % 5) * ((PEAK_RADIUS_M[1] - PEAK_RADIUS_M[0]) / 4);
}

/** The q-quantile of `xs` (the sorted value at floor(q × n), the last for q = 1); NaN for none. */
export function percentile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export interface PeakResult {
  view: string;
  hours: number;
  /** Frames drawn while it lasted. */
  frames: number;
  /** Each frame's own GPU time by timestamps, ms; null without them. */
  gpu: { p95: number; median: number; max: number } | null;
  /** Each frame's submitted work to its finish, ms, where there are no timestamps; null with them. */
  submitted: { p95: number; median: number } | null;
  /** The frame callback's time, ms. */
  main: { p99: number; max: number };
  shots: number;
  shells: number;
  /** Shells with nowhere on the map to land. */
  skipped: number;
  /** Sounds started (none where sound has not started: the check has no click). */
  voices: number;
}

/** What the driver needs of the game. */
export interface PeakGame {
  views: Record<ViewName, CameraPose>;
  /** Stand the player playing, their eye at `pose`. */
  standAt(pose: CameraPose): void;
  /** Hold the camera at `pose` with the session running; null to stop, and play again. */
  spectate(pose: CameraPose | null): void;
  setTimeOfDay(hours: number): void;
  setFront(intensity: 'off' | 'heavy'): void;
  trigger(held: boolean): void;
  rounds(): number;
  refill(): void;
  shotsFired(): number;
  feet(): [number, number, number];
  onMap(x: number, z: number): boolean;
  /** A shell of `radiusM` at (x, z), metres: resolves when its crater is in. */
  shell(x: number, z: number, radiusM: number): Promise<unknown>;
  /** Craters queued or out. */
  pending(): number;
  waitFrames(n: number): Promise<void>;
  frames(): number;
  stats(): { gpuLastMs: number | null; gpuSamples: number };
  /** The main thread's time of each of the last frames (up to 600), ms. */
  mainMs(): number[];
  timestamps: boolean;
  submittedWork(count: number): Promise<number[]>;
  voices(): number;
}

/** `view` at `hours` under peak combat for `seconds`, measured; the game calm again after. */
export async function underFire(game: PeakGame, view: ViewName, hours: number, seconds: number): Promise<PeakResult> {
  if (view === 'overview') {
    game.spectate(null);
    game.standAt(game.views.bay);
    game.spectate(game.views.overview);
  } else {
    game.spectate(null);
    game.standAt(game.views[view]);
  }
  game.setTimeOfDay(hours);
  game.setFront('heavy');
  await game.waitFrames(SETTLE_FRAMES);
  const feet = game.feet();
  const shots0 = game.shotsFired();
  const voices0 = game.voices();
  const from = game.frames();
  // Without timestamps, the submitted work of about as many frames as the peak will draw.
  const work = game.timestamps ? null : game.submittedWork(Math.round(seconds * 50));
  const gpu: number[] = [];
  let seen = game.stats().gpuSamples;
  const landings: Promise<unknown>[] = [];
  let skipped = 0;
  let k = 0;
  game.trigger(true);
  const t0 = performance.now();
  while (performance.now() - t0 < seconds * 1000) {
    while (performance.now() - t0 >= k * PEAK_SHELL_S * 1000) {
      const p = shellPoint(k, feet, (x, z) => game.onMap(x, z));
      if (p) landings.push(game.shell(p[0], p[1], shellRadius(k)));
      else skipped++;
      k++;
    }
    if (game.rounds() < TOP_UP_BELOW) game.refill();
    await game.waitFrames(1);
    const s = game.stats();
    if (s.gpuSamples > seen && s.gpuLastMs !== null) gpu.push(s.gpuLastMs);
    seen = s.gpuSamples;
  }
  const frames = game.frames() - from;
  const main = game.mainMs().slice(-frames);
  const shots = game.shotsFired() - shots0;
  const voices = game.voices() - voices0;
  // Calm again: the trigger let go and ticks run with it so, the front quiet, every shell landed.
  game.trigger(false);
  game.setFront('off');
  await game.waitFrames(2);
  await Promise.all(landings);
  for (let n = 0; n < 600 && game.pending() > 0; n++) await game.waitFrames(1);
  const submitted = work ? await work : null;
  if (view === 'overview') game.spectate(null);
  return {
    view,
    hours,
    frames,
    gpu: gpu.length ? { p95: percentile(gpu, 0.95), median: percentile(gpu, 0.5), max: Math.max(...gpu) } : null,
    submitted: submitted ? { p95: percentile(submitted, 0.95), median: percentile(submitted, 0.5) } : null,
    main: { p99: percentile(main, 0.99), max: Math.max(...main) },
    shots,
    shells: landings.length,
    skipped,
    voices,
  };
}
