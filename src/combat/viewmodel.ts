/**
 * Where the rifle is held: the reference's viewmodel (render/viewmodel.py) in
 * view space — x right, y up, z forward, metres from the eye. Its rest pose
 * (`[viewmodel]`), moved by the view kick's six channels (offsets in metres,
 * turns in degrees), the walk's sway and a run's dip. A model point is rolled
 * about forward (its right side up), pitched (muzzle up), yawed (muzzle
 * right), then offset.
 *
 * `viewBasis` is the camera's basis (render/camera.ts `cameraBasis`) for the
 * simulation, which may not import the renderer: the muzzle the session fires
 * from is the drawn rifle's.
 */

import { cos, radians, sin } from '../core/dmath';
import type { Tunables } from '../core/tunables';

export interface ViewmodelTunables {
  restRightM: number;
  restUpM: number;
  restForwardM: number;
  /** How much of the walk's sideways sway the rifle carries. */
  swayFollow: number;
  /** How far the rifle drops at a run. */
  runDipM: number;
}

export function viewmodelTunables(tun: Tunables): ViewmodelTunables {
  return {
    restRightM: tun.f('viewmodel.rest_right_m'),
    restUpM: tun.f('viewmodel.rest_up_m'),
    restForwardM: tun.f('viewmodel.rest_forward_m'),
    swayFollow: tun.f('viewmodel.sway_follow'),
    runDipM: tun.f('viewmodel.run_dip_m'),
  };
}

/** The view kick's channels, as `ViewKick` holds them. */
export interface ViewmodelKick {
  back: number;
  up: number;
  side: number;
  pitch: number;
  yaw: number;
  roll: number;
}

/** Where the model's origin sits in view space (metres), and how it is turned (degrees). */
export interface ViewmodelPose {
  offset: [number, number, number];
  pitch: number;
  yaw: number;
  roll: number;
}

/** The pose for a kick, the walk's sway (metres, as the camera's) and a run's share of full speed. */
export function viewmodelPose(t: ViewmodelTunables, kick: ViewmodelKick, sway: number, speedRatio: number): ViewmodelPose {
  return {
    offset: [t.restRightM + kick.side + sway * t.swayFollow, t.restUpM + kick.up - speedRatio * t.runDipM, t.restForwardM - kick.back],
    pitch: kick.pitch,
    yaw: kick.yaw,
    roll: kick.roll,
  };
}

/** A model point (metres) in view space. */
export function modelToView(pose: ViewmodelPose, p: readonly number[]): [number, number, number] {
  const r = radians(pose.roll);
  const x1 = p[0] * cos(r) - p[1] * sin(r);
  const y1 = p[0] * sin(r) + p[1] * cos(r);
  const a = radians(pose.pitch);
  const y2 = y1 * cos(a) + p[2] * sin(a);
  const z2 = -y1 * sin(a) + p[2] * cos(a);
  const b = radians(pose.yaw);
  const x3 = x1 * cos(b) + z2 * sin(b);
  const z3 = -x1 * sin(b) + z2 * cos(b);
  return [pose.offset[0] + x3, pose.offset[1] + y2, pose.offset[2] + z3];
}

type V3 = [number, number, number];

/** The view's forward, right and up at a yaw, pitch and roll (degrees), as the camera's. */
export function viewBasis(yaw: number, pitch: number, roll = 0): { forward: V3; right: V3; up: V3 } {
  const y = radians(yaw);
  const p = radians(pitch);
  const forward: V3 = [sin(y) * cos(p), sin(p), cos(y) * cos(p)];
  const right: V3 = [cos(y), 0, -sin(y)];
  const up: V3 = [
    forward[1] * right[2] - forward[2] * right[1],
    forward[2] * right[0] - forward[0] * right[2],
    forward[0] * right[1] - forward[1] * right[0],
  ];
  if (roll === 0) return { forward, right, up };
  const c = cos(radians(roll));
  const s = sin(radians(roll));
  return {
    forward,
    right: [right[0] * c + up[0] * s, right[1] * c + up[1] * s, right[2] * c + up[2] * s],
    up: [up[0] * c - right[0] * s, up[1] * c - right[1] * s, up[2] * c - right[2] * s],
  };
}
