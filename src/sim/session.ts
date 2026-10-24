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

import { Artillery, artilleryTunables, planShellSource, type ShellSource } from '../combat/artillery';
import { ballisticsTunables, Rounds, type Impact } from '../combat/ballistics';
import { BlastShake, blastShakeTunables } from '../combat/blast-shake';
import { Entrenching, entrenchingTunables, type Scoop } from '../combat/entrenching';
import { Front, frontTunables, planSource, type FrontSource } from '../combat/front';
import { particleSpec, Particles, type ParticleSpec } from '../combat/particles';
import { Recoil, recoilProfile } from '../combat/recoil';
import { RIFLE_MUZZLE, RIFLE_PORT } from '../combat/rifle-model';
import { Suppression, suppressionTunables } from '../combat/suppression';
import { ViewKick, viewKickProfile } from '../combat/viewkick';
import { modelToView, viewBasis, viewmodelPose, viewmodelTunables, type ViewmodelKick, type ViewmodelPose, type ViewmodelTunables } from '../combat/viewmodel';
import { Weapon, weaponSpec } from '../combat/weapon';
import { FixedClock } from '../core/clock';
import { exp, hypot } from '../core/dmath';
import { Rng } from '../core/rng';
import type { Tunables } from '../core/tunables';
import { CharacterController, controllerTunables, letGoOfLedge, newCharacter, Stance, type CharacterState, type MoveIntent } from '../physics/character';
import { boxHitsSolid } from '../physics/collision';
import { brickGrid } from '../physics/grid';
import { Vec3, ZERO } from '../physics/vec';
import type { BrickMap } from '../world/bricks';
import type { WorldPlan } from '../world/generation/plan';
import { K, kindOf, paletteData } from '../world/materials';
import { groundTop } from '../world/raycast';
import { Destruction, destructionTunables, inProcessRunner, type Crater, type DetonationRunner } from './destruction';

/** Kinds that throw sparks when struck. */
const METAL = new Set<number>([K.PICKET, K.HULL, K.CORRUGATE, K.WIRE]);
/** Voxels a body buried by the world's edits is lifted, at most, to stand on what came down (4 m at 10 cm). */
const LIFT_VOXELS = 40;
/** The shot's particles are anchored to the rifle's muzzle and port, which the renderer draws elsewhere (Particles.billboards). */
export const MUZZLE_ANCHOR = 1;
export const PORT_ANCHOR = 2;

export function idleIntent(): MoveIntent {
  return { forward: 0, strafe: 0, jump: false, sprint: false, stance: Stance.STANDING, periscope: false, fire: false, reload: false, dig: false };
}

/** How the rifle and suppression turn the view, in degrees: recoil and the flinch (yaw, pitch), the shake (pitch, roll), and the view kick's pulse of the field of view. */
export interface ViewOffsets {
  yaw: number;
  pitch: number;
  roll: number;
  fov: number;
}

/** A shot, from where it left along its direction (unit), whether it is a tracer, and the muzzle it flashed at; `tick` is the session's tick that fired it. */
export interface ShotEvent {
  tick: number;
  origin: [number, number, number];
  dir: [number, number, number];
  tracer: boolean;
  /** The player's: the drawn rifle's (they leave from the eye); the front's: the origin. */
  muzzle: [number, number, number];
}

/** What combat did between drains, oldest first. */
export interface CombatEvents {
  /** The player's shots, from the eye. */
  shots: ShotEvent[];
  /** The front's, from its muzzles. */
  frontShots: ShotEvent[];
  impacts: (Impact & { tick: number })[];
  /** Rounds past the player's head, one each: how near, and where it passed nearest. */
  cracks: { tick: number; missM: number; at: [number, number, number] }[];
  /** Craters cut into the world (their slump still to come), and craters settled (voxels), with how many bricks each wrote. */
  cuts: (Crater & { tick: number })[];
  craters: (Crater & { tick: number })[];
  /** Shells announced (their whistle): where each will land (metres), and in how long. */
  incoming: { tick: number; at: [number, number, number]; landsInS: number }[];
  /** Shells landed: where (metres, the top of the ground), how big, and what they struck. */
  /** Shells landed: where, how big, what they struck, and the crater each made (null where none could be). */
  blasts: { tick: number; at: [number, number, number]; radiusM: number; material: number; crater: number | null }[];
  /** Each scoop the player dug: how many voxels, and where (metres). */
  scoops: (Scoop & { tick: number })[];
}

function noEvents(): CombatEvents {
  return { shots: [], frontShots: [], impacts: [], cracks: [], cuts: [], craters: [], incoming: [], blasts: [], scoops: [] };
}

export interface SessionWorld {
  map: BrickMap;
  /** The trench network and landmarks; absent in small test worlds. */
  plan: WorldPlan | null;
  /** Where craters are cut: the destruction worker in play; in-process, in step with the ticks, by default. */
  runner?: DetonationRunner;
  /** Voxels: below it a crater floods. The plan's; with no plan, none unless given. */
  waterTable?: number;
  /** Where the front's shells land; by default the plan's lines, sector and no man's land, and nowhere without a plan. */
  shells?: ShellSource;
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
  /** Where the rifle is held, and the view kick's channels before the last tick. */
  readonly viewmodel: ViewmodelTunables;
  private prevKick: ViewmodelKick;
  /** How far the rifle is raised for the firing step (0 to 1), now and before the last tick. */
  private raised = 0;
  private prevRaised = 0;
  /** The player's rifle, and the rounds in the air. */
  readonly weapon: Weapon;
  readonly rounds: Rounds;
  /** The rifle's feel: its aim's recoil, its view's kick, and the player's suppression. */
  readonly recoil: Recoil;
  readonly viewKick: ViewKick;
  readonly suppression: Suppression;
  /** The enemy line's incoming fire. */
  readonly front: Front;
  /** Craters cut off the main thread and written back a budget a tick; rounds' marks go through it. */
  readonly destruction: Destruction;
  /** The front's shells: their intensity is set beside the front's (the pause menu sets both). */
  readonly artillery: Artillery;
  /** The view's shake from shells landing near. */
  readonly blastShake: BlastShake;
  /** The entrenching tool; `digging` while F is held and the player can dig. */
  readonly entrenching: Entrenching;
  digging = false;
  /** Metres a voxel. */
  readonly voxel: number;
  /** The flash, brass, dust and sparks: cosmetic, and as deterministic as the rest. */
  readonly particles: Particles;
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
  private readonly particleRng: Rng;
  private readonly kinds: Record<'flash' | 'brass' | 'dust' | 'spark' | 'blastFlash' | 'soil' | 'debris', ParticleSpec>;
  /** Each palette entry's linear colour, for the dust it throws. */
  private readonly tints: [number, number, number][];

  static create(world: SessionWorld, tun: Tunables, seed: number, yaw = 0): Session {
    return new Session(world, tun, seed, yaw);
  }

  private constructor(world: SessionWorld, tun: Tunables, seed: number, yaw: number) {
    this.map = world.map;
    this.plan = world.plan;
    const voxel = world.plan?.params.voxel ?? tun.f('world.voxel_size');
    this.voxel = voxel;
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
    this.blastShake = new BlastShake(blastShakeTunables(tun));
    const front = frontTunables(tun);
    const plan = world.plan;
    this.front = new Front(front, world.front ?? (plan ? planSource(plan, front.reachM) : () => null), this.streams.derive('front'));
    this.prevView = this.view();
    this.viewmodel = viewmodelTunables(tun);
    this.prevKick = this.kick();
    this.particles = new Particles(tun.i('particles.pool_capacity'));
    this.particleRng = this.streams.derive('effects.particles');
    this.kinds = {
      flash: particleSpec(tun, 'muzzle_flash'),
      brass: particleSpec(tun, 'brass'),
      dust: particleSpec(tun, 'dust'),
      spark: particleSpec(tun, 'spark'),
      blastFlash: particleSpec(tun, 'blast_flash'),
      soil: particleSpec(tun, 'shell_soil'),
      debris: particleSpec(tun, 'debris'),
    };
    const palette = paletteData();
    this.tints = Array.from({ length: 256 }, (_, id) => [palette[id * 8], palette[id * 8 + 1], palette[id * 8 + 2]]);
    const waterTable = world.waterTable ?? world.plan?.params.waterTable ?? -1;
    this.destruction = new Destruction(world.map, world.runner ?? inProcessRunner(), destructionTunables(tun, waterTable));
    this.entrenching = new Entrenching(world.map, entrenchingTunables(tun), voxel, waterTable);
    this.artillery = new Artillery(artilleryTunables(tun), world.shells ?? (plan ? planShellSource(plan) : () => null), this.streams.derive('combat.shells'));
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
    this.prevKick = this.kick();
    this.prevRaised = this.raised;
    this.controller.tick(p, this.intent, this.clock.dt);
    if (wasOnStep && p.pinned && p.stance !== Stance.FIRING_STEP) this.ejected++;
    // To the shoulder on the firing step, over the parapet; down off it.
    const raise = p.stance === Stance.FIRING_STEP ? 1 : 0;
    this.raised += (raise - this.raised) * (1 - exp(-this.clock.dt / this.viewmodel.raiseS));
    this.dig(this.clock.dt);
    this.combat(this.clock.dt);
    for (const c of this.destruction.tick()) this.events.craters.push({ ...c, tick: this.ticks });
    for (const c of this.destruction.cuts) this.events.cuts.push({ ...c, tick: this.ticks });
    if (this.destruction.written > 0) this.liftOut();
    this.particles.step(this.clock.dt);
  }

  /**
   * Shovel work (the reference's _tick_dig), after the player has moved: F held, on the ground, not
   * lying down and not at the periscope. A scoop waits, banked, while a crater's region it would
   * touch is out (its bricks would undo it); the ground a scoop settles may slump into the body,
   * which is lifted out as a crater's slump is.
   */
  private dig(dt: number): void {
    const p = this.player;
    this.digging = this.intent.dig && p.onGround && p.climbTo === null && p.stance !== Stance.PRONE && p.stance !== Stance.PERISCOPE;
    if (!this.digging) return;
    const scoop = this.entrenching.work(p.position.toArray(), p.yaw, dt, (box) => !this.destruction.overlapsOut(box));
    if (!scoop) return;
    this.events.scoops.push({ ...scoop, tick: this.ticks });
    this.liftOut();
  }

  /** How exposed the player stands (the stance's), and more while digging. Nothing hits the player yet: it is shown only. */
  exposure(): number {
    return this.controller.t.stances[this.player.stance].exposure * (this.digging ? this.entrenching.t.exposureScale : 1);
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
    // A shovel in the hands is not a rifle: the cone, and the recoil, are wider while digging.
    const sway = this.controller.t.stances[p.stance].swayScale * (this.digging ? this.entrenching.t.swayScale : 1);
    w.tick(dt);
    this.recoil.scale = sway;
    this.recoil.tick(dt);
    this.suppression.tick(dt);
    this.blastShake.tick(dt);
    this.viewKick.tick(dt);
    if (this.intent.reload) w.beginReload();
    const eye: [number, number, number] = [p.position.x, p.position.y + this.controller.eyeHeight(p), p.position.z];
    if (w.wants(this.intent.fire && p.stance !== Stance.PERISCOPE)) {
      const aim: [number, number] = [p.yaw + this.recoil.yaw + this.suppression.flinchYaw, p.pitch + this.recoil.pitch + this.suppression.flinchPitch];
      const dir = w.aim(aim[0], aim[1], sway * this.suppression.swayScale, this.dispersion);
      const v = w.spec.projectile.muzzleVelocity;
      const tracer = w.tracer();
      // The round leaves the eye, so the reticle tells the truth; its tracer, flash and brass the
      // drawn rifle, as it stands before this shot kicks it.
      const muzzle = this.muzzle();
      if (this.rounds.fire(eye, [dir[0] * v, dir[1] * v, dir[2] * v], w.spec.projectile, 0, tracer, muzzle) >= 0) {
        w.shot();
        this.throwShot(muzzle);
        const kick = this.recoil.kickPitch;
        this.recoil.shot(this.recoilRng);
        this.viewKick.shot(this.recoil.kickPitch - kick, this.viewKickRng);
        this.shots.push({ origin: eye, dir, aim, tracer });
        this.events.shots.push({ tick: this.ticks, origin: eye, dir, tracer, muzzle });
      }
    }
    this.rounds.listen(eye, this.suppression.t.crackRadiusM);
    this.rounds.step(dt);
    // Suppression counts every substep a round was near (milestone 2's ruling); the ear hears each
    // round once, where it passed nearest.
    for (const c of this.rounds.cracks) this.suppression.crack(c.missM, this.suppressionRng);
    for (const c of this.rounds.passes) this.events.cracks.push({ tick: this.ticks, missM: c.missM, at: c.at });
    for (const hit of this.rounds.impacts) {
      this.destruction.mark(hit.cell[0], hit.cell[1], hit.cell[2], hit.energyJ, this.chipEnergyJ);
      if (hit.owner !== 0) this.suppression.impact(hypot(hit.position[0] - eye[0], hit.position[1] - eye[1], hit.position[2] - eye[2]));
      this.events.impacts.push({ ...hit, tick: this.ticks });
      this.throwImpact(hit);
    }
    // The front's rounds are the ones its tick adds to the pool, the last in it.
    const fired = this.front.tick(dt, eye, this.rounds, w.spec.projectile);
    for (let slot = this.rounds.count - fired; slot < this.rounds.count; slot++) {
      const v = this.rounds.velocity(slot);
      const speed = hypot(v[0], v[1], v[2]);
      const origin = this.rounds.position(slot);
      this.events.frontShots.push({ tick: this.ticks, origin, dir: [v[0] / speed, v[1] / speed, v[2] / speed], tracer: this.rounds.isTracer(slot), muzzle: origin });
    }
    // The front's shells: heard coming in whistle_s before they land.
    const shells = this.artillery.tick(dt, eye);
    for (const sh of shells.announced) {
      const top = groundTop(this.map, sh.x / this.voxel, sh.z / this.voxel);
      if (top !== null) this.events.incoming.push({ tick: this.ticks, at: [sh.x, top * this.voxel, sh.z], landsInS: this.artillery.t.whistleS });
    }
    for (const sh of shells.landed) this.land(sh.x, sh.z, sh.radiusM, sh.seed);
  }

  /**
   * A shell of `radiusM` landing at (x, z) (metres) on the top of the ground there, its crater cut
   * with `seed`: its blast now, its crater queued (an event once it is in the world). Its id, or null
   * where there is no ground (off the map).
   */
  land(x: number, z: number, radiusM: number, seed: number): number | null {
    const v = this.voxel;
    const top = groundTop(this.map, x / v, z / v);
    if (top === null) return null;
    const material = this.map.get(Math.floor(x / v), top - 1, Math.floor(z / v));
    const id = this.destruction.shell([x / v, top, z / v], radiusM / v, seed);
    const at: [number, number, number] = [x, top * v, z];
    this.events.blasts.push({ tick: this.ticks, at, radiusM, material, crater: id });
    this.throwBlast(at, material);
    const p = this.player;
    const d = hypot(at[0] - p.position.x, at[1] - (p.position.y + this.controller.eyeHeight(p)), at[2] - p.position.z);
    this.blastShake.kick(d);
    this.suppression.blast(d);
    return id;
  }

  /**
   * Whatever the world has just written into the player's body (a crater's slump): they are lifted,
   * a voxel at a time, to the lowest height where the body is clear, and stand on what came down.
   * The controller only ever looks down for ground, so without this they would stay inside it.
   */
  private liftOut(): void {
    const p = this.player;
    const g = this.controller.grid;
    const r = this.controller.t.radius;
    if (!boxHitsSolid(g, p.position, r, p.height)) return;
    const v = this.voxel;
    const feet = Math.floor(p.position.y / v + 1e-6) * v;
    for (let k = 1; k <= LIFT_VOXELS; k++) {
      const at = new Vec3(p.position.x, feet + k * v, p.position.z);
      if (boxHitsSolid(g, at, r, p.height)) continue;
      p.position = at;
      p.velocity = new Vec3(p.velocity.x, 0, p.velocity.z);
      p.onGround = true;
      letGoOfLedge(p);
      return;
    }
  }

  /** What a shell throws up out of its crater: its flash, and soil and debris of the ground it struck. */
  private throwBlast(at: readonly number[], material: number): void {
    const { blastFlash, soil, debris } = this.kinds;
    const up = (spec: ParticleSpec) => [0, spec.speed + spec.lift, 0];
    this.particles.emit(at, up(blastFlash), blastFlash, blastFlash.count, this.particleRng);
    this.particles.emit(at, up(soil), soil, soil.count, this.particleRng, this.tints[material]);
    this.particles.emit(at, up(debris), debris, debris.count, this.particleRng, this.tints[material]);
  }

  /** A shot's flash out along the bore from the muzzle, and its brass out of the port, to the right and up (the reference's view kick). */
  private throwShot(muzzle: readonly number[]): void {
    const p = this.player;
    const view = this.view();
    const { forward, right, up } = viewBasis(p.yaw + view.yaw, p.pitch + view.pitch, view.roll);
    const along = (spec: ParticleSpec, d: readonly number[]) => [0, 1, 2].map((k) => d[k] * spec.speed + up[k] * spec.lift);
    const { flash, brass } = this.kinds;
    this.particles.emit(muzzle, along(flash, forward), flash, flash.count, this.particleRng, undefined, MUZZLE_ANCHOR);
    this.particles.emit(this.port(), along(brass, right), brass, brass.count, this.particleRng, undefined, PORT_ANCHOR);
  }

  /** What a round throws where it strikes: dust of the struck material off its face, and sparks off metal. */
  private throwImpact(hit: Impact): void {
    const n = hit.normal[0] === 0 && hit.normal[1] === 0 && hit.normal[2] === 0 ? [0, 1, 0] : hit.normal;
    const { dust, spark } = this.kinds;
    this.particles.emit(hit.position, [n[0] * dust.speed, n[1] * dust.speed + dust.lift, n[2] * dust.speed], dust, dust.count, this.particleRng, this.tints[hit.material]);
    if (METAL.has(kindOf(hit.material))) this.particles.emit(hit.position, [n[0] * spark.speed, n[1] * spark.speed + spark.lift, n[2] * spark.speed], spark, spark.count, this.particleRng);
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

  /**
   * The rifle's pose between the last two ticks, `alpha` of the way to the latest, with the
   * walk's sway (metres, as the camera's) and a run's share of full speed, which the camera has.
   */
  viewmodelAt(alpha = this.clock.alpha, sway = 0, speedRatio = 0): ViewmodelPose {
    const a = this.prevKick;
    const b = this.kick();
    const at = (k: keyof ViewmodelKick) => a[k] + (b[k] - a[k]) * alpha;
    const raised = this.prevRaised + (this.raised - this.prevRaised) * alpha;
    return viewmodelPose(this.viewmodel, { back: at('back'), up: at('up'), side: at('side'), pitch: at('pitch'), yaw: at('yaw'), roll: at('roll') }, sway, speedRatio, raised);
  }

  /** The rifle's muzzle in world metres, as the last tick left the view and the kick: where the flash and the tracers start. */
  muzzle(): [number, number, number] {
    return this.rifleToWorld(RIFLE_MUZZLE);
  }

  /** The rifle's ejection port in world metres: where the brass leaves. */
  port(): [number, number, number] {
    return this.rifleToWorld(RIFLE_PORT);
  }

  /** A rifle point (model metres) in the world, from the eye along the view with its offsets; the walk's sway and dip (a centimetre) are the camera's. */
  private rifleToWorld(point: readonly number[]): [number, number, number] {
    const p = this.player;
    const view = this.view();
    const { forward, right, up } = viewBasis(p.yaw + view.yaw, p.pitch + view.pitch, view.roll);
    const v = modelToView(viewmodelPose(this.viewmodel, this.kick(), 0, 0, this.raised), point);
    const eye = [p.position.x, p.position.y + this.controller.eyeHeight(p), p.position.z];
    return [0, 1, 2].map((k) => eye[k] + right[k] * v[0] + up[k] * v[1] + forward[k] * v[2]) as [number, number, number];
  }

  /** The view kick's channels now. */
  private kick(): ViewmodelKick {
    const k = this.viewKick;
    return { back: k.back, up: k.up, side: k.side, pitch: k.pitch, yaw: k.yaw, roll: k.roll };
  }

  /** The view's offsets as the last tick left them. */
  private view(): ViewOffsets {
    const shake = this.suppression.shake;
    return {
      yaw: this.recoil.yaw + this.suppression.flinchYaw,
      pitch: this.recoil.pitch + this.suppression.flinchPitch + shake.pitch + this.blastShake.pitch,
      roll: shake.roll + this.blastShake.roll,
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
    letGoOfLedge(p);
    p.bobPhase = 0;
    this.prevPosition = p.position;
  }
}
