// Types for sound-measures.mjs (the sounds' proof's measures), for the render page and the tests that read it.

/** A file read: its peak and RMS (dBFS), and the share of its energy in a band. */
export interface Measured {
  peakDb: number;
  rmsDb: number;
  bandShare: number;
}

/** A voice held to a band: more than `share` of its energy must lie in `band` (Hz). */
export interface SoundRules {
  band?: readonly [number, number] | readonly number[];
  share?: number;
}

/** A file's row in the table: what it measured, what failed of it, and whether a failure fails the run (default true). */
export interface Row extends Measured {
  name: string;
  failures: readonly string[];
  gated?: boolean;
}

export const PEAK_DB: [number, number];
export const SILENT_DB: number;
export const BAND: [number, number];
export function dbfs(x: number): number;
export function wav(samples: ArrayLike<number>, rate: number): Uint8Array;
export function bandShare(samples: ArrayLike<number>, rate: number, lo: number, hi: number): number;
export function measure(samples: ArrayLike<number> & Iterable<number>, rate: number, band?: readonly number[]): Measured;
export function checkSound(m: Measured, rules?: SoundRules): string[];
export function table(rows: readonly Row[]): string;
