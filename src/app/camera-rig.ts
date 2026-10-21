/**
 * Where the camera is each frame: the player's interpolated foot raised to
 * the eye (which follows the body's height, so crouching is smooth), bobbing
 * with the stride, dipping on a hard landing, and narrowing for the periscope,
 * eased so raising it does not read as a cut. Python's `_place_camera` and
 * `_place_viewmodel`, without the roll the renderer's pose does not carry.
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

export class CameraRig {
  readonly t: RigTunables;
  /** The field of view's current fraction of the base, easing toward the stance's. */
  fovScale = 1;

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
    const target = session.controller.fovScale(player);
    this.fovScale += (target - this.fovScale) * Math.min(1, this.t.fovLerpPerS * Math.max(1e-4, frameDt));
    // The sway leans along the camera's right, a few millimetres each stride.
    const yaw = player.yaw * RAD;
    const lean = sway * 0.4;
    return {
      position: [foot.x + Math.cos(yaw) * lean, foot.y + eye + bob + dip, foot.z - Math.sin(yaw) * lean],
      yaw: player.yaw,
      pitch: player.pitch,
      fov: baseFov * this.fovScale,
    };
  }
}
