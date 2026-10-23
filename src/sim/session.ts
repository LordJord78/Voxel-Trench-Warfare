/**
 * The simulation: the world, the player and its controller, a 60 Hz clock and
 * the named random streams. It runs on the main thread in this sub-project,
 * because walking is cheap. The renderer reads only the map's dirty bricks,
 * so moving the simulation into a worker later changes the transport, not the
 * design.
 *
 * Frames feed it real time; it runs whole ticks, each with the latest intent
 * and the player's latest yaw and pitch, and keeps the position and the view's
 * offsets before the last tick so the camera can interpolate between the two.
 */

import { ballisticsTunables, Rounds, type Impact } from '../combat/ballistics';
import { Front, frontTunables, planSource, type FrontSource } from '../combat/front';
import { Recoil, recoilProfile } from '../combat/recoil';
import { Suppression, suppressionTunables } from '../combat/suppression';
import { ViewKick, viewKickProfile } from '../combat/viewkick';
import { Weapon, weaponSpec } from '../combat/weapon';
import { FixedClock } from '../core/clock';
import { hypot } from '../core/dmath';
import { Rng } from '../core/rng';
import type { Tunables } from '../core/tunables';
import { CharacterController, controllerTunables, newCharacter, Stance, type CharacterState, type MoveIntent } from '../physics/character';
import { brickGrid } from '../physics/grid';
import { Vec3, ZERO } from '../physics/vec';
import type { BrickMap } from '../world/bricks';
import { chip } from '../world/destruction';
import type { WorldPlan } from '../world/generation/plan';

export function idleIntent(): MoveIntent {
  return { forward: 0, strafe: 0, jump: false, sprint: false, stance: Stance.STANDING, periscope: false, fire: false, reload: false };
}

/** How the rifle and suppression turn the view, in degrees: recoil and the flinch (yaw, pitch), the shake (pitch, roll), and the view kick's pulse of the field of view. */
export interface ViewOffsets {
  yaw: number;
  pitch: number;
  roll: number;
  fov: number;
}

/** A shot, from where it left along its direction (unit), and whether it is a tracer; `tick` is the session's tick that fired it. */
export interface ShotEvent {
  tick: number;
  origin: [number, number, number];
  dir: [number, number, number];
  tracer: boolean;
}

/** What combat did between drains, oldest first. */
export interface CombatEvents {
  /** The player's shots, from the eye. */
  shots: ShotEvent[];
  /** The front's, from its muzzles. */
  frontShots: ShotEvent[];
  impacts: (Impact & { tick: number })[];
  /** Near misses of the player's head: how near, and where the round passed. */
  cracks: { tick: number; missM: number; at: [number, number, number] }[];
}

function noEvents(): CombatEvents {
  return { shots: [], frontShots: [], impacts: [], cracks: [] };
}

export interface SessionWorld {
  map: BrickMap;
  /** The trench network and landmarks; absent in small test worlds. */
  plan: WorldPlan | null;
  /** Foot centre, in metres. */
  spawn: { position: readonly [number, number, number] };
  /** Where the front fires from; by default the plan's enemy line, and nowhere without a plan. */
  front?: FrontSource;
}

export class Session {
  readonly map: BrickMap;
  readonly plan: WorldPlan | null;
  readonly clock = new FixedClock();
  readonly controller: CharacterController;
  readonly player: CharacterState;
  readonly streams: Rng;
  intent: MoveIntent = idleIntent();
  /** The player's foot before the last tick. */
  prevPosition: Vec3;
  /** The view's offsets before the last tick. */
  private prevView: ViewOffsets;
  /** The player's rifle, and the rounds in the air. */
  readonly weapon: Weapon;
  readonly rounds: Rounds;
  /** The rifle's feel: its aim's recoil, its view's kick, and the player's suppression. */
  readonly recoil: Recoil;
  readonly viewKick: ViewKick;
  readonly suppression: Suppression;
  /** The enemy line's incoming fire. */
  readonly front: Front;
  /** Times suppression has taken the player off the firing step. */
  ejected = 0;
  /** Ticks run. */
  ticks = 0;
  /** The last tick's shots: from the eye, their direction, the aim (yaw, pitch) before the cone, and whether each is a tracer. */
  readonly shots: { origin: [number, number, number]; dir: [number, number, number]; aim: [number, number]; tracer: boolean }[] = [];
  private readonly dispersion: Rng;
  private readonly recoilRng: Rng;
  private readonly viewKickRng: Rng;
  private readonly suppressionRng: Rng;
  private readonly chipEnergyJ: number;
  private events: CombatEvents = noEvents();

  static create(world: SessionWorld, tun: Tunables, seed: number, yaw = 0): Session {
    return new Session(world, tun, seed, yaw);
  }

  private constructor(world: SessionWorld, tun: Tunables, seed: number, yaw: number) {
    this.map = world.map;
    this.plan = world.plan;
    const voxel = world.plan?.params.voxel ?? tun.f('world.voxel_size');
    this.controller = new CharacterController(brickGrid(world.map, voxel), controllerTunables(tun));
    this.player = newCharacter(new Vec3(...world.spawn.position), yaw, 0);
    this.prevPosition = this.player.position;
    this.streams = Rng.root(seed).derive('session');
    this.weapon = new Weapon(weaponSpec(tun, 'assault_rifle'));
    this.rounds = new Rounds(ballisticsTunables(tun), world.map, voxel);
    this.dispersion = this.streams.derive('combat.dispersion');
    this.recoilRng = this.streams.derive('combat.recoil');
    this.viewKickRng = this.streams.derive('combat.viewkick');
    this.suppressionRng = this.streams.derive('combat.suppression');
    this.chipEnergyJ = tun.f('destruction.chip_energy_j');
    this.recoil = new Recoil(recoilProfile(tun, 'assault_rifle'));
    this.viewKick = new ViewKick(viewKickProfile(tun, 'assault_rifle'));
    this.suppression = new Suppression(suppressionTunables(tun));
    const front = frontTunables(tun);
    const plan = world.plan;
    this.front = new Front(front, world.front ?? (plan ? planSource(plan, front.reachM) : () => null), this.streams.derive('front'));
    this.prevView = this.view();
  }

  /** A frame's real time, in seconds: runs the whole ticks it covers and returns how many. */
  advance(realDt: number): number {
    const ticks = this.clock.advance(realDt);
    for (let i = 0; i < ticks; i++) this.tick();
    return ticks;
  }

  tick(): void {
    this.ticks++;
    const p = this.player;
    // Suppression as the last tick left it slows the feet and pins the player off the step.
    p.speedScale = this.suppression.speedScale;
    p.pinned = this.suppression.pinned;
    const wasOnStep = p.stance === Stance.FIRING_STEP;
    this.prevPosition = p.position;
    this.prevView = this.view();
    this.controller.tick(p, this.intent, this.clock.dt);
    if (wasOnStep && p.pinned && p.stance !== Stance.FIRING_STEP) this.ejected++;
    this.combat(this.clock.dt);
  }

  /**
   * The rifle after the player has moved, in the reference's order: the clocks (the weapon, the
   * recoil scaled by the stance, suppression, the view kick); a reload asked for; a shot from the
   * eye along the view plus recoil and flinch, the cone widened by stance and suppression (none
   * through the periscope: its holder is not holding the rifle), which kicks the recoil and then
   * the view; every round's flight, with near misses heard at the eye; a mark wherever one struck,
   * and suppression from the cracks and from others' impacts; and last the front's fire, whose
   * rounds move from the next tick.
   */
  private combat(dt: number): void {
    this.shots.length = 0;
    const w = this.weapon;
    const p = this.player;
    const sway = this.controller.t.stances[p.stance].swayScale;
    w.tick(dt);
    this.recoil.scale = sway;
    this.recoil.tick(dt);
    this.suppression.tick(dt);
    this.viewKick.tick(dt);
    if (this.intent.reload) w.beginReload();
    const eye: [number, number, number] = [p.position.x, p.position.y + this.controller.eyeHeight(p), p.position.z];
    if (w.wants(this.intent.fire && p.stance !== Stance.PERISCOPE)) {
      const aim: [number, number] = [p.yaw + this.recoil.yaw + this.suppression.flinchYaw, p.pitch + this.recoil.pitch + this.suppression.flinchPitch];
      const dir = w.aim(aim[0], aim[1], sway * this.suppression.swayScale, this.dispersion);
      const v = w.spec.projectile.muzzleVelocity;
      const tracer = w.tracer();
      if (this.rounds.fire(eye, [dir[0] * v, dir[1] * v, dir[2] * v], w.spec.projectile, 0, tracer) >= 0) {
        w.shot();
        const kick = this.recoil.kickPitch;
        this.recoil.shot(this.recoilRng);
        this.viewKick.shot(this.recoil.kickPitch - kick, this.viewKickRng);
        this.shots.push({ origin: eye, dir, aim, tracer });
        this.events.shots.push({ tick: this.ticks, origin: eye, dir, tracer });
      }
    }
    this.rounds.listen(eye, this.suppression.t.crackRadiusM);
    this.rounds.step(dt);
    for (const c of this.rounds.cracks) {
      this.suppression.crack(c.missM, this.suppressionRng);
      this.events.cracks.push({ tick: this.ticks, missM: c.missM, at: c.at });
    }
    for (const hit of this.rounds.impacts) {
      chip(this.map, hit.cell[0], hit.cell[1], hit.cell[2], hit.energyJ, this.chipEnergyJ);
      if (hit.owner !== 0) this.suppression.impact(hypot(hit.position[0] - eye[0], hit.position[1] - eye[1], hit.position[2] - eye[2]));
      this.events.impacts.push({ ...hit, tick: this.ticks });
    }
    // The front's rounds are the ones its tick adds to the pool, the last in it.
    const fired = this.front.tick(dt, eye, this.rounds, w.spec.projectile);
    for (let slot = this.rounds.count - fired; slot < this.rounds.count; slot++) {
      const v = this.rounds.velocity(slot);
      const speed = hypot(v[0], v[1], v[2]);
      this.events.frontShots.push({ tick: this.ticks, origin: this.rounds.position(slot), dir: [v[0] / speed, v[1] / speed, v[2] / speed], tracer: this.rounds.isTracer(slot) });
    }
  }

  /** What combat did since the last drain, oldest first; the session's own start afresh. */
  drainEvents(): CombatEvents {
    const out = this.events;
    this.events = noEvents();
    return out;
  }

  /** The foot between the last two ticks, `alpha` of the way to the latest. */
  footAt(alpha = this.clock.alpha): Vec3 {
    return this.prevPosition.lerp(this.player.position, alpha);
  }

  /** The view's offsets between the last two ticks, `alpha` of the way to the latest. */
  viewAt(alpha = this.clock.alpha): ViewOffsets {
    const a = this.prevView;
    const b = this.view();
    return {
      yaw: a.yaw + (b.yaw - a.yaw) * alpha,
      pitch: a.pitch + (b.pitch - a.pitch) * alpha,
      roll: a.roll + (b.roll - a.roll) * alpha,
      fov: a.fov + (b.fov - a.fov) * alpha,
    };
  }

  /** The view's offsets as the last tick left them. */
  private view(): ViewOffsets {
    const shake = this.suppression.shake;
    return {
      yaw: this.recoil.yaw + this.suppression.flinchYaw,
      pitch: this.recoil.pitch + this.suppression.flinchPitch + shake.pitch,
      roll: shake.roll,
      fov: this.viewKick.fovOffset,
    };
  }

  /** Put the player at a foot position (metres), standing and still; it settles on the next tick. */
  teleport(position: readonly [number, number, number], yaw: number, pitch: number): void {
    const p = this.player;
    p.position = new Vec3(...position);
    p.velocity = ZERO;
    p.yaw = yaw;
    p.pitch = pitch;
    p.stance = Stance.STANDING;
    p.height = this.controller.t.stances[Stance.STANDING].height;
    p.onGround = false;
    p.onFiringStep = false;
    p.landingImpact = 0;
    p.bobPhase = 0;
    this.prevPosition = p.position;
  }
}
