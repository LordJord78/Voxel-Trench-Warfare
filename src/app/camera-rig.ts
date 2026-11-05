/**
 * Where the camera is each frame: the player's interpolated foot raised to
 * the eye (which follows the body's height, so crouching is smooth), bobbing
 * with the stride, dipping on a landing (the session's dip, eased between
 * ticks as the foot is, which its muzzle carries), and narrowing for the periscope,
 * eased so raising it does not read as a cut; turned by the rifle's recoil,
 * suppression's flinch and shake, the view kick's pulse of the field of view
 * and its camera's roll, and turned and moved by a shot's shake, interpolated
 * between ticks as the foot is; and narrowed by the sight's magnification
 * as the sights come up. Python's `_place_camera`
 * and `_place_viewmodel`, without the stride's roll (the shakes' it carries).
 *
 * At 10 cm the ground is all steps: the body snaps up and down them, and
 * stands or raises the periscope in a tick. The eye eases those jumps out
 * over a few frames; motion the velocity explains (a fall, a jump) over the
 * time the simulation actually ran it follows exactly — none while paused,
 * and only what the clock let through after a hitch — and a teleport it
 * does not ease at all.
 */

import { modelToView } from '../combat/viewmodel';
import type { Tunables } from '../core/tunables';
import { cameraBasis, type CameraPose } from '../render/camera';
import type { RiflePose } from '../render/rifle';
import type { Session } from '../sim/session';

/** The camera's own: its field of view and how it eases, and the head's bob. Its landing dip is the session's (landingDipAt), which the muzzle carries too. */
export interface RigTunables {
  /** Horizontal degrees. */
  fov: number;
  fovLerpPerS: number;
  bobAmplitude: number;
}

export function rigTunables(tun: Tunables): RigTunables {
  return {
    fov: tun.f('camera.fov'),
    fovLerpPerS: tun.f('camera.fov_lerp_per_s'),
    bobAmplitude: tun.f('camera.head_bob_amplitude'),
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
  /** Where the rifle was drawn the last frame it was. */
  private lastRifle: Float32Array | null = null;

  constructor(t: RigTunables) {
    this.t = t;
  }

  /**
   * How fast the player moves of a run's speed (`[handling] run_mps`, the hands' own share of a run),
   * and the stride's sideways sway (metres), which the eye leans with.
   */
  private stride(session: Session): { speedRatio: number; sway: number } {
    const player = session.player;
    const speedRatio = Math.min(1, player.velocity.horizontalLength / session.handling.t.runMps);
    return { speedRatio, sway: Math.sin(player.bobPhase * 0.5) * this.t.bobAmplitude * 0.6 * speedRatio };
  }

  pose(session: Session, frameDt: number, baseFov = this.t.fov): CameraPose {
    const player = session.player;
    const foot = session.footAt();
    const eye = session.controller.eyeHeight(player);
    const { speedRatio, sway } = this.stride(session);
    const bob = Math.sin(player.bobPhase) * this.t.bobAmplitude * speedRatio;
    // A landing's dip, between the last two ticks' as the foot is: the session's, whose muzzle (the
    // flash, the tracer's start, the brass) carries the tick's own.
    const dip = session.landingDipAt();
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
    // The view as the rifle sees it: its recoil and the flinch, with the shakes, the view kick's pulse
    // of the field of view and its camera's roll, and a shot's shake moving the eye (the round leaves
    // along the aim alone: these are the camera's), between ticks as the foot is.
    const view = session.viewAt();
    const [sx, sy, sz] = view.shake;
    return {
      position: [foot.x + Math.cos(yaw) * lean + sx, body + this.trail + bob + dip + sy, foot.z - Math.sin(yaw) * lean + sz],
      yaw: player.yaw + view.yaw,
      pitch: player.pitch + view.pitch,
      roll: view.roll,
      fov: (baseFov * this.fovScale) / session.zoomAt() + view.fov,
    };
  }

  /**
   * Where the rifle is drawn this frame, held in the view `pose` shows (combat/viewmodel.ts), and
   * where it was the last frame the rifle was drawn (itself, after a frame without it). Its stride's
   * motion is the hands' (handling.ts's bob, either side of centre by turns), so the eye's sway is
   * not given to it: only a run's share, for its dip at speed.
   */
  rifle(session: Session, pose: CameraPose): RiflePose {
    const { speedRatio } = this.stride(session);
    const held = session.viewmodelAt(undefined, 0, speedRatio);
    const { forward, right, up } = cameraBasis(pose.yaw, pose.pitch, pose.roll ?? 0);
    const toWorld = (v: readonly number[]) => [0, 1, 2].map((k) => right[k] * v[0] + up[k] * v[1] + forward[k] * v[2]);
    const origin = modelToView(held, [0, 0, 0]);
    const axis = (a: readonly number[]) => {
      const v = modelToView(held, a);
      return toWorld([v[0] - origin[0], v[1] - origin[1], v[2] - origin[2]]);
    };
    const at = toWorld(origin).map((v, k) => v + pose.position[k]);
    const m = new Float32Array([...axis([1, 0, 0]), ...axis([0, 1, 0]), ...axis([0, 0, 1]), ...at]);
    const out = { toWorld: m, prevToWorld: this.lastRifle ?? m };
    this.lastRifle = m;
    return out;
  }

  /** The rifle is not drawn this frame: the next one drawn starts its motion afresh. */
  hideRifle(): void {
    this.lastRifle = null;
  }
}
