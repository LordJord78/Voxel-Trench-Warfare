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
import { armSpec, GUN_DEFS, loadoutArms, type ArmSpec, type Loadout } from '../combat/arsenal';
import { ballisticsTunables, projectileSpec, Rounds, type BodyHit, type Impact, type ProjectileSpec } from '../combat/ballistics';
import { BlastShake, blastShakeTunables } from '../combat/blast-shake';
import { Entrenching, entrenchingTunables, type Scoop } from '../combat/entrenching';
import { Front, frontTunables, planSource, type FrontSource } from '../combat/front';
import { particleSpec, Particles, type ParticleSpec } from '../combat/particles';
import { Recoil } from '../combat/recoil';
import { bodySphere, hitParts, pose, type Frame, type PartName } from '../combat/soldier-rig';
import { Suppression, suppressionTunables } from '../combat/suppression';
import { ViewKick } from '../combat/viewkick';
import { heldPose, modelToView, viewBasis, viewmodelTunables, type Holding, type ViewmodelKick, type ViewmodelPose, type ViewmodelTunables } from '../combat/viewmodel';
import { Weapon, weaponSpec } from '../combat/weapon';
import { FixedClock } from '../core/clock';
import { cos, exp, hypot, radians, sin, TAU } from '../core/dmath';
import { Rng } from '../core/rng';
import type { Tunables } from '../core/tunables';
import { CharacterController, controllerTunables, letGoOfLedge, newCharacter, Stance, type CharacterState, type MoveIntent } from '../physics/character';
import { boxHitsSolid } from '../physics/collision';
import { brickGrid } from '../physics/grid';
import { Vec3, ZERO } from '../physics/vec';
import type { BrickMap } from '../world/bricks';
import type { WorldPlan } from '../world/generation/plan';
import { K, kindOf, P, paletteData } from '../world/materials';
import { groundTop } from '../world/raycast';
import { BARE, decodeShotMark, encodeShotMark, GUNS, TRACER_KIND, type Gear, type GunKey, type Tracer } from '../net/gear';
import { Destruction, destructionTunables, inProcessRunner, type Crater, type DetonationRunner } from './destruction';

/** The uniform's colour, for the dust a round throws out of a body. */
const P_KHAKI = P.SOLDIER_KHAKI;
/** Kinds that throw sparks when struck. */
const METAL = new Set<number>([K.PICKET, K.HULL, K.CORRUGATE, K.WIRE]);
/** Voxels a body buried by the world's edits is lifted, at most, to stand on what came down (4 m at 10 cm). */
const LIFT_VOXELS = 40;
/** The shot's particles are anchored to the rifle's muzzle and port, which the renderer draws elsewhere (Particles.billboards). */
export const MUZZLE_ANCHOR = 1;
export const PORT_ANCHOR = 2;

/** The local player's body, among the bodies a round may strike. */
export const LOCAL_BODY = -1;

/** `Session.held` when the shovel is in the hands. */
export const SHOVEL_HELD = -1;

/** A gun carried: what it is with its fit (arsenal.ts), and its own weapon, recoil and kick. */
export interface Arm {
  spec: ArmSpec;
  weapon: Weapon;
  recoil: Recoil;
  viewKick: ViewKick;
}

/** The hands' times and the aim's terms (`[hands]`). */
export interface HandsTunables {
  lowerS: number;
  raiseS: number;
  pistolRaiseS: number;
  shovelRaiseS: number;
  adsRecoil: number;
  adsMove: number;
  adsSensitivity: number;
  strokeS: number;
}

export function handsTunables(tun: Tunables): HandsTunables {
  const f = (k: string) => tun.f(`hands.${k}`);
  return {
    lowerS: f('lower_s'),
    raiseS: f('raise_s'),
    pistolRaiseS: f('pistol_raise_s'),
    shovelRaiseS: f('shovel_raise_s'),
    adsRecoil: f('ads_recoil'),
    adsMove: f('ads_move'),
    adsSensitivity: f('ads_sensitivity'),
    strokeS: f('dig_stroke_s'),
  };
}

const SHOVEL_HOLDING: Holding = { kind: 'shovel', sight: { y: 0, z: 0.4 } };
const smooth = (t: number) => t * t * (3 - 2 * t);

/** Another player's body as drawn this frame, for rounds to strike: their seat, their parts' frames, their feet. */
export interface Body {
  id: number;
  frames: Record<PartName, Frame>;
  feet: readonly [number, number, number];
}

export function idleIntent(): MoveIntent {
  return { forward: 0, strafe: 0, jump: false, sprint: false, stance: Stance.STANDING, periscope: false, fire: false, reload: false, dig: false };
}

/** A tracer's colour as a loadout names it, from the pool's kind. */
function tracerName(kind: number): Tracer {
  return kind === TRACER_KIND.red ? 'red' : kind === TRACER_KIND.green ? 'green' : 'off';
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
  /** A player's shot's word (net/gear.ts ShotMark): its gun, its tracer's colour, whether suppressed. */
  mark?: number;
  /** The muzzle's flash and report, as shares of a bare gun's. */
  flash?: number;
  report?: number;
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
  /** Other players' shots, from their eyes, their tracers and flashes at their rifles' muzzles. */
  remoteShots: (ShotEvent & { owner: number })[];
  /** Rounds stopped by a body: whose, whose body (LOCAL_BODY the player's own), where struck. */
  hits: (BodyHit & { tick: number })[];
  /** Where rounds went into water, shells landed on it and their debris fell into it (metres), and with how much energy. */
  splashes: { tick: number; at: [number, number, number]; energyJ: number; kind: 'round' | 'shell' | 'debris' }[];
}

function noEvents(): CombatEvents {
  return { shots: [], frontShots: [], impacts: [], cracks: [], cuts: [], craters: [], incoming: [], blasts: [], scoops: [], splashes: [], remoteShots: [], hits: [] };
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
  /**
   * The guns carried (the long gun first) and the rounds in the air. What is in the hands is
   * `held`, an arm's index or SHOVEL_HELD; `weapon`, `recoil` and `viewKick` are the arm's in the
   * hands (with the shovel out, the gun it goes back to).
   */
  arms: Arm[];
  held = 0;
  readonly rounds: Rounds;
  /** The gun asked for (1, 2, the wheel): in the hands once the shovel is put away. */
  private wanted = 0;
  /** How far up what is held is (0 put away, 1 ready to use), and before the last tick. */
  ready = 1;
  private prevReady = 1;
  /** How far the sights are up (0 to 1, aimed), and before the last tick. */
  aimed = 0;
  private prevAimed = 0;
  /** The shovel's stroke as drawn while it is clearing (in turns, 0 to 1), and before the last tick; null at rest. */
  stroke: number | null = null;
  private prevStroke: number | null = null;
  /** The gun's light (or laser) switched on. */
  lightOn = false;
  /** The loadout taken in, if one was (the session's own default otherwise). */
  loadout: Loadout | null = null;
  readonly hands: HandsTunables;
  /** The player's suppression. */
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
  /**
   * Playing with others (the multiplayer spec's §4): rounds strike bodies, the others' (`bodies`,
   * set each frame) and the player's own. Off in solo play, which has no one to hit.
   */
  together = false;
  bodies: Body[] = [];
  /** Killed, the player does nothing until they are back in (`respawn`). */
  alive = true;
  /** The intent the tick acts on: the player's, or idle while dead. */
  private acting: MoveIntent = idleIntent();
  /** The player's own parts' frames, posed once a tick when a round may strike them. */
  private ownFrames: { tick: number; frames: Record<PartName, Frame> } | null = null;
  /** Ticks run. */
  ticks = 0;
  /** The last tick's shots: from the eye, their direction, the aim (yaw, pitch) before the cone, and whether each is a tracer. */
  readonly shots: { origin: [number, number, number]; dir: [number, number, number]; aim: [number, number]; tracer: boolean }[] = [];
  private readonly dispersion: Rng;
  private readonly recoilRng: Rng;
  private readonly viewKickRng: Rng;
  private readonly suppressionRng: Rng;
  /** Others' shotguns' pellets about their shot: drawn here, not by the shooter (cosmetic: hits are theirs to claim). */
  private readonly remoteRng: Rng;
  private readonly tun: Tunables;
  /** The front's rounds: the AK's, whatever the player carries. */
  private readonly frontProjectile: ProjectileSpec;
  /** Each gun's round, pellets and cone, as another player's shots are fired. */
  private readonly remoteGuns = new Map<GunKey, { spec: ProjectileSpec; pellets: number; coneDeg: number }>();
  private readonly chipEnergyJ: number;
  /** A shell's splash's energy, at a crater of 3 m: by the cube of its radius. */
  private readonly splashEnergyJ: number;
  /** A shell's debris thrown into water near it: over how many times its radius, how many points, each splash's energy, and how long the debris falls. */
  private readonly debris: { reach: number; samples: number; energyJ: number; fallS: [number, number] };
  /** Debris splashes due: when (the tick) and where (metres). */
  private debrisFalling: { tick: number; at: [number, number, number] }[] = [];
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
    this.tun = tun;
    this.hands = handsTunables(tun);
    // Until a loadout is taken in: the AK and the pistol, bare, the battle's amber tracers.
    this.arms = [armSpec(tun, 'ak74', BARE, 'amber'), armSpec(tun, 'm17', BARE, 'amber')].map((a) => this.makeArm(a, false));
    this.frontProjectile = projectileSpec(tun, 'assault_rifle');
    this.rounds = new Rounds(ballisticsTunables(tun), world.map, voxel);
    this.dispersion = this.streams.derive('combat.dispersion');
    this.recoilRng = this.streams.derive('combat.recoil');
    this.viewKickRng = this.streams.derive('combat.viewkick');
    this.suppressionRng = this.streams.derive('combat.suppression');
    this.remoteRng = this.streams.derive('combat.remote_pellets');
    this.chipEnergyJ = tun.f('destruction.chip_energy_j');
    this.splashEnergyJ = tun.f('artillery.splash_energy_j');
    this.debris = {
      reach: tun.f('artillery.debris_splash_reach'),
      samples: tun.i('artillery.debris_splash_samples'),
      energyJ: tun.f('artillery.debris_splash_j'),
      fallS: tun.pair('artillery.debris_fall_s'),
    };
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
    this.rounds.bodies = (owner, from, dir, length) => (this.together ? this.strikeBodies(owner, from, dir, length) : null);
  }

  /**
   * The nearest body a round of `owner` meets along a segment, short of `length` metres: the
   * player's own rounds the others'; another's (owner 2 + their seat) everyone's but their own,
   * the player's included; the front's (owner 1) the player's alone.
   */
  private strikeBodies(owner: number, from: readonly [number, number, number], dir: readonly [number, number, number], length: number): { t: number; body: number; zone: 'head' | 'torso' | 'limb' } | null {
    let best: { t: number; body: number; zone: 'head' | 'torso' | 'limb' } | null = null;
    const test = (id: number, frames: Record<PartName, Frame>, feet: readonly number[]) => {
      const { centre, radius } = bodySphere(feet);
      // The segment's nearest approach to the body's sphere: past it, no part is met.
      const along = Math.max(0, Math.min(length, (centre[0] - from[0]) * dir[0] + (centre[1] - from[1]) * dir[1] + (centre[2] - from[2]) * dir[2]));
      const near = hypot(from[0] + dir[0] * along - centre[0], from[1] + dir[1] * along - centre[1], from[2] + dir[2] * along - centre[2]);
      if (near > radius) return;
      const h = hitParts(frames, from, dir, best ? best.t : length);
      if (h && (!best || h.t < best.t)) best = { t: h.t, body: id, zone: h.zone };
    };
    if (owner !== 1) for (const b of this.bodies) if (b.id !== owner - 2) test(b.id, b.frames, b.feet);
    if (owner !== 0 && this.alive) test(LOCAL_BODY, this.ownBody(), this.player.position.toArray());
    return best;
  }

  /** The player's own parts' frames, as others draw them (soldier-rig.ts), this tick. */
  private ownBody(): Record<PartName, Frame> {
    if (this.ownFrames?.tick === this.ticks) return this.ownFrames.frames;
    const p = this.player;
    const frames = pose({ position: p.position.toArray(), yaw: p.yaw, pitch: p.pitch, height: p.height, speed: p.velocity.horizontalLength, bob: p.bobPhase, deadFor: null });
    this.ownFrames = { tick: this.ticks, frames };
    return frames;
  }

  /**
   * Another player's shot (owner 2 + their seat), from their eye along `dir`, its tracer and flash
   * at their rifle's `muzzle`; `mark`, its word (net/gear.ts): their gun's round, its tracer's
   * colour, and a shotgun's pellets spread about it here. Without one, the AK's, amber.
   */
  fireRemote(owner: number, origin: readonly [number, number, number], dir: readonly [number, number, number], tracer: boolean, muzzle: readonly [number, number, number], mark?: number): void {
    const m = mark === undefined ? null : decodeShotMark(mark);
    const gun = m ? this.remoteGun(m.gun) : { spec: this.frontProjectile, pellets: 1, coneDeg: 0 };
    const spec = gun.spec;
    const v = spec.muzzleVelocity;
    const kind = !tracer ? TRACER_KIND.none : m ? m.kind : TRACER_KIND.amber;
    const from: [number, number, number] = [muzzle[0], muzzle[1], muzzle[2]];
    if (this.rounds.fire([origin[0], origin[1], origin[2]], [dir[0] * v, dir[1] * v, dir[2] * v], spec, owner, kind, from) < 0) return;
    for (let k = 1; k < gun.pellets; k++) {
      const d = this.spreadAbout(dir, gun.coneDeg, this.remoteRng);
      this.rounds.fire([origin[0], origin[1], origin[2]], [d[0] * v, d[1] * v, d[2] * v], spec, owner, TRACER_KIND.none, from);
    }
    const flashShare = m?.suppressed ? 0.12 : 1;
    this.events.remoteShots.push({
      tick: this.ticks, owner, origin: [origin[0], origin[1], origin[2]], dir: [dir[0], dir[1], dir[2]], tracer, muzzle: from,
      ...(mark === undefined ? {} : { mark, flash: flashShare, report: m?.suppressed ? 0.3 : 1 }),
    });
    const { flash } = this.kinds;
    this.particles.emit(muzzle, [dir[0] * flash.speed, dir[1] * flash.speed + flash.lift, dir[2] * flash.speed], flash, Math.round(flash.count * flashShare), this.particleRng);
  }

  /** Another's gun as their shots need it: its round, its pellets and their cone (degrees). */
  private remoteGun(key: GunKey): { spec: ProjectileSpec; pellets: number; coneDeg: number } {
    let g = this.remoteGuns.get(key);
    if (!g) {
      const w = weaponSpec(this.tun, GUN_DEFS[key].table);
      g = { spec: w.projectile, pellets: w.pellets, coneDeg: w.dispersionMoa / 60 };
      this.remoteGuns.set(key, g);
    }
    return g;
  }

  /** A direction within `coneDeg` of unit `dir`, uniform over its disc. */
  private spreadAbout(dir: readonly number[], coneDeg: number, rng: Rng): [number, number, number] {
    const a = rng.uniform(0, TAU);
    const r = radians(coneDeg) * Math.sqrt(rng.float());
    // Two directions square to it: across it (level), and up from it.
    let ux = dir[2];
    let uz = -dir[0];
    const level = hypot(ux, uz);
    if (level < 1e-9) {
      ux = 1;
      uz = 0;
    } else {
      ux /= level;
      uz /= level;
    }
    const w = [dir[1] * uz, dir[2] * ux - dir[0] * uz, -dir[1] * ux];
    const d = [dir[0] + (ux * cos(a) + w[0] * sin(a)) * r, dir[1] + w[1] * sin(a) * r, dir[2] + (uz * cos(a) + w[2] * sin(a)) * r];
    const n = hypot(d[0], d[1], d[2]);
    return [d[0] / n, d[1] / n, d[2] / n];
  }

  /** A gun carried: its own weapon, recoil and kick; `tagged`, its rounds say which gun (for what their hits do). */
  private makeArm(spec: ArmSpec, tagged: boolean): Arm {
    const weapon = new Weapon(tagged ? { ...spec.weapon, projectile: { ...spec.weapon.projectile, gun: GUNS.indexOf(spec.gun.key) } } : spec.weapon);
    return { spec, weapon, recoil: new Recoil(spec.recoil), viewKick: new ViewKick(spec.viewKick) };
  }

  /** The arm in the hands, or (the shovel out) the one it goes back to. */
  get arm(): Arm {
    return this.arms[this.held === SHOVEL_HELD ? this.wanted : this.held];
  }

  get weapon(): Weapon {
    return this.arm.weapon;
  }

  get recoil(): Recoil {
    return this.arm.recoil;
  }

  get viewKick(): ViewKick {
    return this.arm.viewKick;
  }

  /** Take in `loadout`: its long gun and its pistol, full, the long gun in the hands and up. */
  equip(loadout: Loadout): void {
    this.loadout = loadout;
    this.arms = loadoutArms(this.tun, loadout).map((a) => this.makeArm(a, true));
    this.held = 0;
    this.wanted = 0;
    this.ready = this.prevReady = 1;
    this.aimed = this.prevAimed = 0;
    this.stroke = this.prevStroke = null;
    this.lightOn = false;
    this.prevKick = this.kick();
  }

  /** What the player shows the others (net/gear.ts): what is in their hands and its fit, their tracers, their light. */
  gear(): Gear {
    const s = this.arm.spec;
    return { gun: this.held === SHOVEL_HELD ? null : s.gun.key, fit: s.fit, tracer: tracerName(s.tracerKind), light: this.lightOn && s.fit.side !== 'none' };
  }

  /** What the hands hold, for their pose. */
  holding(): Holding {
    if (this.held === SHOVEL_HELD) return SHOVEL_HOLDING;
    const s = this.arm.spec;
    return { kind: s.gun.slot === 'secondary' ? 'pistol' : 'rifle', sight: s.sight };
  }

  /** The cone's half-angle now (degrees), as the next shot would be thrown: the stance's, the sights', the laser's and suppression's. */
  coneDeg(): number {
    const arm = this.arm;
    const stance = this.controller.t.stances[this.player.stance].swayScale;
    const hip = arm.spec.hipSpread * (this.lightOn && arm.spec.fit.side === 'laser' ? arm.spec.laserSpread : 1);
    return (arm.weapon.spec.dispersionMoa / 60) * stance * (hip + (arm.spec.adsSpread - hip) * this.aimed) * this.suppression.swayScale;
  }

  /** The sight's magnification, `alpha` of the way between the last two ticks: 1 from the hip. */
  zoomAt(alpha = this.clock.alpha): number {
    const aimed = this.prevAimed + (this.aimed - this.prevAimed) * alpha;
    return 1 + (this.arm.spec.zoom - 1) * smooth(Math.min(1, Math.max(0, aimed)));
  }

  /** Back in after being killed: at `position` (the foot, metres) facing `yaw`, armed and calm, the long gun in the hands. */
  respawn(position: readonly [number, number, number], yaw: number): void {
    this.teleport(position, yaw, 0);
    this.alive = true;
    for (const a of this.arms) {
      a.weapon.rearm();
      a.weapon.semi = false;
    }
    this.held = 0;
    this.wanted = 0;
    this.ready = this.prevReady = 1;
    this.aimed = this.prevAimed = 0;
    this.stroke = this.prevStroke = null;
    this.suppression.calm();
    this.digging = false;
  }

  /** A frame's real time, in seconds: runs the whole ticks it covers and returns how many. */
  advance(realDt: number): number {
    const ticks = this.clock.advance(realDt);
    for (let i = 0; i < ticks; i++) this.tick();
    return ticks;
  }

  tick(): void {
    this.ticks++;
    this.acting = this.alive ? this.intent : idleIntent();
    const p = this.player;
    // Aimed down the sights the player does not sprint.
    if (this.aimed > 0.5 && this.acting.sprint) this.acting = { ...this.acting, sprint: false };
    // Suppression as the last tick left it slows the feet and pins the player off the step; what
    // is in the hands, and the sights up, slow them too.
    const carried = this.held === SHOVEL_HELD ? 1 : this.arm.spec.move;
    p.speedScale = this.suppression.speedScale * carried * (1 + (this.hands.adsMove - 1) * this.aimed);
    p.pinned = this.suppression.pinned;
    const wasOnStep = p.stance === Stance.FIRING_STEP;
    this.prevPosition = p.position;
    this.prevView = this.view();
    this.prevKick = this.kick();
    this.prevRaised = this.raised;
    this.prevAimed = this.aimed;
    this.prevReady = this.ready;
    this.prevStroke = this.stroke;
    this.controller.tick(p, this.acting, this.clock.dt);
    if (wasOnStep && p.pinned && p.stance !== Stance.FIRING_STEP) this.ejected++;
    // To the shoulder on the firing step, over the parapet; down off it.
    const raise = p.stance === Stance.FIRING_STEP ? 1 : 0;
    this.raised += (raise - this.raised) * (1 - exp(-this.clock.dt / this.viewmodel.raiseS));
    this.dig(this.clock.dt);
    this.handle(this.clock.dt);
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
    this.digging = this.acting.dig && p.onGround && p.climbTo === null && p.stance !== Stance.PRONE && p.stance !== Stance.PERISCOPE;
    if (!this.digging) return;
    const scoop = this.entrenching.work(p.position.toArray(), p.yaw, dt, (box) => !this.destruction.overlapsOut(box));
    if (!scoop) return;
    this.events.scoops.push({ ...scoop, tick: this.ticks });
    this.liftOut();
  }

  /**
   * The hands, after the dig: the gun asked for (1, 2, the wheel), or the shovel while digging;
   * what is held comes down and the next comes up. Then the sights, up while the right button is
   * held and the gun is ready (not on the shovel, the periscope or a climb); the light (or laser)
   * switched; single shots or automatic; and the shovel's stroke while it clears.
   */
  private handle(dt: number): void {
    const a = this.acting;
    const p = this.player;
    const h = this.hands;
    if (a.swap !== undefined && a.swap >= 0 && a.swap < this.arms.length) this.wanted = a.swap;
    if (a.cycle) this.wanted = (this.wanted + 1) % this.arms.length;
    const target = this.digging ? SHOVEL_HELD : this.wanted;
    if (this.held !== target) {
      this.ready -= dt / h.lowerS;
      if (this.ready <= 0) {
        this.ready = 0;
        // Put away mid-reload, the reload is lost.
        if (this.held !== SHOVEL_HELD) this.arms[this.held].weapon.cancelReload();
        this.held = target;
      }
    } else if (this.ready < 1) {
      const raise = this.held === SHOVEL_HELD ? h.shovelRaiseS : this.arm.spec.gun.slot === 'secondary' ? h.pistolRaiseS : h.raiseS;
      this.ready = Math.min(1, this.ready + dt / raise);
    }
    const spec = this.arm.spec;
    const canAim = a.aim === true && this.alive && this.held !== SHOVEL_HELD && this.ready >= 1 && !this.digging && p.stance !== Stance.PERISCOPE && p.climbTo === null;
    if (canAim) this.aimed = Math.min(1, this.aimed + dt / spec.adsTimeS);
    else if (this.aimed > 0) this.aimed = Math.max(0, this.aimed - dt / (spec.adsTimeS * 0.8));
    if (a.light && spec.fit.side !== 'none') this.lightOn = !this.lightOn;
    if (a.mode && this.held !== SHOVEL_HELD) this.arm.weapon.toggleMode();
    this.stroke = this.digging && this.held === SHOVEL_HELD && this.ready >= 1 && this.entrenching.inReach ? ((this.stroke ?? 0) + dt / h.strokeS) % 1 : null;
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
    const arm = this.arm;
    const w = arm.weapon;
    const p = this.player;
    const stance = this.controller.t.stances[p.stance].swayScale * (this.digging ? this.entrenching.t.swayScale : 1);
    // The cone: from the hip (a laser switched on tightens it) toward its share aimed.
    const hip = arm.spec.hipSpread * (this.lightOn && arm.spec.fit.side === 'laser' ? arm.spec.laserSpread : 1);
    const sway = stance * (hip + (arm.spec.adsSpread - hip) * this.aimed);
    w.tick(dt);
    // Aimed, the recoil is steadier.
    this.recoil.scale = stance * (1 + (this.hands.adsRecoil - 1) * this.aimed);
    for (const a of this.arms) {
      a.recoil.tick(dt);
      a.viewKick.tick(dt);
    }
    this.suppression.tick(dt);
    this.blastShake.tick(dt);
    const inHand = this.held !== SHOVEL_HELD && this.ready >= 1 && !this.digging;
    if (this.acting.reload && this.held !== SHOVEL_HELD) w.beginReload();
    const eye: [number, number, number] = [p.position.x, p.position.y + this.controller.eyeHeight(p), p.position.z];
    // No shot with the shovel in the hands, a gun not yet up, or through the periscope.
    if (w.wants(this.acting.fire && p.stance !== Stance.PERISCOPE && inHand)) {
      const aim: [number, number] = [p.yaw + this.recoil.yaw + this.suppression.flinchYaw, p.pitch + this.recoil.pitch + this.suppression.flinchPitch];
      const cone = sway * this.suppression.swayScale;
      const dir = w.aim(aim[0], aim[1], cone, this.dispersion);
      const projectile = w.spec.projectile;
      const v = projectile.muzzleVelocity;
      const kind = w.tracer() ? arm.spec.tracerKind : TRACER_KIND.none;
      const tracer = kind !== TRACER_KIND.none;
      // The round leaves the eye, so the reticle tells the truth; its tracer, flash and brass the
      // drawn rifle, as it stands before this shot kicks it.
      const muzzle = this.muzzle();
      if (this.rounds.fire(eye, [dir[0] * v, dir[1] * v, dir[2] * v], projectile, 0, kind, muzzle) >= 0) {
        // A shotgun's other pellets, each the cone's own.
        for (let k = 1; k < w.spec.pellets; k++) {
          const d = w.aim(aim[0], aim[1], cone, this.dispersion);
          this.rounds.fire(eye, [d[0] * v, d[1] * v, d[2] * v], projectile, 0, TRACER_KIND.none, muzzle);
        }
        w.shot();
        this.throwShot(muzzle, arm.spec.flash);
        const kick = this.recoil.kickPitch;
        this.recoil.shot(this.recoilRng);
        this.viewKick.shot(this.recoil.kickPitch - kick, this.viewKickRng);
        this.shots.push({ origin: eye, dir, aim, tracer });
        const mark = encodeShotMark({ tracer, kind, suppressed: arm.spec.suppressed, gun: arm.spec.gun.key });
        this.events.shots.push({ tick: this.ticks, origin: eye, dir, tracer, muzzle, mark, flash: arm.spec.flash, report: arm.spec.report });
      }
    }
    this.rounds.listen(eye, this.suppression.t.crackRadiusM);
    this.rounds.step(dt);
    // Suppression counts every substep a round was near (milestone 2's ruling); the ear hears each
    // round once, where it passed nearest.
    for (const c of this.rounds.cracks) this.suppression.crack(c.missM, this.suppressionRng);
    for (const c of this.rounds.passes) this.events.cracks.push({ tick: this.ticks, missM: c.missM, at: c.at });
    for (const w of this.rounds.splashes) this.events.splashes.push({ tick: this.ticks, at: w.position, energyJ: w.energyJ, kind: 'round' });
    if (this.debrisFalling.length > 0) {
      for (const f of this.debrisFalling) if (f.tick <= this.ticks) this.events.splashes.push({ tick: this.ticks, at: f.at, energyJ: this.debris.energyJ, kind: 'debris' });
      this.debrisFalling = this.debrisFalling.filter((f) => f.tick > this.ticks);
    }
    // Rounds into bodies: a puff of the uniform's dust where each struck.
    for (const hit of this.rounds.bodyHits) {
      this.events.hits.push({ ...hit, tick: this.ticks });
      const { dust } = this.kinds;
      this.particles.emit(hit.position, [-hit.dir[0] * dust.speed, dust.lift, -hit.dir[2] * dust.speed], dust, dust.count, this.particleRng, this.tints[P_KHAKI]);
    }
    for (const hit of this.rounds.impacts) {
      this.destruction.mark(hit.cell[0], hit.cell[1], hit.cell[2], hit.energyJ, this.chipEnergyJ);
      if (hit.owner !== 0) this.suppression.impact(hypot(hit.position[0] - eye[0], hit.position[1] - eye[1], hit.position[2] - eye[2]));
      this.events.impacts.push({ ...hit, tick: this.ticks });
      this.throwImpact(hit);
    }
    // The front's rounds are the ones its tick adds to the pool, the last in it.
    const fired = this.front.tick(dt, eye, this.rounds, this.frontProjectile);
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
    if (kindOf(material) === K.WATER) {
      const k = radiusM / 3;
      this.events.splashes.push({ tick: this.ticks, at, energyJ: this.splashEnergyJ * k * k * k, kind: 'shell' });
    } else this.throwDebrisIn(x, z, radiusM, seed);
    this.throwBlast(at, material);
    const p = this.player;
    const d = hypot(at[0] - p.position.x, at[1] - (p.position.y + this.controller.eyeHeight(p)), at[2] - p.position.z);
    this.blastShake.kick(d);
    this.suppression.blast(d);
    return id;
  }

  /**
   * A shell's debris falling into water near it (the battle spec's §6: debris rings water too): the
   * particles are cosmetic and never meet the world, so the shell itself throws `debris_splash_samples`
   * points over a disc of `debris_splash_reach` times its radius, drawn from its own seed, and each
   * that falls on water splashes there once the debris has fallen (`debris_fall_s`).
   */
  private throwDebrisIn(x: number, z: number, radiusM: number, seed: number): void {
    const d = this.debris;
    const v = this.voxel;
    const rng = Rng.root(seed).derive('combat.debris_splashes');
    const reach = d.reach * radiusM;
    for (let k = 0; k < d.samples; k++) {
      const a = rng.uniform(0, TAU);
      const r = reach * Math.sqrt(rng.float());
      const fall = rng.uniform(d.fallS[0], d.fallS[1]);
      const px = x + r * cos(a);
      const pz = z + r * sin(a);
      const top = groundTop(this.map, px / v, pz / v);
      if (top === null || kindOf(this.map.get(Math.floor(px / v), top - 1, Math.floor(pz / v))) !== K.WATER) continue;
      this.debrisFalling.push({ tick: this.ticks + Math.max(1, Math.round(fall / this.clock.dt)), at: [px, top * v, pz] });
    }
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

  /** A shot's flash out along the bore from the muzzle (`share` of it: a suppressor's wisp), and its brass out of the port, to the right and up (the reference's view kick). */
  private throwShot(muzzle: readonly number[], share = 1): void {
    const p = this.player;
    const view = this.view();
    const { forward, right, up } = viewBasis(p.yaw + view.yaw, p.pitch + view.pitch, view.roll);
    const along = (spec: ParticleSpec, d: readonly number[]) => [0, 1, 2].map((k) => d[k] * spec.speed + up[k] * spec.lift);
    const { flash, brass } = this.kinds;
    this.particles.emit(muzzle, along(flash, forward), flash, Math.round(flash.count * share), this.particleRng, undefined, MUZZLE_ANCHOR);
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
    const aimed = this.prevAimed + (this.aimed - this.prevAimed) * alpha;
    const ready = this.prevReady + (this.ready - this.prevReady) * alpha;
    // The stroke round its turn: a wrap from the end of one to the next is a step forward.
    let stroke = this.stroke;
    if (stroke !== null && this.prevStroke !== null) {
      const to = stroke < this.prevStroke ? stroke + 1 : stroke;
      stroke = this.prevStroke + (to - this.prevStroke) * alpha;
    }
    return heldPose(this.viewmodel, this.holding(), { back: at('back'), up: at('up'), side: at('side'), pitch: at('pitch'), yaw: at('yaw'), roll: at('roll') }, sway, speedRatio, raised, aimed, ready, stroke);
  }

  /** The gun's muzzle in world metres, as the last tick left the view, the kick and the hands: where the flash and the tracers start. */
  muzzle(): [number, number, number] {
    return this.rifleToWorld(this.arm.spec.muzzle);
  }

  /** The gun's ejection port in world metres: where the brass leaves. */
  port(): [number, number, number] {
    return this.rifleToWorld(this.arm.spec.port);
  }

  /** A rifle point (model metres) in the world, from the eye along the view with its offsets; the walk's sway and dip (a centimetre) are the camera's. */
  private rifleToWorld(point: readonly number[]): [number, number, number] {
    const p = this.player;
    const view = this.view();
    const { forward, right, up } = viewBasis(p.yaw + view.yaw, p.pitch + view.pitch, view.roll);
    const v = modelToView(heldPose(this.viewmodel, this.holding(), this.kick(), 0, 0, this.raised, this.aimed, this.ready, this.stroke), point);
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
    p.embedded = 0;
    p.bobPhase = 0;
    this.prevPosition = p.position;
  }
}
