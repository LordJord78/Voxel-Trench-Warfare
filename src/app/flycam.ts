/**
 * A free-flying camera for looking at the world until milestone 5 brings the
 * walking controller: W A S D along the view, Space up, C down, Shift four
 * times as fast; the mouse turns it.
 */

import { cameraBasis, type CameraPose } from '../render/camera';

export class FlyCam {
  pose: CameraPose;
  /** Metres per second. */
  speed = 6;
  /** Degrees per pixel of mouse movement. */
  sensitivity = 0.14;

  constructor(pose: CameraPose) {
    this.pose = { position: [...pose.position], yaw: pose.yaw, pitch: pose.pitch };
  }

  update(dt: number, keys: ReadonlySet<string>, look: readonly [number, number]): void {
    this.pose.yaw += look[0] * this.sensitivity;
    this.pose.pitch = Math.max(-88, Math.min(88, this.pose.pitch - look[1] * this.sensitivity));
    const { forward, right } = cameraBasis(this.pose.yaw, this.pose.pitch);
    const move = [0, 0, 0];
    const add = (v: readonly number[], s: number) => v.forEach((c, i) => (move[i] += c * s));
    if (keys.has('KeyW')) add(forward, 1);
    if (keys.has('KeyS')) add(forward, -1);
    if (keys.has('KeyD')) add(right, 1);
    if (keys.has('KeyA')) add(right, -1);
    if (keys.has('Space')) move[1] += 1;
    if (keys.has('KeyC')) move[1] -= 1;
    const length = Math.hypot(move[0], move[1], move[2]);
    if (length === 0) return;
    const fast = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4 : 1;
    const step = (this.speed * fast * dt) / length;
    for (let i = 0; i < 3; i++) this.pose.position[i] += move[i] * step;
  }
}
