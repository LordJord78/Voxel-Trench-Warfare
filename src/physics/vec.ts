/**
 * Minimal immutable 3-vector, Python's `physics/vec.py`. Y is up. The
 * controller makes a handful of these a tick, so clarity wins over pooling.
 */

import { cos, hypot, radians, sin } from '../core/dmath';

export class Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;

  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  add(o: Vec3): Vec3 {
    return new Vec3(this.x + o.x, this.y + o.y, this.z + o.z);
  }

  sub(o: Vec3): Vec3 {
    return new Vec3(this.x - o.x, this.y - o.y, this.z - o.z);
  }

  mul(k: number): Vec3 {
    return new Vec3(this.x * k, this.y * k, this.z * k);
  }

  div(k: number): Vec3 {
    return new Vec3(this.x / k, this.y / k, this.z / k);
  }

  neg(): Vec3 {
    return new Vec3(-this.x, -this.y, -this.z);
  }

  dot(o: Vec3): number {
    return this.x * o.x + this.y * o.y + this.z * o.z;
  }

  cross(o: Vec3): Vec3 {
    return new Vec3(this.y * o.z - this.z * o.y, this.z * o.x - this.x * o.z, this.x * o.y - this.y * o.x);
  }

  get length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
  }

  get lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  get horizontalLength(): number {
    return hypot(this.x, this.z);
  }

  normalised(): Vec3 {
    const n = this.length;
    return n > 1e-9 ? new Vec3(this.x / n, this.y / n, this.z / n) : ZERO;
  }

  withY(y: number): Vec3 {
    return new Vec3(this.x, y, this.z);
  }

  lerp(o: Vec3, t: number): Vec3 {
    return new Vec3(this.x + (o.x - this.x) * t, this.y + (o.y - this.y) * t, this.z + (o.z - this.z) * t);
  }

  toArray(): [number, number, number] {
    return [this.x, this.y, this.z];
  }
}

export const ZERO = new Vec3(0, 0, 0);
export const UP = new Vec3(0, 1, 0);

/** Unit forward vector. Yaw 0 looks down +z; positive pitch looks up. */
export function fromYawPitch(yawDeg: number, pitchDeg: number): Vec3 {
  const yaw = radians(yawDeg);
  const pitch = radians(pitchDeg);
  const cp = cos(pitch);
  return new Vec3(sin(yaw) * cp, sin(pitch), cos(yaw) * cp);
}

/** (forward, right) on the horizontal plane. */
export function yawBasis(yawDeg: number): [Vec3, Vec3] {
  const yaw = radians(yawDeg);
  const s = sin(yaw);
  const c = cos(yaw);
  return [new Vec3(s, 0, c), new Vec3(c, 0, -s)];
}
