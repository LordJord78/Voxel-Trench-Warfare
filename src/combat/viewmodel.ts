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
  /** How far it is raised on the firing step, and the time constant of raising it. */
  stepRaiseM: number;
  raiseS: number;
}

export function viewmodelTunables(tun: Tunables): ViewmodelTunables {
  return {
    restRightM: tun.f('viewmodel.rest_right_m'),
    restUpM: tun.f('viewmodel.rest_up_m'),
    restForwardM: tun.f('viewmodel.rest_forward_m'),
    swayFollow: tun.f('viewmodel.sway_follow'),
    runDipM: tun.f('viewmodel.run_dip_m'),
    stepRaiseM: tun.f('viewmodel.step_raise_m'),
    raiseS: tun.f('viewmodel.raise_s'),
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

/** The pose for a kick, the walk's sway (metres, as the camera's), a run's share of full speed, and how far raised for the firing step (0 to 1). */
export function viewmodelPose(t: ViewmodelTunables, kick: ViewmodelKick, sway: number, speedRatio: number, raised = 0): ViewmodelPose {
  return {
    offset: [t.restRightM + kick.side + sway * t.swayFollow, t.restUpM + kick.up - speedRatio * t.runDipM + raised * t.stepRaiseM, t.restForwardM - kick.back],
    pitch: kick.pitch,
    yaw: kick.yaw,
    roll: kick.roll,
  };
}

/** What the hands hold, as their pose needs it: a long gun or a pistol and its sight (arsenal.ts `sightOf`), or the shovel. */
export interface Holding {
  kind: 'rifle' | 'pistol' | 'shovel';
  /** Aimed: the sight's line over the bore, and how far before the eye the model's origin comes. */
  sight: { y: number; z: number };
}

export const RIFLE_HOLDING: Holding = { kind: 'rifle', sight: { y: 0.0675, z: 0.1 } };

/** A pistol's rest, nearer the middle and lower than a long gun's; the shovel's, low at the right, its blade down. */
const PISTOL_REST = [0.13, -0.19, 0.4] as const;
// In the lower right, its blade in toward the middle and down, in view at a 90° field of view.
const SHOVEL_REST = { offset: [0.16, -0.16, 0.3], pitch: -22, yaw: -18, roll: 10 } as const;

const smooth = (t: number) => t * t * (3 - 2 * t);

/** The shovel's stroke, as offsets (metres) and turns (degrees) from its rest: push in, lever, throw to the right, back. */
const STROKE: readonly { at: number; o: readonly [number, number, number]; pitch: number; yaw: number; roll: number }[] = [
  { at: 0, o: [0, 0, 0], pitch: 0, yaw: 0, roll: 0 },
  { at: 0.3, o: [0, -0.05, 0.14], pitch: -20, yaw: 0, roll: 0 },
  { at: 0.55, o: [0, 0.03, 0.08], pitch: 22, yaw: 0, roll: 0 },
  { at: 0.78, o: [0.08, 0.06, 0.03], pitch: 12, yaw: 32, roll: 28 },
  { at: 1, o: [0, 0, 0], pitch: 0, yaw: 0, roll: 0 },
];

function strokeAt(phase: number): { o: [number, number, number]; pitch: number; yaw: number; roll: number } {
  const p = ((phase % 1) + 1) % 1;
  let i = 0;
  while (i < STROKE.length - 2 && p > STROKE[i + 1].at) i++;
  const a = STROKE[i];
  const b = STROKE[i + 1];
  const t = smooth(Math.min(1, Math.max(0, (p - a.at) / (b.at - a.at))));
  const mix = (x: number, y: number) => x + (y - x) * t;
  return { o: [mix(a.o[0], b.o[0]), mix(a.o[1], b.o[1]), mix(a.o[2], b.o[2])], pitch: mix(a.pitch, b.pitch), yaw: mix(a.yaw, b.yaw), roll: mix(a.roll, b.roll) };
}

/**
 * What is in the hands, posed: a gun at its rest (`viewmodelPose`, a pistol's lower and nearer the
 * middle), brought to the eye as `aimed` goes to 1 (its sight's line on the eye's, the kick
 * steadied); the shovel low at the right, through its `stroke` (0 to 1, null at rest); and either
 * dipped out of view as `ready` goes to 0, while one thing is put away and the next comes up.
 * At rest, raised and not aimed, a rifle's is `viewmodelPose`'s exactly.
 */
export function heldPose(t: ViewmodelTunables, holding: Holding, kick: ViewmodelKick, sway: number, speedRatio: number, raised: number, aimed = 0, ready = 1, stroke: number | null = null): ViewmodelPose {
  let pose: ViewmodelPose;
  if (holding.kind === 'shovel') {
    const s = stroke === null ? { o: [0, 0, 0], pitch: 0, yaw: 0, roll: 0 } : strokeAt(stroke);
    const r = SHOVEL_REST;
    pose = {
      offset: [r.offset[0] + s.o[0] + sway * t.swayFollow, r.offset[1] + s.o[1] - speedRatio * t.runDipM, r.offset[2] + s.o[2]],
      pitch: r.pitch + s.pitch,
      yaw: r.yaw + s.yaw,
      roll: r.roll + s.roll,
    };
  } else {
    pose = viewmodelPose(t, kick, sway, speedRatio, raised);
    if (holding.kind === 'pistol') {
      pose.offset = [pose.offset[0] + PISTOL_REST[0] - t.restRightM, pose.offset[1] + PISTOL_REST[1] - t.restUpM, pose.offset[2] + PISTOL_REST[2] - t.restForwardM];
    }
    if (aimed > 0) {
      const a = smooth(Math.min(1, aimed));
      const sight = holding.sight;
      const to: ViewmodelPose = { offset: [kick.side * 0.5, -sight.y + kick.up * 0.6, sight.z - kick.back * 0.8], pitch: kick.pitch * 0.5, yaw: kick.yaw * 0.5, roll: kick.roll * 0.3 };
      pose = {
        offset: [0, 1, 2].map((k) => pose.offset[k] + (to.offset[k] - pose.offset[k]) * a) as [number, number, number],
        pitch: pose.pitch + (to.pitch - pose.pitch) * a,
        yaw: pose.yaw + (to.yaw - pose.yaw) * a,
        roll: pose.roll + (to.roll - pose.roll) * a,
      };
    }
  }
  if (ready < 1) {
    const d = smooth(1 - Math.max(0, ready));
    pose = { offset: [pose.offset[0] + 0.03 * d, pose.offset[1] - 0.25 * d, pose.offset[2] - 0.05 * d], pitch: pose.pitch - 40 * d, yaw: pose.yaw, roll: pose.roll + 25 * d };
  }
  return pose;
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
