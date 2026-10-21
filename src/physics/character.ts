/**
 * First-person character controller, Python's `physics/character.py` line for
 * line. Deterministic: the same state, intent and dt give the same result,
 * which is what lets tests/physics/parity.test.ts replay Python's ticks.
 *
 * Stance is the infantry player's core trade-off and it is settled here,
 * because stance changes height, speed and, through the height, what the
 * trench does and does not hide.
 *
 * One addition: the vertical move is checked a voxel at a time. At 10 cm a
 * prone body falling a metre a tick would pass clean through a duckboard;
 * Python's 0.5 m voxels never needed it, and a move of a voxel or less (every
 * tick of the parity fixtures) is checked exactly as Python checks it.
 */

import { copysign, TAU } from '../core/dmath';
import type { Tunables } from '../core/tunables';
import { K } from '../world/materials';
import { boxHitsSolid, groundHeightUnder, submergedDepth, supportIs } from './collision';
import type { VoxelGrid } from './grid';
import { Vec3, ZERO, yawBasis } from './vec';

export const Stance = { STANDING: 0, CROUCHED: 1, PRONE: 2, FIRING_STEP: 3, PERISCOPE: 4 } as const;
export type Stance = (typeof Stance)[keyof typeof Stance];

const STANCE_KEYS = ['standing', 'crouched', 'prone', 'firing_step', 'periscope'] as const;

export interface StanceProfile {
  height: number;
  eyeHeight: number;
  speed: number;
  sprintSpeed: number;
  swayScale: number;
  /** Multiplier on how much of you an enemy can see and hit. */
  exposure: number;
  transitionTime: number;
  /** Field of view multiplier: only the periscope narrows it. */
  fovScale: number;
}

export interface ControllerTunables {
  radius: number;
  stepUp: number;
  gravity: number;
  jumpSpeed: number;
  groundAccel: number;
  airAccel: number;
  friction: number;
  maxFall: number;
  headBobHz: number;
  /** By Stance. */
  stances: StanceProfile[];
}

export function controllerTunables(tun: Tunables): ControllerTunables {
  // Standing on the firing step keeps a standing eye; the periscope's "eye" is its mirror head.
  const eyes = ['standing', 'crouched', 'prone', 'standing', 'periscope'].map((k) => tun.f(`player.eye_height_${k}`));
  return {
    radius: tun.f('player.radius'),
    stepUp: tun.f('player.step_up'),
    gravity: tun.f('player.gravity'),
    jumpSpeed: tun.f('player.jump_speed'),
    groundAccel: tun.f('player.ground_accel'),
    airAccel: tun.f('player.air_accel'),
    friction: tun.f('player.ground_friction'),
    maxFall: tun.f('player.max_fall_speed'),
    headBobHz: tun.f('camera.head_bob_hz'),
    stances: STANCE_KEYS.map((key, i) => {
      const s = `stance.${key}`;
      return {
        height: tun.f(`${s}.height`),
        eyeHeight: eyes[i],
        speed: tun.f(`${s}.speed`),
        sprintSpeed: tun.f(`${s}.sprint_speed`),
        swayScale: tun.f(`${s}.sway_scale`),
        exposure: tun.f(`${s}.exposure`),
        transitionTime: tun.f(`${s}.transition_time`),
        fovScale: tun.has(`${s}.fov_scale`) ? tun.f(`${s}.fov_scale`) : 1,
      };
    }),
  };
}

export interface MoveIntent {
  /** -1 back, +1 forward. */
  forward: number;
  strafe: number;
  jump: boolean;
  sprint: boolean;
  /** Requested posture; a low ceiling may refuse it. */
  stance: Stance;
  /** Raise the periscope: only means anything on a firing step. */
  periscope: boolean;
}

export interface CharacterState {
  /** Foot centre, in metres. */
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  stance: Stance;
  height: number;
  onGround: boolean;
  onFiringStep: boolean;
  landingImpact: number;
  bobPhase: number;
  wadeDepth: number;
  /** A low ceiling refused a stand-up request. */
  blockedStance: boolean;
  /** Outside multiplier on movement (suppression, later). */
  speedScale: number;
  /** Too much incoming to keep your head over the parapet: refuses the step and the periscope. */
  pinned: boolean;
}

export function newCharacter(position: Vec3, yaw = 0, pitch = 0): CharacterState {
  return {
    position,
    velocity: ZERO,
    yaw,
    pitch,
    stance: Stance.STANDING,
    height: 1.8,
    onGround: false,
    onFiringStep: false,
    landingImpact: 0,
    bobPhase: 0,
    wadeDepth: 0,
    blockedStance: false,
    speedScale: 1,
    pinned: false,
  };
}

/** Moves a CharacterState through a voxel grid. */
export class CharacterController {
  readonly grid: VoxelGrid;
  readonly t: ControllerTunables;

  constructor(grid: VoxelGrid, t: ControllerTunables) {
    this.grid = grid;
    this.t = t;
  }

  profile(state: CharacterState): StanceProfile {
    return this.t.stances[state.stance];
  }

  /** From the body's actual height, so crouching is smooth. */
  eyeHeight(state: CharacterState): number {
    const p = this.t.stances[state.stance];
    return state.height * (p.eyeHeight / p.height);
  }

  fovScale(state: CharacterState): number {
    return this.t.stances[state.stance].fovScale;
  }

  tick(state: CharacterState, intent: MoveIntent, dt: number): void {
    this.resolveStance(state, intent, dt);
    const profile = this.t.stances[state.stance];
    const wish = this.wishVelocity(state, intent, profile);
    this.accelerate(state, wish, dt);
    this.applyGravity(state, intent, dt);
    this.integrate(state, dt);
    this.postMove(state, profile, dt);
  }

  private resolveStance(state: CharacterState, intent: MoveIntent, dt: number): void {
    let wanted: Stance = intent.stance;
    // Standing on the firing step is a position, not a posture: it applies itself.
    if (state.onFiringStep && wanted === Stance.STANDING) wanted = Stance.FIRING_STEP;
    else if (!state.onFiringStep && wanted === Stance.FIRING_STEP) wanted = Stance.STANDING;
    // The periscope needs the step under you as well.
    if (state.pinned && (wanted === Stance.FIRING_STEP || wanted === Stance.PERISCOPE)) wanted = Stance.CROUCHED;
    else if (intent.periscope && state.onFiringStep && wanted === Stance.FIRING_STEP) wanted = Stance.PERISCOPE;
    else if (wanted === Stance.PERISCOPE && !(intent.periscope && state.onFiringStep)) wanted = state.onFiringStep ? Stance.FIRING_STEP : Stance.STANDING;

    const target = this.t.stances[wanted];
    state.blockedStance = false;
    // Refuse to grow into a ceiling: dugouts and the culvert are low.
    if (target.height > state.height + 1e-4 && boxHitsSolid(this.grid, state.position, this.t.radius, target.height)) {
      state.blockedStance = true;
      return;
    }
    state.stance = wanted;
    if (target.transitionTime <= 1e-4) {
      state.height = target.height;
      return;
    }
    const rate = Math.max(Math.abs(target.height - this.t.stances[Stance.STANDING].height), 0.2) / target.transitionTime;
    const delta = target.height - state.height;
    if (Math.abs(delta) <= rate * dt) state.height = target.height;
    else state.height += copysign(rate * dt, delta);
  }

  private wishVelocity(state: CharacterState, intent: MoveIntent, profile: StanceProfile): Vec3 {
    const [forward, right] = yawBasis(state.yaw);
    let wish = forward.mul(intent.forward).add(right.mul(intent.strafe));
    if (wish.lengthSq < 1e-8) return ZERO;
    wish = wish.normalised();
    const sprinting = intent.sprint && intent.forward > 0.3 && state.stance === Stance.STANDING;
    let speed = sprinting ? profile.sprintSpeed : profile.speed;
    speed *= Math.max(0, state.speedScale);
    // Wading costs you: knee-deep water in a crater is not a shortcut.
    if (state.wadeDepth > 0.15) speed *= Math.max(0.35, 1 - state.wadeDepth * 0.9);
    return wish.mul(speed);
  }

  private accelerate(state: CharacterState, wish: Vec3, dt: number): void {
    const v = state.velocity;
    let horizontal = new Vec3(v.x, 0, v.z);
    const accel = state.onGround ? this.t.groundAccel : this.t.airAccel;
    if (wish.lengthSq < 1e-8) {
      if (state.onGround) {
        const speed = horizontal.length;
        if (speed > 1e-4) {
          const drop = Math.min(speed, this.t.friction * dt * Math.max(speed, 1.5));
          horizontal = horizontal.mul((speed - drop) / speed);
        } else {
          horizontal = ZERO;
        }
      }
    } else {
      const delta = wish.sub(horizontal);
      const step = accel * dt;
      horizontal = delta.length <= step ? wish : horizontal.add(delta.normalised().mul(step));
    }
    state.velocity = new Vec3(horizontal.x, v.y, horizontal.z);
  }

  private applyGravity(state: CharacterState, intent: MoveIntent, dt: number): void {
    let vy = state.velocity.y;
    if (state.onGround && intent.jump && state.stance === Stance.STANDING) {
      vy = this.t.jumpSpeed;
      state.onGround = false;
    } else {
      vy = Math.max(vy + this.t.gravity * dt, -this.t.maxFall);
    }
    state.velocity = state.velocity.withY(vy);
  }

  private integrate(state: CharacterState, dt: number): void {
    const wasGrounded = state.onGround;
    const vel = state.velocity;
    const h = state.height;
    let [pos, vx] = this.slide(state.position, new Vec3(vel.x * dt, 0, 0), h, wasGrounded, vel.x);
    let vz: number;
    [pos, vz] = this.slide(pos, new Vec3(0, 0, vel.z * dt), h, wasGrounded, vel.z);

    let vy = vel.y;
    const candidate = pos.withY(pos.y + vy * dt);
    if (this.verticalHits(pos, vy * dt, h)) {
      if (vy <= 0) {
        const ground = groundHeightUnder(this.grid, pos, this.t.radius, Math.abs(vy * dt) + 0.7);
        if (ground !== null) pos = pos.withY(ground);
        state.landingImpact = Math.max(state.landingImpact, -vy);
        state.onGround = true;
      }
      vy = 0;
    } else {
      pos = candidate;
      state.onGround = false;
    }
    state.position = pos;
    state.velocity = new Vec3(vx, vy, vz);

    // Grounded probe, plus step-down, so walking off a duckboard step does not launch you into an arc.
    if (!state.onGround && state.velocity.y <= 0) {
      if (boxHitsSolid(this.grid, new Vec3(pos.x, pos.y - 0.06, pos.z), this.t.radius, 0.05)) {
        const ground = groundHeightUnder(this.grid, pos, this.t.radius, 0.3);
        if (ground !== null) state.position = pos.withY(ground);
        state.onGround = true;
        state.velocity = state.velocity.withY(0);
      } else if (wasGrounded && state.velocity.y > -1) {
        const ground = groundHeightUnder(this.grid, pos, this.t.radius, this.t.stepUp + 0.1);
        if (ground !== null && pos.y - ground <= this.t.stepUp) {
          state.position = pos.withY(ground);
          state.onGround = true;
          state.velocity = state.velocity.withY(0);
        }
      }
    }
  }

  /** Whether moving the body by `dy` meets anything solid, checked at most a voxel at a time; the last check is the whole move. */
  private verticalHits(pos: Vec3, dy: number, height: number): boolean {
    const steps = Math.max(1, Math.ceil(Math.abs(dy) / this.grid.voxel));
    for (let i = 1; i <= steps; i++) {
      const y = pos.y + (i === steps ? dy : (dy * i) / steps);
      if (boxHitsSolid(this.grid, pos.withY(y), this.t.radius, height)) return true;
    }
    return false;
  }

  /** Move one horizontal axis, climbing a single step if blocked. */
  private slide(pos: Vec3, delta: Vec3, height: number, grounded: boolean, axisVel: number): [Vec3, number] {
    if (Math.abs(delta.x) < 1e-9 && Math.abs(delta.z) < 1e-9) return [pos, axisVel];
    const candidate = pos.add(delta);
    if (!boxHitsSolid(this.grid, candidate, this.t.radius, height)) return [candidate, axisVel];
    // Penetration recovery: already inside geometry (a bad spawn, collapsed dirt), never refuse to move.
    if (boxHitsSolid(this.grid, pos, this.t.radius, height)) return [candidate, axisVel];
    if (grounded) {
      const raised = candidate.withY(candidate.y + this.t.stepUp);
      if (!boxHitsSolid(this.grid, raised, this.t.radius, height)) {
        const ground = groundHeightUnder(this.grid, raised, this.t.radius, this.t.stepUp + 0.2);
        if (ground !== null && -1e-3 <= ground - pos.y && ground - pos.y <= this.t.stepUp) return [candidate.withY(ground), axisVel];
      }
    }
    return [pos, 0];
  }

  private postMove(state: CharacterState, profile: StanceProfile, dt: number): void {
    const pos = state.position;
    state.wadeDepth = submergedDepth(this.grid, pos, state.height);
    state.onFiringStep = state.onGround && supportIs(this.grid, pos, this.t.radius, K.TIMBER);
    const speed = state.velocity.horizontalLength;
    if (state.onGround && speed > 0.2) {
      state.bobPhase += dt * this.t.headBobHz * (speed / Math.max(profile.speed, 0.1)) * TAU;
      state.bobPhase %= TAU;
    } else {
      state.bobPhase *= 0.9;
    }
    state.landingImpact *= Math.max(0, 1 - dt * 6);
  }
}
