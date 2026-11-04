// Types for tracer-measures.mjs (G1's proof: its captures, measures and gates), for the tests that read it.
import type { Composite, Hsv, Image } from './image.mjs';
import type { Pose } from './camera.mjs';

/** A capture: its name, the clock (hours), the burst fired, aimed or seen from the side, whether the battle's amber is gated, and the shooter's team (red unless given). */
export interface Capture {
  name: string;
  hours: number;
  burst: 'near' | 'far' | 'graze';
  aimed?: boolean;
  side?: boolean;
  battle?: boolean;
  team?: 'red' | 'blue';
}

/** A tracer as tracerPixels() gives it. */
export interface DrawnTracer {
  kind: number;
  flown: number;
  headDrawn: boolean;
  head: [number, number] | null;
  tail: [number, number] | null;
  headM: [number, number, number];
  tailM: [number, number, number];
  joinsM: number;
  struck?: boolean;
}

/** A window frame as captured: its step, its PNG, what tracerPixels() said, the drawn muzzle, the exposure, the effects' counts, the depth round the middle, the battle's tracers and the session's suppression. */
export interface Frame {
  k: number;
  png?: Uint8Array;
  info: { res: [number, number]; frame?: number; pose: Pose; gun: [number, number, number, number] | null; weapon?: unknown; tracers: DrawnTracer[] };
  muzzle?: [number, number, number] | null;
  exposure?: number;
  fx?: { ricochets: number; embers: number; heads: number; battleTracers: number };
  depth?: { x0: number; y0: number; n: number; scale: number; metres: ArrayLike<number> } | null;
  battle?: { p: [number, number, number]; v: [number, number, number]; flown: number }[];
  suppression?: number;
}

export interface Track {
  seen: { frame: number; t: DrawnTracer }[];
  path: { fit: 'drawn'; origin: number[]; dir: number[]; lastFlownM: number; point(s: number): number[] } | null;
}

/** A burst's own numbers: the most of each tracer kind's ricochets and embers drawn in a frame (by TRACER_KIND), and the GPU samples taken. */
export interface Burst {
  most: { ricochets: number; embers: number; ricochetsByKind: number[]; embersByKind: number[] };
  gpuSamples: number;
}

/** The measures' results: records the report keeps as they are. */
export type Measures = Record<string, any>;

export const CAPTURES: readonly Capture[];
export const FLASH_FRAMES: number;
export const HEAD_PX: number;
export const RING_PX: readonly number[];
export const RING_MIN_PIXELS: number;
export const MIN_RATIO: number;
export const NOON_HEAD_MIN: number;
export const MIN_GPU_SAMPLES: number;
export const LIT: { ratio: number; min: number };
export const FAR_M: number;
export const FAR_LIT_MIN: number;
export const STREAM_FROM_M: number;
export const STREAM_AIM_PX: number;
export const PATH_M: readonly number[];
export const NOON_RING_PX: readonly number[];
export const TARGET: { nearWidthPx: number; farSaturation: number; farHueDeg: number; battleSaturation: number; pathCover: number; noonContrast: number; streamCover: number; streamSpan: number };
export const TEAM: { red: Hsv; blue: Hsv; amber: Hsv };

export function kindOf(c: Capture): number;
export function teamChannel(kind: number): number;
export function byDay(c: Capture): boolean;
export function headRing(img: Image, info: Frame['info'], kind: number, anyKind?: boolean): Measures;
export function nearWidth(imgs: readonly Image[], frames: readonly Frame[], kind: number): Measures;
export function farColour(imgs: readonly Image[], comp: Composite, frames: readonly Frame[], kind: number): Measures;
export function battleColour(imgs: readonly Image[], comp: Composite, frames: readonly Frame[]): Measures;
export function streamCover(comp: Composite, frames: readonly Frame[], track: Track | null): Measures;
export function trackRound(frames: readonly Frame[], kind: number): Track | null;
export function pathSamples(frames: readonly Frame[], track: Track | null): { points: [number, number][]; metres: number[]; n: number[]; lengthPx: number; end: number } | null;
export function pathCover(comp: Composite, frames: readonly Frame[], track: Track | null, aimed: boolean, pathDepth: ArrayLike<number> | null): Measures;
export function noonContrast(imgs: readonly Image[], frames: readonly Frame[], track: Track | null, kind: number): Measures;
export function marked(img: Image, m: Measures): Buffer;
export function markedComposite(comp: Composite, m: Measures): Buffer;
export function measureCapture(c: Capture, cap: { frames: Frame[]; pathDepth: ArrayLike<number> | null }): { m: Measures; imgs: Image[]; comp: Composite; shot: number };
export function gateCapture(c: Capture, m: Measures, burst: Burst): string[];
