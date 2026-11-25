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
  /** An `over` rule's reading (ruleEnergyDb, dB): of a render held over another, and of that other, read alike. */
  overDb?: number;
  /** A `tail` rule's reading (ruleTail, dBFS): its loudest 50 ms before the rule's `afterS` from its onset, and from it on. */
  dryDb?: number;
  tailDb?: number;
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
  /** Its energy in `band` (Hz), over its first `firstS` seconds from its onset if given, at least `db` dB over render `of`'s, read alike; or a list, each so, all read alike (a report over both pistols). */
  over?: OverRule | readonly OverRule[];
  /** Its loudest 50 ms at least `db` dB under render `of`'s (a suppressed report under the bare one's): its loudness, never its sample peak. */
  under?: { of: string; db: number };
  /** Its share over SMALL_SPEAKER_HZ at least `by` over render `of`'s (a suppressed report brighter than the bare one). */
  highOver?: { of: string; by: number };
  /** Its loudest 50 ms from `afterS` after its onset (its tail) between `underDb` (lo, hi) dB under its loudest 50 ms before. */
  tail?: TailRule;
}

/** A report's tail held from both sides: its loudest 50 ms from `afterS` after the onset, `underDb[0]` to `underDb[1]` dB under its loudest 50 ms before. */
export interface TailRule {
  afterS: number;
  underDb: readonly [number, number];
}

/** A render held over another: its energy in `band`, over its first `firstS` seconds if given, at least `db` dB over render `of`'s. */
export interface OverRule {
  of: string;
  band: readonly [number, number];
  firstS?: number;
  db: number;
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
export function ruleEnergyDb(x: Channels, rate: number, rule: { hz: readonly [number, number]; firstS?: number }): number;
export function ruleTail(x: Channels, rate: number, rule: { afterS: number }): { dryDb: number; tailDb: number };
/** A render's `over` rules as a list: none, its one, or each of its list. */
export function overRules(rules?: SoundRules): readonly OverRule[];
export function checkSound(m: Measured, rules?: SoundRules, others?: Readonly<Record<string, Measured>>): string[];
export const COMPRESSOR_THRESHOLD_DB: number;
export function settledFailures(into: Measured, heard: Measured): string[];
export function table(rows: readonly Row[]): string;

/** A reading a render's gates read over its draws (readings): its value on the named draw, on their mean, and on the worst draw; null if not read. */
export interface Reading {
  rule: 'peak' | 'floorDb' | 'band' | 'high' | 'near' | 'over' | 'under' | 'highOver' | 'tail';
  /** The render it reads against, for a rule that names one. */
  of?: string;
  bound: string;
  unit: 'dB' | 'share';
  /** Held on every draw (the peak's range, a floor), or on the mean of the draws (every other rule). */
  on: 'every' | 'mean';
  named: number | null;
  mean: number | null;
  worst: number | null;
}

export function meanOf(draws: readonly Measured[]): Measured;
export function drawLabel(k: number, n: number): string;
export function checkDraws(draws: readonly Measured[], rules?: SoundRules, others?: Readonly<Record<string, readonly Measured[]>>, asked?: number): string[];
export function readings(draws: readonly Measured[], rules?: SoundRules, others?: Readonly<Record<string, readonly Measured[]>>): Reading[];
export function readingsTable(rows: readonly { name: string; readings: readonly Reading[] }[]): string;
