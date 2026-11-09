// Types for hit-measures.mjs (G3's proof's measures), for the tests that read it.

export interface Shot {
  name: string;
  gun: string;
  aimM: number;
  zone: 'torso' | 'head';
  frames: number[];
  kills: boolean;
}

export interface Wall {
  behindM: number;
  halfWidthM: number;
  aboveM: number;
  belowM: number;
  thickM: number;
}

export interface Rgba {
  data: Uint8Array;
  w: number;
  h: number;
}

export const SHOTS: Shot[];
export const BACKSTOP: Wall;
export const NEAR_BACKSTOP: Wall;
export const BURST: { frame: { torso: number; head: number }; threshold: number; margin: number; px: { torso: number; head: number } };
export const GATES: { ringFrame: number; cluster: number; nearCluster: number };
export const DUMMY: { halfWidthM: number; heightM: number };
export const ZOOM: { w: number; h: number; below: number; scale: number };
export function wallBox(eye: readonly number[], feet: readonly number[], wall: Wall, voxel: number): number[];
export function bloodVoxels(found: readonly (readonly number[])[], box: readonly number[]): { wall: number; ground: number; byShade: Record<number, number> };
export function crop(img: Rgba, x0: number, y0: number, w: number, h: number): Rgba;
export function magnify(img: Rgba, k: number): Rgba;
export function strip(imgs: readonly Rgba[], gap?: number): Rgba;
export function changedPixels(a: Rgba, b: Rgba, box: readonly number[], threshold: number, mask?: { data: Uint8Array; count: number }): number;
export function bloodDisc(pose: { position: readonly number[]; yaw: number; pitch: number; roll?: number; fov?: number }, res: readonly number[], billboard: { at: readonly number[]; half: number }): { cx: number; cy: number; r: number } | null;
export function discMask(discs: readonly { cx: number; cy: number; r: number }[], w: number, h: number): { data: Uint8Array; count: number };
export function clusters(voxels: readonly (readonly number[])[]): number[];
export function ringClear(ring: { cx: number; cy: number; inner: number }, box: { x0: number; y0: number; x1: number; y1: number }): { clear: boolean; far: number; margin: number };
export function dummyCorners(feet: readonly number[], dummy: { halfWidthM: number; heightM: number }): number[][];
export function screenBox(points: readonly (readonly number[] | null)[]): { x0: number; y0: number; x1: number; y1: number } | null;
export function zoneOf(readout: string | null): 'torso' | 'head' | 'limb' | null;
