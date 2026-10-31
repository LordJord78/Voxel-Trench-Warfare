/**
 * Another player's body as it is drawn: their states as the room stamped them, played back a
 * little behind the room's clock (INTERP_DELAY_MS), so there is nearly always a state on either
 * side to blend between. Position and the view are blended; stance, height and the flags are the
 * nearer state's. Past the newest state the body is held there (it is not guessed onward).
 */

import type { PlayerState } from './protocol';

/** How far behind the room's clock others are drawn: two and a half of its 50 ms frames. */
export const INTERP_DELAY_MS = 125;
/** States older than this behind the newest are let go. */
const KEEP_MS = 1500;

/** The shorter way round from `a` to `b` degrees, `t` of the way. */
function lerpAngle(a: number, b: number, t: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return a + d * t;
}

export class SnapshotBuffer {
  private readonly states: { at: number; s: PlayerState }[] = [];

  /** A state the room stamped `at` (ms on its clock); out-of-order and repeated ones are dropped. */
  push(at: number, s: PlayerState): void {
    const last = this.states[this.states.length - 1];
    if (last && (at <= last.at || s.tick < last.s.tick)) return;
    this.states.push({ at, s });
    while (this.states.length > 2 && this.states[0].at < at - KEEP_MS) this.states.shift();
  }

  get newest(): { at: number; s: PlayerState } | undefined {
    return this.states[this.states.length - 1];
  }

  /** The body at the room's time `at`: blended between the states either side, or the nearest end's. */
  sample(at: number): PlayerState | null {
    const n = this.states.length;
    if (n === 0) return null;
    if (at <= this.states[0].at) return this.states[0].s;
    if (at >= this.states[n - 1].at) return this.states[n - 1].s;
    let i = n - 2;
    while (i > 0 && this.states[i].at > at) i--;
    const a = this.states[i];
    const b = this.states[i + 1];
    const t = (at - a.at) / (b.at - a.at);
    const near = t < 0.5 ? a.s : b.s;
    const mix = (p: number, q: number) => p + (q - p) * t;
    return {
      tick: near.tick,
      position: [mix(a.s.position[0], b.s.position[0]), mix(a.s.position[1], b.s.position[1]), mix(a.s.position[2], b.s.position[2])],
      velocity: [mix(a.s.velocity[0], b.s.velocity[0]), mix(a.s.velocity[1], b.s.velocity[1]), mix(a.s.velocity[2], b.s.velocity[2])],
      yaw: lerpAngle(a.s.yaw, b.s.yaw, t),
      pitch: mix(a.s.pitch, b.s.pitch),
      stance: near.stance,
      height: mix(a.s.height, b.s.height),
      flags: near.flags,
    };
  }
}
