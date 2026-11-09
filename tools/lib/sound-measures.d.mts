// Types for sound-measures.mjs (the sounds' proof's measures), for the render page and the tests that read it.

/** Samples of one channel, full scale ±1. */
export type Channel = ArrayLike<number> & Iterable<number> & { subarray?: (from: number, to: number) => Channel };
/** One channel, or a list of them (a stereo render's left and right). */
export type Channels = Channel | readonly Channel[];

/** A file read with both ears together: its peak, RMS and loudest 50 ms (dBFS) and where that starts (s), its body's loudest 50 ms, its energy's share in BAND and over SMALL_SPEAKER_HZ. */
export interface Measured {
  peakDb: number;
  rmsDb: number;
  loudestDb: number;
  loudestAtS: number;
  /** Its body's loudest 50 ms (dBFS): its part under SMALL_SPEAKER_HZ alone (a kill's thud, apart from its chime). */
  lowLoudestDb: number;
  bandShare: number;
  highShare: number;
  /** A band rule's own share (ruleShare), measured apart from BAND's. */
  ruleShare?: number;
}

/** A band rule: at least `share` of its energy in `hz` (Hz), over its first `firstS` seconds from its onset if given. */
export interface BandRule {
  hz: readonly [number, number];
  share: number;
  firstS?: number;
}

/** What a render is held to besides its peak's range. */
export interface SoundRules {
  band?: BandRule;
  /** At least this share of its energy over SMALL_SPEAKER_HZ: a laptop's speakers play it. */
  high?: number;
  /** Its peak at least this (dBFS). */
  floorDb?: number;
  /** Its loudest 50 ms within `withinDb` of render `of`'s; with `low`, of `of`'s body's, under SMALL_SPEAKER_HZ alone (the kill's thud, never its chime). */
  near?: { of: string; withinDb: number; low?: boolean };
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
export const SMALL_SPEAKER_HZ: number;
export const LOUDEST_S: number;
export const ONSET_DB: number;
export function dbfs(x: number): number;
export function wav(x: Channels, rate: number): Uint8Array;
export function bandShare(x: Channels, rate: number, lo: number, hi: number): number;
export function loudest(x: Channels, rate: number, windowS?: number): { db: number; atS: number };
export function loudestUnder(x: Channels, rate: number, hz: number, windowS?: number): { db: number; atS: number };
export function measure(x: Channels, rate: number): Measured;
export function onset(x: Channels, rate: number): number | null;
export function ruleShare(x: Channels, rate: number, rule: BandRule): number;
export function checkSound(m: Measured, rules?: SoundRules, others?: Readonly<Record<string, Measured>>): string[];
export function table(rows: readonly Row[]): string;
