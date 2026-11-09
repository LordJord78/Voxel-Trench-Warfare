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
export const ZOOM: { w: number; h: number; below: number; scale: number };
export function wallBox(eye: readonly number[], feet: readonly number[], wall: Wall, voxel: number): number[];
export function bloodVoxels(found: readonly (readonly number[])[], box: readonly number[]): { wall: number; ground: number; byShade: Record<number, number> };
export function crop(img: Rgba, x0: number, y0: number, w: number, h: number): Rgba;
export function magnify(img: Rgba, k: number): Rgba;
export function strip(imgs: readonly Rgba[], gap?: number): Rgba;
