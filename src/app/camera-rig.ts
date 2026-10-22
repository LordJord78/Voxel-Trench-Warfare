/**
 * Where the camera is each frame: the player's interpolated foot raised to
 * the eye (which follows the body's height, so crouching is smooth), bobbing
 * with the stride, dipping on a hard landing, and narrowing for the periscope,
 * eased so raising it does not read as a cut. Python's `_place_camera` and
 * `_place_viewmodel`, without the roll the renderer's pose does not carry.
 *
 * At 10 cm the ground is all steps: the body snaps up and down them, and
 * stands or raises the periscope in a tick. The eye eases those jumps out
 * over a few frames; motion the velocity explains (a fall, a jump) over the
 * time the simulation actually ran it follows exactly — none while paused,
 * and only what the clock let through after a hitch — and a teleport it
 * does not ease at all.
 */

import type { Tunables } from '../core/tunables';
import type { CameraPose } from '../render/camera';
import type { Session } from '../sim/session';

export interface RigTunables {
  /** Horizontal degrees. */
  fov: number;
  fovLerpPerS: number;
  bobAmplitude: number;
  landingDip: number;
}

export function rigTunables(tun: Tunables): RigTunables {
  return {
    fov: tun.f('camera.fov'),
    fovLerpPerS: tun.f('camera.fov_lerp_per_s'),
    bobAmplitude: tun.f('camera.head_bob_amplitude'),
    landingDip: tun.f('camera.landing_dip'),
  };
}

const RAD = Math.PI / 180;
/** The eye's jumps ease out with this time constant, in seconds. */
const EASE_S = 0.07;
/** Below this a frame's unexplained vertical move is motion, not a jump. */
const JUMP_M = 0.02;
/** Above this it is a teleport, which the eye does not ease. */
const TELEPORT_M = 1.0;
/** The eye never trails the body by more than this. */
const TRAIL_M = 0.6;

export class CameraRig {
  readonly t: RigTunables;
  /** The field of view's current fraction of the base, easing toward the stance's. */
  fovScale = 1;
  /** Where the eye is drawn relative to where the body puts it, easing to 0. */
  private trail = 0;
  private lastEye: number | null = null;
  /** The simulation time the last frame showed, interpolated between ticks as the foot is. */
  private lastSimTime = 0;

  constructor(t: RigTunables) {
    this.t = t;
  }

  pose(session: Session, frameDt: number, baseFov = this.t.fov): CameraPose {
    const player = session.player;
    const foot = session.footAt();
    const eye = session.controller.eyeHeight(player);
    const speedRatio = Math.min(1, player.velocity.horizontalLength / 5);
    const bob = Math.sin(player.bobPhase) * this.t.bobAmplitude * speedRatio;
    const sway = Math.sin(player.bobPhase * 0.5) * this.t.bobAmplitude * 0.6 * speedRatio;
    const dip = (-Math.min(player.landingImpact, 8) / 8) * this.t.landingDip;
    const body = foot.y + eye;
    const clock = session.clock;
    const simTime = clock.simTime + clock.alpha * clock.dt;
    if (this.lastEye !== null) {
      const jump = body - this.lastEye - player.velocity.y * (simTime - this.lastSimTime);
      if (Math.abs(jump) > TELEPORT_M) this.trail = 0;
      else if (Math.abs(jump) > JUMP_M) this.trail -= jump;
    }
    this.lastEye = body;
    this.lastSimTime = simTime;
    this.trail = Math.min(TRAIL_M, Math.max(-TRAIL_M, this.trail * Math.exp(-Math.max(0, frameDt) / EASE_S)));
    const target = session.controller.fovScale(player);
    this.fovScale += (target - this.fovScale) * Math.min(1, this.t.fovLerpPerS * Math.max(1e-4, frameDt));
    // The sway leans along the camera's right, a few millimetres each stride.
    const yaw = player.yaw * RAD;
    const lean = sway * 0.4;
    return {
      position: [foot.x + Math.cos(yaw) * lean, body + this.trail + bob + dip, foot.z - Math.sin(yaw) * lean],
      yaw: player.yaw,
      pitch: player.pitch,
      fov: baseFov * this.fovScale,
    };
  }
}
