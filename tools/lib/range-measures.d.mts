// Types for range-measures.mjs (G2's proof's measures), for the tests that read it.
import type { Image } from './image.mjs';
import type { Pose, V3 } from './camera.mjs';

export type Kind = 'dummy' | 'mover' | 'torso' | 'head';

export interface Capture {
  name: string;
  map: 'ravine' | 'corridor';
  hours: number;
}

/** A target of the range: a dummy's (or a mover's) feet, or a plate's steel's middle, in metres. */
export interface Target {
  kind: Kind;
  at: V3;
}

export interface Laid {
  dummies: number;
  plates: number;
}

/** What the hooks say is up: the range, its dummies listed, standing and drawn, its plates listed and with their steel in the world. */
export interface Seen {
  up: boolean;
  dummies: number;
  standing: number;
  drawn: number;
  plates: number;
  steel: number;
}

export type Box = [number, number, number, number] | readonly number[];

/** An RGBA picture (w × h × 4 bytes). */
export interface Picture {
  data: Uint8Array;
  w: number;
  h: number;
}

export const CAPTURES: Capture[];
export const SIZE_M: Record<Kind, [number, number]>;
export const MARGIN_PX: number;
export const DELTA: number;
export const SHOW_PIXELS: number;
export function laidOf(spots: readonly { kind: string }[]): Laid;
export function countFailures(laid: Laid, seen: Seen): string[];
export function targetBox(target: Target, pose: Pose, res: readonly [number, number] | readonly number[], margin?: number): [number, number, number, number] | null;
export function shows(up: Image, down: Image, box: Box, delta?: number): { pixels: number; peak: number; area: number };
export function noiseFloor(up: Image, down: Image, boxes: readonly Box[]): number;
export function marked(img: Picture, boxes: readonly Box[]): Picture;
export function sheet(up: Image, down: Image, boxes: readonly Box[], labels: readonly string[]): Picture;
