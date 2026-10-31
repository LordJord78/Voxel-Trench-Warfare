/**
 * Another player's body (the multiplayer spec's §3): a skeleton posed from what the room relays of
 * them (stance, height, gait, aim, firing, a fall when killed), and the rigid parts it carries.
 * Each part is a voxel grid (soldier-model.ts) with a frame in the world: the renderer draws it
 * (soldiers.ts) and a round tests it (`hitParts`), from the same frames, so what is drawn is what
 * is hit.
 *
 * The pose is built in the world from points: the hips over the feet; the legs and the arms each
 * two bones reaching for a target (the ground, the rifle's grips), solved by the law of cosines;
 * the rifle along the aim from the right shoulder. A frame is then made from each bone. Pure
 * arithmetic (dmath), so every client poses a body alike.
 */

import { cos, HALF_PI, hypot, radians, sin } from '../core/dmath';

export type V3 = [number, number, number];

/** A part's frame: its axes (x right, y up, z forward, unit and square) and its origin, in world metres. */
export interface Frame {
  x: V3;
  y: V3;
  z: V3;
  t: V3;
}

export const PARTS = ['pelvis', 'torso', 'head', 'upperArmL', 'upperArmR', 'forearmL', 'forearmR', 'thighL', 'thighR', 'shinL', 'shinR', 'rifle'] as const;
export type PartName = (typeof PARTS)[number];

/** Where a round strikes a body, for its damage. */
export type Zone = 'head' | 'torso' | 'limb';
export const ZONE: Record<PartName, Zone | null> = {
  pelvis: 'torso', torso: 'torso', head: 'head',
  upperArmL: 'limb', upperArmR: 'limb', forearmL: 'limb', forearmR: 'limb',
  thighL: 'limb', thighR: 'limb', shinL: 'limb', shinR: 'limb',
  rifle: null,
};

/** Each part's box in its own frame (metres): its grid spans it (soldier-model.ts). */
export const PART_BOX: Record<PartName, { min: V3; max: V3 }> = {
  pelvis: { min: [-0.17, -0.1, -0.11], max: [0.17, 0.1, 0.11] },
  torso: { min: [-0.2, 0, -0.14], max: [0.2, 0.56, 0.14] },
  head: { min: [-0.17, 0, -0.2], max: [0.17, 0.31, 0.2] },
  upperArmL: { min: [-0.06, -0.3, -0.06], max: [0.06, 0, 0.06] },
  upperArmR: { min: [-0.06, -0.3, -0.06], max: [0.06, 0, 0.06] },
  forearmL: { min: [-0.055, -0.3, -0.055], max: [0.055, 0, 0.055] },
  forearmR: { min: [-0.055, -0.3, -0.055], max: [0.055, 0, 0.055] },
  thighL: { min: [-0.08, -0.46, -0.085], max: [0.08, 0, 0.085] },
  thighR: { min: [-0.08, -0.46, -0.085], max: [0.08, 0, 0.085] },
  shinL: { min: [-0.07, -0.47, -0.08], max: [0.07, 0, 0.16] },
  shinR: { min: [-0.07, -0.47, -0.08], max: [0.07, 0, 0.16] },
  rifle: { min: [-0.04, -0.24, -0.27], max: [0.04, 0.07, 0.72] },
};

const THIGH = 0.46;
const SHIN = 0.47;
const UPPER_ARM = 0.29;
const FOREARM = 0.29;
/** The torso, waist to neck. */
const TORSO = 0.55;
/** Hips over the feet, standing straight; and crouched. */
const HIP_STANDING = 0.92;
const HIP_CROUCHED = 0.5;
/** Height of a standing, crouched and prone body (the controller's stances). */
const H_STANDING = 1.8;
const H_CROUCHED = 1.25;
const H_PRONE = 0.55;
/** On the rifle: the pistol grip (right hand) and the handguard (left), model metres (rifle-model.ts). */
const GRIP: V3 = [0, -0.07, 0.04];
const HANDGUARD: V3 = [0, -0.03, 0.42];
/** How long a killed body takes to fall. */
const FALL_S = 0.7;

export interface PoseInput {
  /** Foot centre, metres. */
  position: V3;
  /** Degrees: yaw 0 faces +z; pitch up is positive. */
  yaw: number;
  pitch: number;
  /** The body's height (the controller's: 1.8 standing, 1.25 crouched, 0.55 prone, eased between). */
  height: number;
  /** Horizontal speed (m/s) and the stride's phase (radians), for the gait. */
  speed: number;
  bob: number;
  /** Seconds since killed, or null alive. */
  deadFor: number | null;
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3): number => hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a);
  return l > 1e-9 ? mul(a, 1 / l) : [0, 1, 0];
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** A frame whose y runs along `up` and whose z leans toward `forward` (made square to y). */
function frameAlong(origin: V3, up: V3, forward: V3): Frame {
  const y = norm(up);
  let z = sub(forward, mul(y, dot(forward, y)));
  if (len(z) < 1e-6) z = sub([0, 0, 1], mul(y, y[2]));
  z = norm(z);
  return { x: cross(y, z), y, z, t: origin };
}

/** A bone from `from` to `to`, its y back up the bone (parts hang down their −y), z toward `toward`. */
function bone(from: V3, to: V3, toward: V3): Frame {
  return frameAlong(from, sub(from, to), toward);
}

/**
 * Where the middle joint of a two-bone limb goes (knee, elbow): from `root` toward `target`, bones
 * of `a` and `b`, bending toward `pole`. A target out of reach is reached for in a straight line.
 */
export function twoBone(root: V3, target: V3, a: number, b: number, pole: V3): { joint: V3; end: V3 } {
  const span = sub(target, root);
  const d = Math.min(Math.max(len(span), Math.abs(a - b) + 1e-4), a + b - 1e-4);
  const dir = norm(span);
  const x = (a * a - b * b + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, a * a - x * x));
  let side = sub(pole, mul(dir, dot(pole, dir)));
  side = len(side) < 1e-6 ? norm(cross(dir, [1, 0, 0])) : norm(side);
  const joint = add(add(root, mul(dir, x)), mul(side, h));
  return { joint, end: add(root, mul(dir, d)) };
}

/** Rotate `p` about the horizontal axis `axis` (unit) through `pivot` by `angle` radians. */
function about(p: V3, pivot: V3, axis: V3, angle: number): V3 {
  const v = sub(p, pivot);
  const c = cos(angle);
  const s = sin(angle);
  // Rodrigues' rotation.
  const r = add(add(mul(v, c), mul(cross(axis, v), s)), mul(axis, dot(axis, v) * (1 - c)));
  return add(pivot, r);
}

function turn(f: Frame, pivot: V3, axis: V3, angle: number): Frame {
  const rot = (v: V3) => sub(about(add(pivot, v), pivot, axis, angle), pivot);
  return { x: rot(f.x), y: rot(f.y), z: rot(f.z), t: about(f.t, pivot, axis, angle) };
}

/** Every part's frame for a body posed as `p`. */
export function pose(p: PoseInput): Record<PartName, Frame> {
  const yaw = radians(p.yaw);
  const forward: V3 = [sin(yaw), 0, cos(yaw)];
  const right: V3 = [cos(yaw), 0, -sin(yaw)];
  const up: V3 = [0, 1, 0];
  const feet = p.position;
  // How crouched (0 standing, 1 crouched) and how prone (0 crouched, 1 lying).
  const crouch = clamp01((H_STANDING - p.height) / (H_STANDING - H_CROUCHED));
  const prone = clamp01((H_CROUCHED - p.height) / (H_CROUCHED - H_PRONE));
  // The gait: a stride that grows with speed, gone lying down.
  const stride = Math.min(1, p.speed / 4) * (1 - prone);
  const swing = sin(p.bob) * 0.32 * stride;
  // The aim: a lying body looks up less far.
  const aimPitch = radians(Math.max(-60, Math.min(60, p.pitch)) * (1 - 0.5 * prone));
  const aim: V3 = norm(add(mul(forward, cos(aimPitch)), mul(up, sin(aimPitch))));

  // The hips: over the feet, lower crouched; lying, at the ground, the body pitched along it.
  const lean = lerp(lerp(0.06, 0.5, crouch), HALF_PI - 0.04, prone);
  const hipY = lerp(lerp(HIP_STANDING, HIP_CROUCHED, crouch), 0.22, prone);
  const hips: V3 = add(add(feet, mul(up, hipY)), mul(forward, lerp(0, -0.1, prone)));
  const spine: V3 = norm(add(mul(up, cos(lean)), mul(forward, sin(lean))));
  const neck = add(hips, mul(spine, TORSO));
  const bodyForward: V3 = norm(add(mul(forward, cos(lean)), mul(up, -sin(lean))));

  // The legs: each foot on the ground under its hip, swung by the stride; lying, straight behind.
  const legs = (side: 1 | -1) => {
    const hip = add(hips, mul(right, 0.1 * side));
    const ahead = swing * side;
    const footUp = Math.max(0, -ahead) * 0.18 * stride;
    const groundFoot: V3 = add(add(add(feet, mul(right, 0.12 * side)), mul(forward, ahead * 0.55 + crouch * 0.12)), mul(up, footUp));
    const lyingFoot: V3 = add(add(hip, mul(spine, -(THIGH + SHIN) + 0.02)), mul(right, 0.06 * side));
    const foot: V3 = prone > 0 ? [lerp(groundFoot[0], lyingFoot[0], prone), lerp(groundFoot[1], lyingFoot[1], prone), lerp(groundFoot[2], lyingFoot[2], prone)] : groundFoot;
    // Knees forward when standing; down toward the ground lying.
    const pole = norm(add(mul(forward, 1 - prone), mul(up, -prone)));
    const { joint: knee, end } = twoBone(hip, foot, THIGH, SHIN, pole);
    return { thigh: bone(hip, knee, pole), shin: bone(knee, end, norm(add(forward, mul(up, -0.2)))) };
  };
  const left = legs(-1);
  const rightLeg = legs(1);

  // The rifle at the right shoulder, along the aim; lowered a little at a run. Killed, it is let
  // go of, and lies on the ground beside the body.
  const dead = p.deadFor !== null;
  const shoulderR = add(add(neck, mul(right, 0.19)), mul(spine, -0.06));
  const shoulderL = add(add(neck, mul(right, -0.19)), mul(spine, -0.06));
  // Square to the aim and level: the aim's pitch is held short of straight up or down.
  const rifleRight = norm(cross(up, aim));
  const rifleUp = norm(cross(aim, rifleRight));
  const rifleOrigin = add(add(add(shoulderR, mul(aim, 0.22)), mul(rifleRight, -0.04)), mul(rifleUp, -0.02 - 0.1 * stride));
  const rifle: Frame = dead ? { x: [0, 1, 0], y: mul(right, -1), z: forward, t: add(add(feet, mul(right, 0.55)), [0, 0.03, 0]) } : { x: rifleRight, y: rifleUp, z: aim, t: rifleOrigin };
  const onRifle = (q: V3): V3 => add(add(add(rifle.t, mul(rifle.x, q[0])), mul(rifle.y, q[1])), mul(rifle.z, q[2]));

  // The arms reach for the rifle's grips, elbows down and out; killed, they hang.
  const arm = (shoulder: V3, hand: V3, side: 1 | -1) => {
    const pole = norm(add(add(mul(up, -1), mul(right, 0.6 * side)), mul(forward, -0.2)));
    const { joint: elbow, end } = twoBone(shoulder, hand, UPPER_ARM, FOREARM, pole);
    return { upper: bone(shoulder, elbow, forward), fore: bone(elbow, end, dead ? forward : aim) };
  };
  const hang = (shoulder: V3, side: 1 | -1): V3 => add(add(shoulder, mul(spine, -(UPPER_ARM + FOREARM - 0.04))), mul(right, 0.06 * side));
  const armR = arm(shoulderR, dead ? hang(shoulderR, 1) : onRifle(GRIP), 1);
  const armL = arm(shoulderL, dead ? hang(shoulderL, -1) : onRifle(HANDGUARD), -1);

  const head = frameAlong(neck, norm(add(spine, mul(up, 0.6 + 0.8 * prone))), norm(add(aim, mul(forward, 0.5))));
  let frames: Record<PartName, Frame> = {
    pelvis: frameAlong(hips, spine, bodyForward),
    torso: frameAlong(hips, spine, bodyForward),
    head,
    upperArmL: armL.upper,
    upperArmR: armR.upper,
    forearmL: armL.fore,
    forearmR: armR.fore,
    thighL: left.thigh,
    thighR: rightLeg.thigh,
    shinL: left.shin,
    shinR: rightLeg.shin,
    rifle,
  };

  // Killed: the body falls back from its feet, and lies there.
  if (p.deadFor !== null) {
    const f = clamp01(p.deadFor / FALL_S);
    const angle = f * f * (HALF_PI - 0.12) * (1 - prone);
    if (angle > 0) {
      const pivot = add(feet, mul(forward, -0.1));
      frames = Object.fromEntries(PARTS.map((n) => [n, n === 'rifle' ? frames[n] : turn(frames[n], pivot, right, -angle)])) as Record<PartName, Frame>;
    }
  }
  return frames;
}

/** A point in a frame (local metres) in the world. */
export function toWorld(f: Frame, q: readonly number[]): V3 {
  return [0, 1, 2].map((k) => f.t[k] + f.x[k] * q[0] + f.y[k] * q[1] + f.z[k] * q[2]) as V3;
}

/** A world point in a frame's local metres. */
export function toLocal(f: Frame, w: readonly number[]): V3 {
  const d = sub(w as V3, f.t);
  return [dot(d, f.x), dot(d, f.y), dot(d, f.z)];
}

export interface PartHit {
  part: PartName;
  zone: Zone;
  /** Metres along the segment. */
  t: number;
}

/**
 * The first part of a posed body a segment from `from` along unit `dir` for `length` metres enters
 * (its box, in the part's frame), or null: the rounds' test (the multiplayer spec's §4). The rifle
 * carried is not the body: rounds pass it.
 */
export function hitParts(frames: Record<PartName, Frame>, from: readonly number[], dir: readonly number[], length: number): PartHit | null {
  let best: PartHit | null = null;
  for (const part of PARTS) {
    const zone = ZONE[part];
    if (!zone) continue;
    const f = frames[part];
    const o = toLocal(f, from);
    const d: V3 = [dot(dir as V3, f.x), dot(dir as V3, f.y), dot(dir as V3, f.z)];
    const { min, max } = PART_BOX[part];
    let t0 = 0;
    let t1 = length;
    let miss = false;
    for (let k = 0; k < 3 && !miss; k++) {
      if (Math.abs(d[k]) < 1e-12) {
        if (o[k] < min[k] || o[k] > max[k]) miss = true;
        continue;
      }
      const a = (min[k] - o[k]) / d[k];
      const b = (max[k] - o[k]) / d[k];
      t0 = Math.max(t0, Math.min(a, b));
      t1 = Math.min(t1, Math.max(a, b));
      if (t0 > t1) miss = true;
    }
    if (!miss && (!best || t0 < best.t)) best = { part, zone, t: t0 };
  }
  return best;
}

/** A sphere round a posed body's parts a round can strike (centre, radius), standing to lying dead: segments that miss it miss every part. */
export function bodySphere(feet: readonly number[]): { centre: V3; radius: number } {
  return { centre: [feet[0], feet[1] + 0.8, feet[2]], radius: 2.1 };
}
