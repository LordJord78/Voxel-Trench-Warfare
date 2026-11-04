// Types for camera.mjs (the game's camera, for the capture tools), for the tests that read it.

export type V3 = readonly [number, number, number] | readonly number[];

export interface Pose {
  position: V3;
  yaw: number;
  pitch: number;
  roll?: number;
  fov?: number;
}

export const RAD: number;
export function sub(a: V3, b: V3): [number, number, number];
export function dot(a: V3, b: V3): number;
export function lerp(a: V3, b: V3, u: number): [number, number, number];
export function dist(a: V3, b: V3): number;
export function unit(a: V3): [number, number, number];
export function basis(pose: Pose): { forward: number[]; right: number[]; up: number[] };
export function project(pose: Pose, res: readonly [number, number] | readonly number[], p: V3): [number, number] | null;
