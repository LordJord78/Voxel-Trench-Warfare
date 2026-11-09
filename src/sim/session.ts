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
import { armSpec, attachmentTerms, GUN_DEFS, loadoutArms, type ArmSpec, type Loadout } from '../combat/arsenal';
import { aimRangeM, ballisticsTunables, projectileSpec, Rounds, type BodyHit, type Impact, type ProjectileSpec } from '../combat/ballistics';
import { BlastShake, blastShakeTunables } from '../combat/blast-shake';
import { applyScoop, Entrenching, entrenchingTunables, scoopBox, type Scoop } from '../combat/entrenching';
import { Front, frontTunables, planSource, type FrontSight, type FrontSource } from '../combat/front';
import { blastHarm, frontHarm, harmTunables, type HarmTunables } from '../combat/harm';
import { gunClass, Handling, handlingTunables, ZERO_HANDS, type HandlingCue } from '../combat/handling';
import { particleSpec, Particles, type ParticleSpec } from '../combat/particles';
import { Recoil } from '../combat/recoil';
import { bodySphere, CHEST, hitParts, pose, toWorld, type Frame, type PartName, type V3 } from '../combat/soldier-rig';
import { Suppression, suppressionTunables } from '../combat/suppression';
import { ViewKick } from '../combat/viewkick';
import { heldPose, modelToView, viewBasis, viewmodelTunables, type Holding, type ViewmodelKick, type ViewmodelPose, type ViewmodelTunables } from '../combat/viewmodel';
import { pelletDirs, pelletSeed, Weapon, weaponSpec } from '../combat/weapon';
import { FixedClock } from '../core/clock';
import { cos, exp, hypot, sin, TAU } from '../core/dmath';
import { hash32 } from '../core/hash';
import { Rng } from '../core/rng';
import type { Tunables } from '../core/tunables';
import { CharacterController, controllerTunables, letGoOfLedge, newCharacter, sprints, Stance, type CharacterState, type MoveIntent } from '../physics/character';
import { boxHitsSolid } from '../physics/collision';
import { brickGrid } from '../physics/grid';
import { Vec3, ZERO } from '../physics/vec';
import type { BrickMap } from '../world/bricks';
import type { WorldPlan } from '../world/generation/plan';
import { K, kindOf, P, paletteData } from '../world/materials';
import { groundTop, raycast } from '../world/raycast';
import type { Box } from '../world/region';
import { spatter, spatterTunables, type SpatterTunables } from '../world/spatter';
import { BARE, decodeShotMark, encodeShotMark, GUNS, stepShare, teamTracer, TRACER_KIND, type Gear, type GunKey } from '../net/gear';
import { sent, type Team } from '../net/protocol';
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

/** A body as drawn this frame, for rounds to strike: another player's (their seat) or a target's (200 on), its parts' frames, its feet. */
export interface Body {
  id: number;
  frames: Record<PartName, Frame>;
  feet: readonly [number, number, number];
}

export function idleIntent(): MoveIntent {
  return { forward: 0, strafe: 0, jump: false, sprint: false, stance: Stance.STANDING, periscope: false, fire: false, reload: false, dig: false };
}

/**
 * How the rifle and suppression turn the view, in degrees: recoil and the flinch (yaw, pitch), the
 * shakes of suppression and a blast (pitch, roll), the view kick's pulse of the field of view, and
 * its camera's roll and a shot's shake (pitch, yaw, and `shake`, the eye moved, in metres along the
 * world's axes). Every round leaves the eye along the player's view plus recoil and the flinch alone:
 * the rest is the camera's.
 */
export interface ViewOffsets {
  yaw: number;
  pitch: number;
  roll: number;
  fov: number;
  shake: [number, number, number];
}

/** A shot, from where it left along its direction (unit), whether it is a tracer, and the muzzle it flashed at; `tick` is the session's tick that fired it. */
export interface ShotEvent {
  tick: number;
  origin: [number, number, number];
  dir: [number, number, number];
  tracer: boolean;
  /** The player's: the drawn rifle's (they leave from the eye); the front's: the origin. */
  muzzle: [number, number, number];
  /** A player's shot's word (net/gear.ts ShotMark): its gun, its tracer's colour, whether suppressed, a pellet gun's pattern's share. */
  mark?: number;
  /** The muzzle's flash and report, as shares of a bare gun's. */
  flash?: number;
  report?: number;
  /** The player's, in a room: the shot's words (net/protocol.ts sent), which its origin and direction are, as every other client flies it. */
  wire?: number[];
}

/**
 * What the battle did to the player in a room (combat/harm.ts), which the page tells the room as a
 * hurt: a blast's by its distance and cover, or the front's round by its zone.
 */
export interface Harm {
  tick: number;
  amount: number;
  cause: 'shell' | 'round';
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
  /** Shells landed: where, how big, what they struck, the crater each made (null where none could be), and the seed it was cut with. */
  blasts: { tick: number; at: [number, number, number]; radiusM: number; material: number; crater: number | null; seed?: number }[];
  /** Each scoop the player dug: how many voxels, and where (metres). */
  scoops: (Scoop & { tick: number })[];
  /** Other players' shots, from their eyes, their tracers and flashes at their rifles' muzzles. */
  remoteShots: (ShotEvent & { owner: number })[];
  /**
   * Rounds stopped by a body: whose, whose body (LOCAL_BODY the player's own, a target's its id),
   * where struck; the player's say the pull they left on (`shot`: that shot event's tick).
   */
  hits: (BodyHit & { tick: number })[];
  /** Where rounds went into water, shells landed on it and their debris fell into it (metres), and with how much energy. */
  splashes: { tick: number; at: [number, number, number]; energyJ: number; kind: 'round' | 'shell' | 'debris' }[];
  /** What the hands did that is heard (handling.ts): a reload's marks, the pump, an empty trigger's click; each at the gun's muzzle as its tick left it (`muzzle()`). */
  handling: { tick: number; cue: HandlingCue; at: [number, number, number] }[];
  /** In a room, the battle's harm to the player: each a hurt for the room. */
  harms: Harm[];
}

function noEvents(): CombatEvents {
  return { shots: [], frontShots: [], impacts: [], cracks: [], cuts: [], craters: [], incoming: [], blasts: [], scoops: [], splashes: [], remoteShots: [], hits: [], handling: [], harms: [] };
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
  /** The player's landing speed (m/s) before the last tick: the eye's dip is drawn between it and the latest (landingDipAt). */
  prevLandingImpact = 0;
  /**
   * How far the player's foot has risen (metres; a fall's negative) at its own speed over the ticks
   * run, now and as the tick before the last left it: each tick its velocity by the tick's time, but a
   * landing tick its drop, the fall and the ground's catch that ends it (the landing leaves the body at
   * a standstill, so its velocity explains none of it: the drop is at the speed it came down at), and
   * never a rise: a landing comes down. A step's snap is not in it, nor is one taken on the landing
   * tick itself: a lip up to [player] air_step_up stepped up onto in the air as the fall meets it, a
   * settle's lift of a body put into the ground, the controller's unstick. Nor are a climb, a lift out
   * of the ground (liftOut) or a teleport (a teleport holds it where the frames between ticks showed
   * it). The camera explains every frame's motion by it, a takeoff's and a landing's too, not as a
   * step, and eases what it has not as it eases any step (camera-rig.ts).
   */
  risen = 0;
  prevRisen = 0;
  /** The tick the player last came down on (its landing speed rising: a fall's end), or -1 (none since a teleport). */
  landedTick = -1;
  /** The view's offsets before the last tick. */
  private prevView: ViewOffsets;
  /** The view's roll, from every source, is held within this (degrees; [camera] roll_max_deg). */
  private readonly rollMaxDeg: number;
  /** The eye's dip on a hard landing (metres; [camera] landing_dip): the camera's, which carries the drawn gun, and so the muzzle. */
  private readonly landingDip: number;
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
  /**
   * The gun in the hands moving as a held gun does (handling.ts): its bob, sway, breathing, sprint,
   * landing, reload and pump. Ticked after the hands and before combat, drawn between ticks.
   */
  readonly handling: Handling;
  /**
   * The hands held still: what is held is drawn, and its muzzle and port placed, without the hands'
   * motion (ZERO_HANDS), as before it, for a test that pins a pose. The sprint's rule and the cues run on.
   */
  handsStill = false;
  /** The view's yaw and pitch as the last tick left them: the next tick's turn is from here. */
  private look: [number, number];
  /** The trigger as the last tick had it in the hands (a press is its rising), and an empty trigger's reload: its tick, and its gun. */
  private triggerWas = false;
  private dryReload: { tick: number; weapon: Weapon } | null = null;
  /**
   * A press the gun could not take yet: one the sprint alone held back, the gun still swung low. It
   * stands until the gun takes it, dropping the sprint while the gun is up; a climb (the hands on the
   * parapet, which wait out only a press held through it) or a gun put down lets it go.
   */
  private pressWaiting = false;
  /** The hands' cues heard this tick: each is placed at the muzzle as the tick leaves it. */
  private heard: HandlingCue[] = [];
  /** The gun's light (or laser) switched on. */
  lightOn = false;
  /** The loadout taken in, if one was (the session's own default otherwise). */
  loadout: Loadout | null = null;
  readonly hands: HandsTunables;
  /** The player's suppression. */
  readonly suppression: Suppression;
  /** The enemy line's incoming fire. */
  readonly front: Front;
  /** Which side's front line it fires from (frontFrom): the enemy's, side 1, until it is set. */
  frontSide: 0 | 1 = 1;
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
  /**
   * In a room's match (the shared-battle spec): its shells are cut on the ground where their craters
   * go out, and the battle harms the player (`harms`); the front fires to hurt, over the crest at a
   * head it cannot see, and its rounds chip nothing. Together sets it each frame; off in solo play.
   */
  room = false;
  /**
   * In a room, ground a shell heard and not yet landed would take (sim/room-battle.ts reserves, which
   * its battle sets here): the player's own scoop waits while its box is, as while a crater is
   * pending there. Nothing solo.
   */
  reserved: (box: Box) => boolean = () => false;
  /**
   * The player's seat in the room's match (Together sets it each frame); −1 solo. With the tick it
   * left on it seeds a shot's pellets (combat/weapon.ts pelletSeed), as every other client seeds them
   * from the shot's owner.
   */
  seat = -1;
  bodies: Body[] = [];
  /**
   * The range's dummies (the shots spec's §5), set each frame: bodies only the player's rounds
   * strike. Up in solo, they stop no one else's round, and no round stops at the player's own body.
   */
  targets: Body[] = [];
  /** Killed, the player does nothing until they are back in (`respawn`). */
  alive = true;
  /** The intent the tick acts on: the player's, or idle while dead. */
  private acting: MoveIntent = idleIntent();
  /** The player's own parts' frames, posed once a tick when a round may strike them. */
  private ownFrames: { tick: number; frames: Record<PartName, Frame> } | null = null;
  /** Ticks run. */
  ticks = 0;
  /** The side the player fires for: their rounds are its colour (solo plays Red's). */
  team: Team = 'red';
  /** The last tick's shots: from the eye, their direction, the aim (yaw, pitch) before the cone, and whether each is a tracer. */
  readonly shots: { origin: [number, number, number]; dir: [number, number, number]; aim: [number, number]; tracer: boolean }[] = [];
  private readonly dispersion: Rng;
  private readonly recoilRng: Rng;
  private readonly viewKickRng: Rng;
  /** The view kick's camera, its roll's side and its shake: a stream of its own, so drawing them shifts no other. */
  private readonly cameraRng: Rng;
  private readonly suppressionRng: Rng;
  private readonly tun: Tunables;
  /** The front's rounds: the AK's, whatever the player carries. */
  private readonly frontProjectile: ProjectileSpec;
  /** A shooter's tracer joins its round's path where the shot was aimed, within these (m; [effects] tracer_converge_min_m, _max_m). */
  private readonly tracerConverge: [number, number];
  /** The player's tracer is lit in over this from the hip and this aimed, between by the share aimed (m; [effects] tracer_ignite_hip_m, tracer_ignite_m). */
  private readonly tracerIgnite: [number, number];
  /** Each gun's round (bare, or suppressed), pellets and cone, as another player's shots are fired. */
  private readonly remoteGuns = new Map<string, { spec: ProjectileSpec; pellets: number; coneDeg: number }>();
  /** A suppressor's share of its gun's muzzle velocity ([attachment.suppressor] velocity). */
  private readonly suppressorVelocity: number;
  private readonly chipEnergyJ: number;
  /** A shell's splash's energy, at a crater of 3 m: by the cube of its radius. */
  private readonly splashEnergyJ: number;
  /** [room_battle]'s harm: a blast's and the front's round's on the player, in a room. */
  private readonly harmT: HarmTunables;
  /** In a room, what the front's muzzles see of the player's head: the session's sight. */
  private readonly frontSight: FrontSight = (from, to) => this.sight(from, to);
  /** A shell's debris thrown into water near it: over how many times its radius, how many points, each splash's energy, and how long the debris falls. */
  private readonly debris: { reach: number; samples: number; energyJ: number; fallS: [number, number] };
  /** Debris splashes due: when (the tick) and where (metres). */
  private debrisFalling: { tick: number; at: [number, number, number] }[] = [];
  private events: CombatEvents = noEvents();
  private readonly particleRng: Rng;
  private readonly kinds: Record<'flash' | 'brass' | 'dust' | 'spark' | 'blastFlash' | 'soil' | 'debris' | 'blood' | 'mist', ParticleSpec>;
  /** [hits]: a critical hit's droplets and mist, a helmet's sparks, and how many rounds a body bleeds (and its head spatters) a tick at most. */
  private readonly bleeding: { criticalDroplets: number; criticalMist: number; helmetSparks: number; burstsPerTick: number };
  /** [hits]: a critical hit's spatter, its rays on along the round and falling, their cones and reaches (in voxels), and how they pack. */
  private readonly spattering: SpatterTunables;
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
    // Until a loadout is taken in: the AK and the pistol, bare.
    this.arms = [armSpec(tun, 'ak74', BARE), armSpec(tun, 'm17', BARE)].map((a) => this.makeArm(a, false));
    this.frontProjectile = projectileSpec(tun, 'assault_rifle');
    this.tracerConverge = [tun.f('effects.tracer_converge_min_m'), tun.f('effects.tracer_converge_max_m')];
    this.tracerIgnite = [tun.f('effects.tracer_ignite_hip_m'), tun.f('effects.tracer_ignite_m')];
    this.rounds = new Rounds(ballisticsTunables(tun), world.map, voxel);
    this.dispersion = this.streams.derive('combat.dispersion');
    this.recoilRng = this.streams.derive('combat.recoil');
    this.viewKickRng = this.streams.derive('combat.viewkick');
    this.cameraRng = this.streams.derive('combat.viewkick.camera');
    this.suppressionRng = this.streams.derive('combat.suppression');
    this.chipEnergyJ = tun.f('destruction.chip_energy_j');
    this.suppressorVelocity = attachmentTerms(tun, 'suppressor').velocity;
    this.splashEnergyJ = tun.f('artillery.splash_energy_j');
    this.harmT = harmTunables(tun);
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
    this.rollMaxDeg = tun.f('camera.roll_max_deg');
    this.landingDip = tun.f('camera.landing_dip');
    this.prevView = this.view();
    this.viewmodel = viewmodelTunables(tun);
    this.prevKick = this.kick();
    this.handling = new Handling(handlingTunables(tun));
    this.look = [this.player.yaw, this.player.pitch];
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
      blood: particleSpec(tun, 'blood'),
      mist: particleSpec(tun, 'blood_mist'),
    };
    this.bleeding = {
      criticalDroplets: tun.i('hits.critical_droplets'),
      criticalMist: tun.i('hits.critical_mist'),
      helmetSparks: tun.i('hits.helmet_sparks'),
      burstsPerTick: tun.i('hits.bursts_per_tick'),
    };
    this.spattering = spatterTunables(tun, voxel);
    const palette = paletteData();
    this.tints = Array.from({ length: 256 }, (_, id) => [palette[id * 8], palette[id * 8 + 1], palette[id * 8 + 2]]);
    const waterTable = world.waterTable ?? world.plan?.params.waterTable ?? -1;
    this.destruction = new Destruction(world.map, world.runner ?? inProcessRunner(), destructionTunables(tun, waterTable));
    this.entrenching = new Entrenching(world.map, entrenchingTunables(tun), voxel, waterTable);
    this.artillery = new Artillery(artilleryTunables(tun), world.shells ?? (plan ? planShellSource(plan) : () => null), this.streams.derive('combat.shells'));
    this.rounds.bodies = (owner, from, dir, length) => (this.together || this.targets.length > 0 ? this.strikeBodies(owner, from, dir, length) : null);
  }

  /**
   * The nearest body a round of `owner` meets along a segment, short of `length` metres. The
   * targets, the player's rounds alone, with others or in solo. With others besides: the player's
   * rounds the others' bodies; another's (owner 2 + their seat) everyone's but their own, the
   * player's included; the front's (owner 1) the player's alone. Solo, there is no one else to hit.
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
    if (this.together && owner !== 1) for (const b of this.bodies) if (b.id !== owner - 2) test(b.id, b.frames, b.feet);
    if (owner === 0) for (const b of this.targets) test(b.id, b.frames, b.feet);
    if (this.together && owner !== 0 && this.alive) test(LOCAL_BODY, this.ownBody(), this.player.position.toArray());
    return best;
  }

  /**
   * The front fires from `side`'s front line (combat/front.ts planSource): in a room, the line
   * across from the player's team (side 1 at Red, side 0 at Blue); side 1 again for solo play.
   * Without a plan its source stays as it is.
   */
  frontFrom(side: 0 | 1): void {
    if (this.plan) this.front.source = planSource(this.plan, this.front.t.reachM, side);
    this.frontSide = side;
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
   * at their rifle's `muzzle`; `mark`, its word (net/gear.ts): their gun's round, at a suppressor's
   * velocity if it says so, its tracer's colour, and a shotgun's pellets, spread about the first by
   * the gun's cone times the share the word carries, from the shot's seed (combat/weapon.ts
   * pelletSeed: their seat and `tick`, the tick it left on), as the shooter spread them. Without one,
   * the AK's, amber. `kind`, where given, is the tracer's colour whatever the mark says (their seat's
   * team); a shot that is not a tracer draws none. Every pellet takes the shot's kind.
   */
  fireRemote(owner: number, origin: readonly [number, number, number], dir: readonly [number, number, number], tracer: boolean, muzzle: readonly [number, number, number], mark?: number, kind?: number, tick = 0): void {
    const m = mark === undefined ? null : decodeShotMark(mark);
    const gun = m ? this.remoteGun(m.gun, m.suppressed) : { spec: this.frontProjectile, pellets: 1, coneDeg: 0 };
    const spec = gun.spec;
    const v = spec.muzzleVelocity;
    const round = !tracer ? TRACER_KIND.none : kind ?? (m ? m.kind : TRACER_KIND.amber);
    const from: [number, number, number] = [muzzle[0], muzzle[1], muzzle[2]];
    const reach = this.aimRange(owner, origin, dir);
    // Lit in as the draw's own (a hip shot's): a shot's word does not say how far its shooter had
    // aimed, and a pellet gun's share in it is its pattern's, not the sights'.
    const drawn = { from, convergeM: reach };
    if (this.rounds.fire([origin[0], origin[1], origin[2]], [dir[0] * v, dir[1] * v, dir[2] * v], spec, owner, round, drawn) < 0) return;
    for (const d of pelletDirs(dir, gun.pellets - 1, gun.coneDeg * (m ? m.share : 1), pelletSeed(owner - 2, tick))) {
      this.rounds.fire([origin[0], origin[1], origin[2]], [d[0] * v, d[1] * v, d[2] * v], spec, owner, round, drawn);
    }
    const flashShare = m?.suppressed ? 0.12 : 1;
    this.events.remoteShots.push({
      tick: this.ticks, owner, origin: [origin[0], origin[1], origin[2]], dir: [dir[0], dir[1], dir[2]], tracer, muzzle: from,
      ...(mark === undefined ? {} : { mark, flash: flashShare, report: m?.suppressed ? 0.3 : 1 }),
    });
    const { flash } = this.kinds;
    this.particles.emit(muzzle, [dir[0] * flash.speed, dir[1] * flash.speed + flash.lift, dir[2] * flash.speed], flash, Math.round(flash.count * flashShare), this.particleRng);
  }

  /**
   * Another's gun as their shots need it: its round, at the suppressor's velocity when `suppressed`
   * (as the shooter's own flies: combat/arsenal.ts armSpec), its pellets and the gun's own cone
   * (degrees), which, times the share their shot's word carries, they spread over about the first.
   * Its rounds say which gun they left (BodyHit.gun), so a round of theirs into the player is felt by
   * its damage.
   */
  private remoteGun(key: GunKey, suppressed: boolean): { spec: ProjectileSpec; pellets: number; coneDeg: number } {
    const name = suppressed ? `${key}+suppressor` : key;
    let g = this.remoteGuns.get(name);
    if (!g) {
      const w = weaponSpec(this.tun, GUN_DEFS[key].table);
      const muzzleVelocity = suppressed ? w.projectile.muzzleVelocity * this.suppressorVelocity : w.projectile.muzzleVelocity;
      g = { spec: { ...w.projectile, muzzleVelocity, gun: GUNS.indexOf(key) }, pellets: w.pellets, coneDeg: w.dispersionMoa / 60 };
      this.remoteGuns.set(name, g);
    }
    return g;
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
    // A press waiting out a sprint was made for the last gun: none fires the new one. And the hands
    // start clean: no sprint, sway, landing or reload, and no pump to come from the last gun's shot.
    this.pressWaiting = false;
    this.handling.reset();
  }

  /** What the player shows the others (net/gear.ts): what is in their hands and its fit, their light. */
  gear(): Gear {
    const s = this.arm.spec;
    return { gun: this.held === SHOVEL_HELD ? null : s.gun.key, fit: s.fit, light: this.lightOn && s.fit.side !== 'none' };
  }

  /** What the hands hold, for their pose. */
  holding(): Holding {
    if (this.held === SHOVEL_HELD) return SHOVEL_HOLDING;
    const s = this.arm.spec;
    return { kind: s.gun.slot === 'secondary' ? 'pistol' : 'rifle', sight: s.sight };
  }

  /**
   * The cone's half-angle now (degrees), as the next shot would be thrown: the gun's, times the
   * stance's, the sights', the laser's and suppression's share. A pellet gun's is its pattern's, the
   * share put to the step its shot's word would carry (net/gear.ts stepShare), as its pellets fly.
   */
  coneDeg(): number {
    const arm = this.arm;
    const stance = this.controller.t.stances[this.player.stance].swayScale;
    const hip = arm.spec.hipSpread * (this.lightOn && arm.spec.fit.side === 'laser' ? arm.spec.laserSpread : 1);
    const share = stance * (hip + (arm.spec.adsSpread - hip) * this.aimed) * this.suppression.swayScale;
    return (arm.weapon.spec.dispersionMoa / 60) * (arm.weapon.spec.pellets > 1 ? stepShare(share) : share);
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
    // Nor does one from the last life: a match's end and the next one's deploy run no tick between.
    // Nor do the last life's hands.
    this.pressWaiting = false;
    this.handling.reset();
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
    // Firing (a press waiting to be taken as well), aiming or aimed down the sights the player does
    // not sprint. The trigger and the sights are a gun's: a button, or a press waiting, drops the
    // sprint only while a gun is up to take it (gunUp, as the trigger and the sights have it: the
    // shovel out, digging, the periscope up or a climb under way, it does not, so a press held through
    // a climb holds the sprint off only once the climb is over), the hands as the last tick left them.
    if ((((this.acting.fire || this.acting.aim === true || this.pressWaiting) && this.gunUp(p)) || this.aimed > 0.5) && this.acting.sprint) this.acting = { ...this.acting, sprint: false };
    // Suppression as the last tick left it slows the feet and pins the player off the step; what
    // is in the hands, and the sights up, slow them too.
    const carried = this.held === SHOVEL_HELD ? 1 : this.arm.spec.move;
    p.speedScale = this.suppression.speedScale * carried * (1 + (this.hands.adsMove - 1) * this.aimed);
    p.pinned = this.suppression.pinned;
    const wasOnStep = p.stance === Stance.FIRING_STEP;
    this.prevPosition = p.position;
    this.prevLandingImpact = p.landingImpact;
    this.prevRisen = this.risen;
    this.prevView = this.view();
    this.prevKick = this.kick();
    this.prevRaised = this.raised;
    this.prevAimed = this.aimed;
    this.prevReady = this.ready;
    this.prevStroke = this.stroke;
    this.controller.tick(p, this.acting, this.clock.dt);
    // The foot's rise at its own speed, the controller's alone (a lift out of the ground comes after).
    // A landing comes down: its tick's is its drop, and anything it rose is a step taken as it landed
    // (a lip stepped up onto in the air, a settle's lift, the controller's unstick), the eye's to ease.
    const landed = p.landingImpact > this.prevLandingImpact;
    this.risen += landed ? Math.min(0, p.position.y - this.prevPosition.y) : p.velocity.y * this.clock.dt;
    if (landed) this.landedTick = this.ticks;
    if (wasOnStep && p.pinned && p.stance !== Stance.FIRING_STEP) this.ejected++;
    // To the shoulder on the firing step, over the parapet; down off it.
    const raise = p.stance === Stance.FIRING_STEP ? 1 : 0;
    this.raised += (raise - this.raised) * (1 - exp(-this.clock.dt / this.viewmodel.raiseS));
    this.dig(this.clock.dt);
    this.handle(this.clock.dt);
    this.moveHands(this.clock.dt);
    this.combat(this.clock.dt);
    for (const c of this.destruction.tick()) this.events.craters.push({ ...c, tick: this.ticks });
    for (const c of this.destruction.cuts) this.events.cuts.push({ ...c, tick: this.ticks });
    if (this.destruction.written > 0) this.liftOut();
    this.particles.step(this.clock.dt);
    // What the hands did that is heard, at the gun's muzzle as the tick leaves it.
    for (const cue of this.heard) this.events.handling.push({ tick: this.ticks, cue, at: this.muzzle() });
    this.heard.length = 0;
  }

  /**
   * Shovel work (the reference's _tick_dig), after the player has moved: F held, on the ground, not
   * lying down and not at the periscope. A scoop waits, banked, while a crater's region it would
   * touch is out (its bricks would undo it); in a room, while one is pending at all, or a shell heard
   * would take its ground (`reserved`), so it goes in after every crater there on every client (the
   * shared-battle spec's note 9). The ground a scoop settles may slump into the body, which is lifted
   * out as a crater's slump is.
   */
  private dig(dt: number): void {
    const p = this.player;
    this.digging = this.acting.dig && p.onGround && p.climbTo === null && p.stance !== Stance.PRONE && p.stance !== Stance.PERISCOPE;
    if (!this.digging) return;
    const free = this.room ? (box: Box) => !this.destruction.overlapsPending(box) && !this.reserved(box) : (box: Box) => !this.destruction.overlapsOut(box);
    const scoop = this.entrenching.work(p.position.toArray(), p.yaw, dt, free);
    if (!scoop) return;
    this.events.scoops.push({ ...scoop, tick: this.ticks });
    this.liftOut();
  }

  /**
   * Another's scoop of `cells` (combat/entrenching.ts packCell), dug in this world as its digger dug
   * it: held (false) while a crater's region pending overlaps its box, which would undo it or be cut
   * from the ground before it; else dug (applyScoop) and the body lifted out of anything it slumped
   * into. A scoop that comes `after` crater id `after` (Destruction.lastId when it was put in order)
   * is not held by a later crater still queued, which waits for it (Destruction.waits): only by one
   * of those up to `after`, or one out. It is no event: `events.scoops` stays the player's own, which
   * the page sends every one of (as fireRemote's shots are remoteShots, never shots), and another's
   * scoop makes no scrape here.
   */
  applyDig(cells: readonly number[], after = Number.POSITIVE_INFINITY): boolean {
    if (this.destruction.overlapsPendingBy(scoopBox(this.map.dims, cells), after)) return false;
    applyScoop(this.map, cells, this.entrenching.waterTable);
    this.liftOut();
    return true;
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
    const canAim = a.aim === true && this.alive && this.gunUp(p);
    if (canAim) this.aimed = Math.min(1, this.aimed + dt / spec.adsTimeS);
    else if (this.aimed > 0) this.aimed = Math.max(0, this.aimed - dt / (spec.adsTimeS * 0.8));
    if (a.light && spec.fit.side !== 'none') this.lightOn = !this.lightOn;
    if (a.mode && this.held !== SHOVEL_HELD) this.arm.weapon.toggleMode();
    this.stroke = this.digging && this.held === SHOVEL_HELD && this.ready >= 1 && this.entrenching.inReach ? ((this.stroke ?? 0) + dt / h.strokeS) % 1 : null;
  }

  /**
   * A gun up to take the trigger and the sights, and either button to drop the sprint: one in the
   * hands (not the shovel), raised, not put down to dig, not at the periscope (whose holder holds that
   * rather than the gun), and no climb under way (the hands are on the parapet). The gun-up rule, in
   * one place, read as the hands stand when it is asked. `climbing` false asks it with the climb set
   * aside: a gun up but for a climb is not put down, so a press held through the climb waits it out
   * (combat()).
   */
  private gunUp(p: CharacterState, climbing = p.climbTo !== null): boolean {
    return this.held !== SHOVEL_HELD && this.ready >= 1 && !this.digging && p.stance !== Stance.PERISCOPE && !climbing;
  }

  /**
   * The gun in the hands (handling.ts), after the hands and before combat, so a shot leaves the
   * muzzle as drawn this tick. It is fed the body as the controller left it; this tick's turn of the
   * view, from the last tick's the short way round; the controller's sprint, on the ground, once fire
   * and the sights have dropped it; the sights; and the gun's reload and shot clock (the shovel has
   * neither). What it does that is heard is heard this tick. Killed, the hands are quiet: they work no
   * reload and no pump, so the gun eases to rest, and nothing they do is heard.
   */
  private moveHands(dt: number): void {
    const p = this.player;
    const w = this.weapon;
    const gun = this.held !== SHOVEL_HELD && this.alive;
    const turn = (now: number, was: number) => {
      const d = now - was;
      return d - 360 * Math.round(d / 360);
    };
    const yawRate = turn(p.yaw, this.look[0]) / dt;
    const pitchRate = turn(p.pitch, this.look[1]) / dt;
    this.look = [p.yaw, p.pitch];
    const phase = gun ? w.reloadPhase : null;
    const { cues } = this.handling.tick({
      dt,
      time: this.ticks * dt,
      yawRate,
      pitchRate,
      speedRatio: p.velocity.horizontalLength / this.handling.t.runMps,
      bobPhase: p.bobPhase,
      onGround: p.onGround,
      // As the controller left it: a tick decayed already (0.9 of the landing speed), as the eye's dip reads it.
      landingImpact: p.landingImpact,
      sprinting: sprints(this.acting, p) && p.onGround,
      aimed: this.aimed,
      reload: phase === null ? null : { phase, shells: w.reloadShells },
      sinceShot: gun ? w.sinceShot : Number.POSITIVE_INFINITY,
      gun: gunClass(this.arm.spec.gun.key),
    });
    // Dead, nothing is heard: not even a pump still to come, which the shot clock's end (+∞) crosses
    // on the first tick dead.
    if (this.alive) this.heard.push(...cues);
  }

  /**
   * An empty trigger (the shots spec's §2): a press (the trigger in the hands rising) on an empty
   * magazine, no reload under way, clicks (the cue `dry`), once a press; and the first click begins
   * a reload dry_reload_s later, if the same gun is in the hands then.
   */
  private dryTrigger(w: Weapon, trigger: boolean): void {
    if (trigger && !this.triggerWas && w.rounds <= 0 && !w.reloading) {
      this.heard.push('dry');
      this.dryReload ??= { tick: this.ticks + Math.max(1, Math.round(this.handling.t.dryReloadS / this.clock.dt)), weapon: w };
    }
    this.triggerWas = trigger;
    if (this.dryReload && this.ticks >= this.dryReload.tick) {
      if (this.dryReload.weapon === w && this.held !== SHOVEL_HELD) w.beginReload();
      this.dryReload = null;
    }
  }

  /** How exposed the player stands (the stance's), and more while digging. Nothing hits the player yet: it is shown only. */
  exposure(): number {
    return this.controller.t.stances[this.player.stance].exposure * (this.digging ? this.entrenching.t.exposureScale : 1);
  }

  /**
   * The rifle after the player has moved, in the reference's order: the clocks (the weapon, the
   * recoil scaled by the stance, suppression, the view kick); a reload asked for; a shot from the
   * eye along the view plus recoil and flinch, the cone widened by stance and suppression (a pellet
   * gun's pattern about the aim; none through the periscope: its holder is not holding the rifle),
   * which kicks the recoil and then the view; every round's flight, with near misses heard at the
   * eye; a mark wherever one struck, and suppression from the cracks and from others' impacts; and
   * last the front's fire, whose rounds move from the next tick.
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
      a.viewKick.tick(dt, this.cameraRng);
    }
    this.suppression.tick(dt);
    this.blastShake.tick(dt);
    if (this.acting.reload && this.held !== SHOVEL_HELD) w.beginReload();
    const eye: [number, number, number] = [p.position.x, p.position.y + this.controller.eyeHeight(p), p.position.z];
    // No shot with the shovel in the hands, a gun not yet up, through the periscope, mid-climb, or the
    // gun still swung low from a sprint (its blend at or over sprint_blocks_fire); an empty one clicks.
    // The sprint delays a press and does not lose it: one it alone holds back waits, the sprint
    // dropped meanwhile (tick()), so the blend falls a tick's share each tick and the press pulls the
    // trigger as it passes under, a tap out of a sprint as a held press would. A climb, the gun up but
    // for it (the hands on the parapet), waits out a press held through it and lets a tap go, as the
    // sights do: a press taken before it stays taken while held, so the climb's end is no new press (a
    // gun that fires once a press fires no more, and an empty one clicks no more); one made mid-climb
    // and still held as it ends pulls the trigger then; and no press waits it out (one waiting out a
    // sprint as it begins, or made mid-climb and let go, is gone: fired as the climb ended, up to a
    // second later, it would leave along wherever the view had turned). A gun put down lets a press
    // go, mid-climb too; killed, nothing waits.
    const low = this.handling.sprint >= this.handling.t.sprintBlocksFire;
    const wanted = this.acting.fire || (this.pressWaiting && this.alive);
    let fires = false;
    if (p.climbTo !== null && this.gunUp(p, false)) {
      const kept = this.triggerWas && this.acting.fire;
      this.pressWaiting = false;
      this.dryTrigger(w, kept);
      w.holdFire(this.acting.fire);
    } else {
      const pulled = wanted && this.gunUp(p);
      const trigger = pulled && !low;
      this.pressWaiting = pulled && low;
      this.dryTrigger(w, trigger);
      fires = w.wants(trigger);
    }
    if (fires) {
      const aim: [number, number] = [p.yaw + this.recoil.yaw + this.suppression.flinchYaw, p.pitch + this.recoil.pitch + this.suppression.flinchPitch];
      const cone = sway * this.suppression.swayScale;
      // A bullet is drawn within its cone. A pellet gun's pattern is about the aim: its first pellet
      // leaves along it (the stream still draws, as for any shot), and its word carries the cone's
      // share, put to its step (net/gear.ts stepShare), by which the others spread.
      const pellets = w.spec.pellets > 1;
      const aimed = w.aim(aim[0], aim[1], pellets ? 0 : cone, this.dispersion);
      const projectile = w.spec.projectile;
      const v = projectile.muzzleVelocity;
      const kind = w.tracer() ? teamTracer(this.team) : TRACER_KIND.none;
      const tracer = kind !== TRACER_KIND.none;
      const mark = encodeShotMark({ tracer, kind, suppressed: arm.spec.suppressed, gun: arm.spec.gun.key, ...(pellets ? { share: cone } : {}) });
      // In a room the shot flies as its words say (net/protocol.ts sent): from the eye to the
      // millimetre, along the aim to 1e-4, as every other client flies it from them.
      const words = this.room ? sent({ tick: this.ticks, origin: eye, dir: aimed, tracer, mark }) : null;
      const origin = words ? words.shot.origin : eye;
      const dir = words ? words.shot.dir : aimed;
      // The round leaves the eye, so the reticle tells the truth; its tracer, flash and brass the
      // drawn rifle, as it stands before this shot kicks it; the tracer joining the round's path where
      // the shot is aimed (one cast a pull of the trigger: a shotgun's pellets share it), and lit in
      // by a metre from the hip, so a stream reads from the gun, further aimed, clear of the sights.
      const muzzle = this.muzzle();
      const reach = this.aimRange(0, origin, dir);
      const [hipM, aimedM] = this.tracerIgnite;
      const drawn = { from: muzzle, convergeM: reach, igniteM: hipM + (aimedM - hipM) * this.aimed };
      // Every round of the pull carries it, as this tick (its shot event's): what it strikes says
      // which pull it was, however long it flies (the range counts a kill's shots by them).
      if (this.rounds.fire(origin, [dir[0] * v, dir[1] * v, dir[2] * v], projectile, 0, kind, drawn, this.ticks) >= 0) {
        // A shotgun's other pellets, about the first by the gun's cone times the share its word says
        // (the step, stepShare, not the share itself), from the shot's seed, its seat and tick: the
        // pellets every other client draws for it (combat/weapon.ts pelletDirs).
        for (const d of pelletDirs(dir, w.spec.pellets - 1, (w.spec.dispersionMoa / 60) * stepShare(cone), pelletSeed(this.seat, this.ticks))) {
          this.rounds.fire(origin, [d[0] * v, d[1] * v, d[2] * v], projectile, 0, kind, drawn, this.ticks);
        }
        w.shot();
        this.throwShot(muzzle, arm.spec.flash);
        const kick = this.recoil.kickPitch;
        this.recoil.shot(this.recoilRng);
        this.viewKick.shot(this.recoil.kickPitch - kick, this.viewKickRng, this.cameraRng);
        this.shots.push({ origin, dir, aim, tracer });
        this.events.shots.push({ tick: this.ticks, origin, dir, tracer, muzzle, mark, flash: arm.spec.flash, report: arm.spec.report, ...(words ? { wire: words.wire } : {}) });
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
    // Rounds into bodies: a puff of the uniform's dust where each struck, and blood, but not out of the player's own.
    for (const hit of this.rounds.bodyHits) {
      this.events.hits.push({ ...hit, tick: this.ticks });
      // In a room the front's round into the player harms them by its zone (combat/harm.ts), for the room.
      if (this.room && hit.owner === 1 && hit.body === LOCAL_BODY) this.events.harms.push({ tick: this.ticks, amount: frontHarm(hit.zone, this.harmT), cause: 'round' });
      const { dust } = this.kinds;
      this.particles.emit(hit.position, [-hit.dir[0] * dust.speed, dust.lift, -hit.dir[2] * dust.speed], dust, dust.count, this.particleRng, this.tints[P_KHAKI]);
    }
    this.bleedHits(this.rounds.bodyHits);
    this.spatterHits(this.rounds.bodyHits);
    for (const hit of this.rounds.impacts) {
      // In a room the front's rounds chip nothing: each page's front is its own, and the world is
      // everyone's. Their dust and suppression stay.
      if (!(this.room && hit.owner === 1)) this.destruction.mark(hit.cell[0], hit.cell[1], hit.cell[2], hit.energyJ, this.chipEnergyJ);
      if (hit.owner !== 0) this.suppression.impact(hypot(hit.position[0] - eye[0], hit.position[1] - eye[1], hit.position[2] - eye[2]));
      this.events.impacts.push({ ...hit, tick: this.ticks });
      this.throwImpact(hit);
    }
    // The front's rounds are the ones its tick adds to the pool, the last in it. In a room it fires
    // to hurt, over the crest at a head it cannot see.
    this.front.room = this.room;
    const fired = this.front.tick(dt, eye, this.rounds, this.frontProjectile, this.room ? this.frontSight : undefined);
    for (let slot = this.rounds.count - fired; slot < this.rounds.count; slot++) {
      const v = this.rounds.velocity(slot);
      const speed = hypot(v[0], v[1], v[2]);
      const origin = this.rounds.position(slot);
      this.events.frontShots.push({ tick: this.ticks, origin, dir: [v[0] / speed, v[1] / speed, v[2] / speed], tracer: this.rounds.isTracer(slot), muzzle: origin });
    }
    // The front's shells: heard coming in whistle_s before they land.
    const shells = this.artillery.tick(dt, eye);
    for (const sh of shells.announced) this.whistle(sh.x, sh.z, this.artillery.t.whistleS);
    for (const sh of shells.landed) this.land(sh.x, sh.z, sh.radiusM, sh.seed);
  }

  /** A shell heard coming in to (x, z) (metres), landing in `landsInS`: an incoming event at the top of the ground there; none off the map. */
  whistle(x: number, z: number, landsInS: number): void {
    const v = this.voxel;
    const top = groundTop(this.map, x / v, z / v);
    if (top !== null) this.events.incoming.push({ tick: this.ticks, at: [x, top * v, z], landsInS });
  }

  /**
   * A shell of `radiusM` landing at (x, z) (metres) on the top of the ground there, its crater cut
   * with `seed`: its blast now, its crater queued (an event once it is in the world). Its id, or null
   * where there is no ground (off the map).
   *
   * In a room its crater is cut on the ground where it is when the crater goes out (sim/destruction.ts),
   * and while the player is alive its blast harms them by its distance from their chest, times
   * cover_share if its way there is blocked (combat/harm.ts). `quiet` (a shell long overdue, a match
   * over) queues its crater alone: no blast, no particles, debris, shake, suppression or harm.
   */
  land(x: number, z: number, radiusM: number, seed: number, quiet = false): number | null {
    const v = this.voxel;
    const top = groundTop(this.map, x / v, z / v);
    if (top === null) return null;
    const id = this.destruction.shell([x / v, top, z / v], radiusM / v, seed, this.room);
    if (quiet) return id;
    const material = this.map.get(Math.floor(x / v), top - 1, Math.floor(z / v));
    const at: [number, number, number] = [x, top * v, z];
    this.events.blasts.push({ tick: this.ticks, at, radiusM, material, crater: id, seed });
    if (kindOf(material) === K.WATER) {
      const k = radiusM / 3;
      this.events.splashes.push({ tick: this.ticks, at, energyJ: this.splashEnergyJ * k * k * k, kind: 'shell' });
    } else this.throwDebrisIn(x, z, radiusM, seed);
    this.throwBlast(at, material);
    const p = this.player;
    const d = hypot(at[0] - p.position.x, at[1] - (p.position.y + this.controller.eyeHeight(p)), at[2] - p.position.z);
    this.blastShake.kick(d);
    this.suppression.blast(d);
    if (this.room && this.alive) {
      // To the chest, from a voxel over the struck ground: covered if that way is blocked.
      const chest = toWorld(this.ownBody().torso, CHEST);
      const covered = this.sight([x, at[1] + v, z], chest) !== null;
      const amount = blastHarm(hypot(chest[0] - at[0], chest[1] - at[1], chest[2] - at[2]), radiusM, covered, this.harmT);
      if (amount > 0) this.events.harms.push({ tick: this.ticks, amount, cause: 'shell' });
    }
    return id;
  }

  /**
   * A voxel ray from `from` to `to` (metres): where it meets solid (metres) a voxel or more short of
   * `to`, or null if it gets that far. A blast's cover; in a room, the front's view of the player's head.
   */
  sight(from: readonly [number, number, number], to: readonly [number, number, number]): V3 | null {
    const v = this.voxel;
    const o: V3 = [from[0] / v, from[1] / v, from[2] / v];
    const d = [to[0] / v - o[0], to[1] / v - o[1], to[2] / v - o[2]];
    const length = hypot(d[0], d[1], d[2]);
    if (length <= 1) return null;
    const dir: V3 = [d[0] / length, d[1] / length, d[2] / length];
    const hit = raycast(this.map, o, dir, length - 1);
    return hit ? [(o[0] + dir[0] * hit.t) * v, (o[1] + dir[1] * hit.t) * v, (o[2] + dir[2] * hit.t) * v] : null;
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

  /**
   * Blood where a round struck a body (the shots spec's §4), at `at` along the round's unit `dir`:
   * [particles.blood]'s droplets thrown out of the far side and a puff of [particles.blood_mist];
   * critical (a headshot, or the round that kills), [hits] critical_droplets and critical_mist of
   * them; and off a `helmet`, helmet_sparks sparks back along the round. combat() bleeds the rounds
   * into others' bodies; the app bleeds a kill's.
   */
  bleed(at: readonly number[], dir: readonly number[], critical: boolean, helmet = false): void {
    const { blood, mist, spark } = this.kinds;
    const b = this.bleeding;
    const along = (spec: ParticleSpec, k: number) => [dir[0] * spec.speed * k, dir[1] * spec.speed * k + spec.lift, dir[2] * spec.speed * k];
    this.particles.emit(at, along(blood, 1), blood, critical ? b.criticalDroplets : blood.count, this.particleRng);
    this.particles.emit(at, along(mist, 1), mist, critical ? b.criticalMist : mist.count, this.particleRng);
    if (helmet) this.particles.emit(at, along(spark, -1), spark, b.helmetSparks, this.particleRng);
  }

  /**
   * The tick's rounds into others' bodies bled: critical in the head, whose every hit sparks off the
   * helmet too (the ledger's ruling). A body bleeds [hits] bursts_per_tick of them at most, its
   * headshots first: a shotgun's nine pellets bleed it twice, and never leave a headshot's burst out.
   * The player's own body (LOCAL_BODY) bleeds none: no body of theirs is drawn in first person, so
   * its blood would be thrown into the eye, and being hit is the red flash, the aim's flinch and the
   * hurt voice (the shots spec's §4).
   */
  private bleedHits(hits: readonly BodyHit[]): void {
    if (hits.length === 0) return;
    const bled = new Map<number, number>();
    for (const head of [true, false]) {
      for (const hit of hits) {
        if (hit.body === LOCAL_BODY || (hit.zone === 'head') !== head) continue;
        const n = bled.get(hit.body) ?? 0;
        if (n >= this.bleeding.burstsPerTick) continue;
        bled.set(hit.body, n + 1);
        this.bleed(hit.position, hit.dir, head, head);
      }
    }
  }

  /**
   * Spatter (the shots spec's §4) from `at` (metres) on along the round's `dir`: what is behind a
   * critical hit, and the ground behind the body's feet, marked with its blood (world/spatter.ts),
   * drawn from `seed` (any finite number; a fraction draws as its floor). Nothing is marked inside a
   * crater's region while it is out, whose bricks coming back would undo it. The voxels it marked,
   * whose bricks upload as any edit's do. combat() spatters the headshots into others' bodies; the
   * app spatters a kill's.
   */
  spatterAt(at: readonly number[], dir: readonly number[], seed: number): number {
    const v = this.voxel;
    return spatter(this.map, [at[0] / v, at[1] / v, at[2] / v], dir, seed, this.spattering, (box) => this.destruction.overlapsOut(box));
  }

  /**
   * The tick's headshots into others' bodies spattered, each drawn from the hash of the tick and
   * where it struck (to a tenth of a millimetre). A body's head spatters [hits] bursts_per_tick of
   * them at most, its first, counted as bleedHits counts: the same headshots bleed critical, and a
   * shotgun's nine pellets into one head spatter twice. The player's own head spatters nothing, as
   * it bleeds nothing (bleedHits): being hit is the flash, the flinch and the voice.
   */
  private spatterHits(hits: readonly BodyHit[]): void {
    if (hits.length === 0) return;
    const spattered = new Map<number, number>();
    for (const hit of hits) {
      if (hit.body === LOCAL_BODY || hit.zone !== 'head') continue;
      const n = spattered.get(hit.body) ?? 0;
      if (n >= this.bleeding.burstsPerTick) continue;
      spattered.set(hit.body, n + 1);
      const [x, y, z] = hit.position;
      this.spatterAt(hit.position, hit.dir, hash32(this.ticks, Math.round(x * 1e4), Math.round(y * 1e4), Math.round(z * 1e4)));
    }
  }

  /**
   * The aim jolted, `yawDeg` right and `pitchDeg` up (the player hit: the shots spec's §4): added to
   * suppression's flinch, which the view and the next shot's aim take, and let go as it is.
   */
  jolt(yawDeg: number, pitchDeg: number): void {
    this.suppression.jolt(yawDeg, pitchDeg);
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

  /** How far the foot has risen at its own speed (`risen`) between the last two ticks, `alpha` of the way to the latest, as the foot is. */
  risenAt(alpha = this.clock.alpha): number {
    return this.prevRisen + (this.risen - this.prevRisen) * alpha;
  }

  /**
   * The eye's dip on a landing (metres, down negative) between the last two ticks' dips, `alpha` of
   * the way to the latest, as the foot is: the camera's (camera-rig.ts), which the drawn gun is held in.
   * The muzzle placed on a tick (rifleToWorld) carries that tick's.
   */
  landingDipAt(alpha = this.clock.alpha): number {
    const from = this.landingDipOf(this.prevLandingImpact);
    return from + (this.landingDipOf(this.player.landingImpact) - from) * alpha;
  }

  /**
   * The eye's dip (metres, down negative) for a landing at `impact` m/s: [camera] landing_dip by its
   * share of a hard one, at [handling] landing_hard_mps or faster. That is the gun's full-dip speed
   * too: a landing is as hard for the eye as for the gun.
   */
  private landingDipOf(impact: number): number {
    const hard = this.handling.t.landingHardMps;
    return (-Math.min(impact, hard) / hard) * this.landingDip;
  }

  /** The view's offsets between the last two ticks, `alpha` of the way to the latest. */
  viewAt(alpha = this.clock.alpha): ViewOffsets {
    const a = this.prevView;
    const b = this.view();
    const at = (from: number, to: number) => from + (to - from) * alpha;
    return {
      yaw: at(a.yaw, b.yaw),
      pitch: at(a.pitch, b.pitch),
      roll: at(a.roll, b.roll),
      fov: at(a.fov, b.fov),
      shake: [at(a.shake[0], b.shake[0]), at(a.shake[1], b.shake[1]), at(a.shake[2], b.shake[2])],
    };
  }

  /**
   * The rifle's pose between the last two ticks, `alpha` of the way to the latest, with a sideways
   * sway (metres) and a run's share of full speed, which the camera has, moved by the hands between
   * the same two ticks (none while they are held still). The rig passes no sway in play: the hands'
   * figure eight is the gun's only stride motion, and the sway's term is kept for the pinned poses.
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
    const hands = this.handsStill ? ZERO_HANDS : this.handling.at(alpha);
    return heldPose(this.viewmodel, this.holding(), { back: at('back'), up: at('up'), side: at('side'), pitch: at('pitch'), yaw: at('yaw'), roll: at('roll') }, sway, speedRatio, raised, aimed, ready, stroke, hands);
  }

  /**
   * How far out a shot of `owner`'s (0 the player, 2 + a seat another player) from `eye` along `dir` is
   * aimed (aimRangeM): the first thing on its line, the world or a body that owner's round would strike
   * (the round's own test, Rounds.bodies), within [effects] tracer_converge_min_m and _max_m: where its
   * tracer joins its path.
   */
  aimRange(owner: number, eye: readonly [number, number, number], dir: readonly [number, number, number]): number {
    return aimRangeM(this.map, this.voxel, eye, dir, this.tracerConverge[0], this.tracerConverge[1], (u, m) => this.rounds.bodies?.(owner, eye, u, m)?.t ?? null);
  }

  /** The gun's muzzle in world metres, as the last tick left the view, the eye's landing dip, the kick and the hands: where the flash and the tracers start. */
  muzzle(): [number, number, number] {
    return this.rifleToWorld(this.arm.spec.muzzle);
  }

  /** The gun's ejection port in world metres: where the brass leaves. */
  port(): [number, number, number] {
    return this.rifleToWorld(this.arm.spec.port);
  }

  /**
   * A rifle point (model metres) in the world, from the eye along the view with its offsets and the
   * hands' as the last tick left them: the gun is held in the view, so a shot's shake and a landing's
   * dip (the tick's own; the frames between ticks ease it, landingDipAt), which move the eye, carry it
   * too. No round leaves from here: they leave the undipped eye (combat()). The stride's motion (the
   * eye's bob and lean, the gun's run dip, a centimetre or so) and the eye's easing over steps are
   * the camera's alone.
   */
  private rifleToWorld(point: readonly number[]): [number, number, number] {
    const p = this.player;
    const view = this.view();
    const { forward, right, up } = viewBasis(p.yaw + view.yaw, p.pitch + view.pitch, view.roll);
    const hands = this.handsStill ? ZERO_HANDS : this.handling.delta;
    const v = modelToView(heldPose(this.viewmodel, this.holding(), this.kick(), 0, 0, this.raised, this.aimed, this.ready, this.stroke, hands), point);
    const eye = [p.position.x + view.shake[0], p.position.y + this.controller.eyeHeight(p) + this.landingDipOf(p.landingImpact) + view.shake[1], p.position.z + view.shake[2]];
    return [0, 1, 2].map((k) => eye[k] + right[k] * v[0] + up[k] * v[1] + forward[k] * v[2]) as [number, number, number];
  }

  /** The view kick's channels now. */
  private kick(): ViewmodelKick {
    const k = this.viewKick;
    return { back: k.back, up: k.up, side: k.side, pitch: k.pitch, yaw: k.yaw, roll: k.roll };
  }

  /**
   * The view's offsets as the last tick left them. The view kick's camera roll and shake add to the
   * camera's alone: the roll to the shakes' roll, and a shot's shake to the turn and the eye. The
   * roll, all three together, is held within roll_max_deg (the shots spec's 3°): the camera's, so
   * no round is moved by it.
   */
  private view(): ViewOffsets {
    const shake = this.suppression.shake;
    const camera = this.viewKick;
    const roll = shake.roll + this.blastShake.roll + camera.camRoll;
    return {
      yaw: this.recoil.yaw + this.suppression.flinchYaw + camera.shake.yaw,
      pitch: this.recoil.pitch + this.suppression.flinchPitch + shake.pitch + this.blastShake.pitch + camera.shake.pitch,
      roll: Math.max(-this.rollMaxDeg, Math.min(this.rollMaxDeg, roll)),
      fov: camera.fovOffset,
      shake: [camera.shake.offset[0], camera.shake.offset[1], camera.shake.offset[2]],
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
    // Nor a landing where it was for the eye to dip by between ticks, or to follow down: the move
    // here is no rise of the body's own, and the body's own stops where the frames showed it.
    this.prevLandingImpact = 0;
    this.risen = this.prevRisen = this.risenAt();
    this.landedTick = -1;
    // Put there facing the way given: no turn of the view for the hands to trail.
    this.look = [yaw, pitch];
    // Nor its body as posed where it was: a shell landing before the next tick harms it here.
    this.ownFrames = null;
  }
}
