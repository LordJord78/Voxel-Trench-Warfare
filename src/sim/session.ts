/**
 * The simulation: the world, the player and its controller, a 60 Hz clock and
 * the named random streams. It runs on the main thread in this sub-project,
 * because walking is cheap. The renderer reads only the map's dirty bricks,
 * so moving the simulation into a worker later changes the transport, not the
 * design.
 *
 * Frames feed it real time; it runs whole ticks, each with the latest intent
 * and the player's latest yaw and pitch, and keeps the position before the
 * last tick so the camera can interpolate between the two.
 */

import { ballisticsTunables, Rounds } from '../combat/ballistics';
import { Weapon, weaponSpec } from '../combat/weapon';
import { FixedClock } from '../core/clock';
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

export interface SessionWorld {
  map: BrickMap;
  /** The trench network and landmarks; absent in small test worlds. */
  plan: WorldPlan | null;
  /** Foot centre, in metres. */
  spawn: { position: readonly [number, number, number] };
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
  /** The player's rifle, and the rounds in the air. */
  readonly weapon: Weapon;
  readonly rounds: Rounds;
  /** The last tick's shots: from the eye, along their aim, and whether each is a tracer. */
  readonly shots: { origin: [number, number, number]; dir: [number, number, number]; tracer: boolean }[] = [];
  private readonly dispersion: Rng;
  private readonly chipEnergyJ: number;

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
    this.chipEnergyJ = tun.f('destruction.chip_energy_j');
  }

  /** A frame's real time, in seconds: runs the whole ticks it covers and returns how many. */
  advance(realDt: number): number {
    const ticks = this.clock.advance(realDt);
    for (let i = 0; i < ticks; i++) this.tick();
    return ticks;
  }

  tick(): void {
    this.prevPosition = this.player.position;
    this.controller.tick(this.player, this.intent, this.clock.dt);
    this.combat(this.clock.dt);
  }

  /**
   * The rifle after the player has moved: a reload asked for, a shot from the eye along the view
   * (none through the periscope: its holder is not holding the rifle), then every round's flight,
   * and a mark wherever one struck.
   */
  private combat(dt: number): void {
    this.shots.length = 0;
    const w = this.weapon;
    const p = this.player;
    w.tick(dt);
    if (this.intent.reload) w.beginReload();
    if (w.wants(this.intent.fire && p.stance !== Stance.PERISCOPE)) {
      const eye: [number, number, number] = [p.position.x, p.position.y + this.controller.eyeHeight(p), p.position.z];
      const dir = w.aim(p.yaw, p.pitch, this.controller.t.stances[p.stance].swayScale, this.dispersion);
      const v = w.spec.projectile.muzzleVelocity;
      const tracer = w.tracer();
      if (this.rounds.fire(eye, [dir[0] * v, dir[1] * v, dir[2] * v], w.spec.projectile, 0, tracer) >= 0) {
        w.shot();
        this.shots.push({ origin: eye, dir, tracer });
      }
    }
    this.rounds.step(dt);
    for (const hit of this.rounds.impacts) chip(this.map, hit.cell[0], hit.cell[1], hit.cell[2], hit.energyJ, this.chipEnergyJ);
  }

  /** The foot between the last two ticks, `alpha` of the way to the latest. */
  footAt(alpha = this.clock.alpha): Vec3 {
    return this.prevPosition.lerp(this.player.position, alpha);
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
