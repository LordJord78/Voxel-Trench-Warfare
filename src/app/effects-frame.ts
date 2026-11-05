/**
 * A frame's effects, from the session, the events the frame drained and the
 * rifle as it is drawn: the particles' billboards, the shot's flash and brass
 * leaving the drawn rifle; each tracer round's ribbon, the player's drawn from
 * the rifle's muzzle and joining the round's path where the shot was aimed
 * (Session.aimRange: the round leaves the eye, so the reticle tells the truth,
 * and its tracer reaches across to it), and each round that struck in the
 * frame's ticks once more, by the same law, ending where it struck (so one
 * whose whole flight fitted in the ticks is seen); and each shot's flash
 * — a star of three ribbons from the drawn muzzle along its bore and a
 * transient light there — for `flash_s` of the world's time, so as long at any
 * frame rate and held while paused (spec §4). The simulation's muzzle is the
 * bare eye's at the tick; the drawn rifle's follows the interpolated, bobbing
 * eye, centimetres away while walking.
 *
 * A tracer (the shots spec §1), the session's and the battle's alike: a white-
 * hot core in a coloured glow (ribbon style 1), its streak more than a frame's
 * flight at its speed (`tracer_streak_s`) and no more than it has flown, fading
 * toward its tail; lit in from nothing at the muzzle to full a metre out
 * (`tracer_ignite_hip_m`; the shooter's own aimed shot `tracer_ignite_m` out,
 * clear of the sights) and full past it, along the streak: a round's first
 * frame reaches back to the muzzle, so a streak that spans that point is drawn
 * as two ribbons, the ramp and the rest. A burning head from
 * `tracer_head_from_m`, white-hot near the eye and its team's colour far off
 * (`tracer_white_near_m` to `tracer_white_far_m`), and brighter by day.
 *
 * The team's own: tracers in its red or blue, a suppressed gun's flash a
 * wisp without its star, and the guns' lights and lasers — the player's from
 * the drawn gun, the others' from theirs — where their beams strike: a light's
 * pool of light, widening and dimming with its reach, and a laser's dot.
 */

import type { DistantShell } from '../battle/director';
import { farShellTunables, type ColumnPuff, type FarShellTunables } from '../battle/far-shells';
import { fireTunables, type FireTunables, type FlameQuad, type PlumePuff } from '../battle/fires';
import { flareTunables, type FlareState, type FlareTunables } from '../battle/flares';
import { tracerTunables, type TracerState } from '../battle/tracers';
import { Ricochets, ricochetTunables, type RicochetTunables } from './ricochets';
import { beamOf } from '../combat/arsenal';
import type { StrikeDraw } from '../combat/ballistics';
import { BILLBOARD_FLOATS } from '../combat/particles';
import { toWorld } from '../combat/soldier-rig';
import type { Tunables } from '../core/tunables';
import { decodeGear, TRACER_KIND } from '../net/gear';
import type { SoldierDraw } from '../render/soldiers';
import { raycast } from '../world/raycast';
import { EMBER_BILLBOARD, HEAD_BILLBOARD, MAX_BILLBOARDS, MAX_RIBBONS, RIBBON_FLOATS, RIBBON_STYLE, type EffectsFrame, type SmokePuff, type TransientLight } from '../render/effects';
import { MAX_PUFFS } from '../render/frame-uniforms';
import { throughPose, type RiflePose } from '../render/rifle';
import { MUZZLE_ANCHOR, PORT_ANCHOR, SHOVEL_HELD, type CombatEvents, type Session } from '../sim/session';

type V3 = [number, number, number];

/** The battle as a frame draws it (src/battle/director.ts): at its moment, its flares, its newest distant shells' flashes, the far shells' smoke, the machine guns' tracers, and the fires' flames, embers and plumes. */
export interface ShownBattle {
  seconds: number;
  flares: readonly FlareState[];
  flashes: readonly DistantShell[];
  smoke: readonly ColumnPuff[];
  tracers: readonly TracerState[];
  flames: readonly FlameQuad[];
  plumes: readonly PlumePuff[];
}

/** No battle drawn: at rest, as the approved views are measured. */
export const NO_BATTLE: ShownBattle = { seconds: 0, flares: [], flashes: [], smoke: [], tracers: [], flames: [], plumes: [] };

export interface EffectsTunables {
  /** The battle's flares, as they are seen: their sparks climbing and discs burning. */
  flares: FlareTunables;
  /** The far shells, as they are seen: their flash's disc and their columns of smoke. */
  farShells: FarShellTunables;
  /** The fires, as they are seen: their flames' and embers' colour. */
  fires: FireTunables;
  /** A distant shell's flash's colour ([battle.flashes]). */
  distantColour: V3;
  /** The most of the battle's tracers drawn, the nearest the eye, and the longest streak each is drawn with. */
  maxBattleTracers: number;
  battleTrailM: number;
  tracerColour: V3;
  /** A team's tracers' colours. */
  tracerColourRed: V3;
  tracerColourBlue: V3;
  tracerIntensity: number;
  /** A tracer as drawn: its core's and glow's widths (m), the glow's brightness over the core's, and how far the core is mixed toward white near the eye, all of it within tracerWhiteNearM (m) and none from tracerWhiteFarM. */
  tracerCoreWidthM: number;
  tracerGlowWidthM: number;
  tracerGlowShare: number;
  tracerCoreWhite: number;
  tracerWhiteNearM: number;
  tracerWhiteFarM: number;
  /** By day a tracer's core is at least this much as white as near the eye, times daylight (effects.wgsl whiteFloor). */
  tracerWhiteByDay: number;
  /** Its head: an emissive disc this wide (m), this many times as bright as the core, over the light pass's glow for emissive billboards (`particle_glow`). */
  tracerHeadM: number;
  tracerHeadGain: number;
  particleGlow: number;
  /** Its streak: this much of its flight (s), within these (m). */
  tracerStreakS: number;
  tracerMinM: number;
  tracerMaxM: number;
  /** Lit in over its first metres of flight: a round's own where it carries one (the shooter's, by how aimed the shot was, Session: up to tracer_ignite_m aimed), else this, a hip shot's (others', the front's, the battle's); its head drawn from here (m). */
  tracerIgniteHipM: number;
  tracerHeadFromM: number;
  /** By day, 1 + this × daylight as bright; daylight rising 0 to 1 as the sun climbs between these elevations (degrees). */
  tracerDayBoost: number;
  tracerDaylightDeg: [number, number];
  /** Its light covering what is behind it (effects.wgsl tracerLight) rising 0 to all of `tracer_cover` as the sun climbs between these elevations (degrees): coverAt. */
  tracerCoverDeg: [number, number];
  /** A weapon light: how far its beam reaches, the light where it strikes (its radius near and far, its intensity, colour). */
  light: { rangeM: number; radiusM: [number, number]; intensity: number; colour: V3 };
  /** A laser's dot: its size, glow and colour. */
  laser: { sizeM: number; glow: number; colour: V3 };
  tracerTailAlpha: number;
  /** Embers and ricochets ([effects.ricochet]). */
  ricochet: RicochetTunables;
  flashS: number;
  particleAttachS: number;
  flashStarLengthM: number;
  flashStarWidthM: number;
  flashColour: V3;
  flashIntensity: number;
  flashLightRadiusM: number;
  flashLightIntensity: number;
  flashLightColour: V3;
  blastLightS: number;
  blastLightRadiusM: number;
  blastLightIntensity: number;
  blastLightColour: V3;
  smokeS: number;
  smokePuffs: number;
  smokeRadiusScale: number;
  smokeRiseMS: number;
  smokeSpreadMS: number;
  smokeDensity: number;
}

function rgb(tun: Tunables, key: string): V3 {
  const value = tun.get(key);
  if (!Array.isArray(value) || value.length !== 3 || !value.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw new TypeError(`tunable '${key}' is not three finite numbers: ${JSON.stringify(value)}`);
  }
  return value as V3;
}

export function effectsTunables(tun: Tunables): EffectsTunables {
  const f = (k: string) => tun.f(`effects.${k}`);
  return {
    flares: flareTunables(tun),
    farShells: farShellTunables(tun),
    fires: fireTunables(tun),
    distantColour: tun.triple('battle.flashes.colour'),
    maxBattleTracers: tracerTunables(tun).maxDrawn,
    battleTrailM: tracerTunables(tun).trailM,
    tracerColour: rgb(tun, 'effects.tracer_colour'),
    tracerColourRed: rgb(tun, 'effects.tracer_colour_red'),
    tracerColourBlue: rgb(tun, 'effects.tracer_colour_blue'),
    tracerIntensity: f('tracer_intensity'),
    tracerCoreWidthM: f('tracer_core_width_m'),
    tracerGlowWidthM: f('tracer_glow_width_m'),
    tracerGlowShare: f('tracer_glow_share'),
    tracerCoreWhite: f('tracer_core_white'),
    tracerWhiteNearM: f('tracer_white_near_m'),
    tracerWhiteFarM: f('tracer_white_far_m'),
    tracerWhiteByDay: f('tracer_white_by_day'),
    tracerHeadM: f('tracer_head_m'),
    tracerHeadGain: f('tracer_head_gain'),
    particleGlow: f('particle_glow'),
    tracerStreakS: f('tracer_streak_s'),
    tracerMinM: f('tracer_min_m'),
    tracerMaxM: f('tracer_max_m'),
    tracerIgniteHipM: f('tracer_ignite_hip_m'),
    tracerHeadFromM: f('tracer_head_from_m'),
    tracerDayBoost: f('tracer_day_boost'),
    tracerDaylightDeg: tun.pair('effects.tracer_daylight_deg'),
    tracerCoverDeg: tun.pair('effects.tracer_cover_deg'),
    light: { rangeM: f('light_range_m'), radiusM: tun.pair('effects.light_radius_m'), intensity: f('light_intensity'), colour: rgb(tun, 'effects.light_colour') },
    laser: { sizeM: f('laser_size_m'), glow: f('laser_glow'), colour: rgb(tun, 'effects.laser_colour') },
    tracerTailAlpha: f('tracer_tail_alpha'),
    ricochet: ricochetTunables(tun),
    flashS: f('flash_s'),
    particleAttachS: f('particle_attach_s'),
    flashStarLengthM: f('flash_star_length_m'),
    flashStarWidthM: f('flash_star_width_m'),
    flashColour: rgb(tun, 'effects.flash_colour'),
    flashIntensity: f('flash_intensity'),
    flashLightRadiusM: f('flash_light_radius_m'),
    flashLightIntensity: f('flash_light_intensity'),
    flashLightColour: rgb(tun, 'effects.flash_light_colour'),
    blastLightS: f('blast_light_s'),
    blastLightRadiusM: f('blast_light_radius_m'),
    blastLightIntensity: f('blast_light_intensity'),
    blastLightColour: rgb(tun, 'effects.blast_light_colour'),
    smokeS: f('smoke_s'),
    smokePuffs: tun.i('effects.smoke_puffs'),
    smokeRadiusScale: f('smoke_radius_scale'),
    smokeRiseMS: f('smoke_rise_m_s'),
    smokeSpreadMS: f('smoke_spread_m_s'),
    smokeDensity: f('smoke_density'),
  };
}

/** A test's quad, square to the camera: emissive, or lit as dust is, and drawn round or, lit, square as debris is. */
export interface DebugQuad {
  position: V3;
  size: number;
  colour: V3;
  lit?: boolean;
  square?: boolean;
}

/** A test's ribbon: emissive, as a flash star's ray is drawn (one soft term across it), as bright at its tail as its head. */
export interface DebugRibbon {
  tail: V3;
  head: V3;
  width: number;
  colour: V3;
}

/** A test's tracer, drawn as a round's is (its core, glow and head) of `kind` (net/gear.ts TRACER_KIND), long since lit. */
export interface DebugTracer {
  tail: V3;
  head: V3;
  kind: number;
}

/** A test's ember, drawn as a strike's is of `kind` (net/gear.ts TRACER_KIND), as bright as when newly struck. */
export interface DebugEmber {
  at: V3;
  kind: number;
}

export interface BuiltEffects {
  frame: EffectsFrame;
  lights: TransientLight[];
  /** Shells' blasts, lighting the world shadowed (renderer.setBlasts). */
  blasts: TransientLight[];
  /** Their smoke in the haze, and the fires' plumes: the nearest MAX_PUFFS puffs, nearest first (renderer.setSmoke). */
  smoke: SmokePuff[];
  /** The session's tracers and the battle's, the heads drawn on every tracer and the embers (a test's too); the ricochets and embers by their tracer's kind too (indexed by TRACER_KIND). */
  counts: { billboards: number; tracers: number; stars: number; lights: number; battleTracers: number; flames: number; heads: number; ricochets: number; embers: number; ricochetsByKind: number[]; embersByKind: number[] };
  /**
   * The session's own tracers as drawn this frame (their offsets applied), metres: for a test to find
   * them on the image. `headDrawn`: the burning head is drawn (past tracer_head_from_m); `joinsM`: how
   * far out the tracer joins its round's path (0: drawn on it); `struck`: a round that struck in the
   * frame's ticks, drawn once more, ending where it struck.
   */
  drawn: { tail: [number, number, number]; head: [number, number, number]; kind: number; flown: number; headDrawn: boolean; joinsM: number; struck: boolean }[];
}

/** WGSL's smoothstep: 0 at `low`, 1 at `high`, Hermite between. */
const smoothstep = (low: number, high: number, x: number): number => {
  const u = Math.min(1, Math.max(0, (x - low) / (high - low)));
  return u * u * (3 - 2 * u);
};

/** The day's share of the light for the tracers' brightness: 0 with the sun low or down, 1 once it is up (a smoothstep over `tracer_daylight_deg`). */
export function daylightAt(sunElevationDeg: number, t: EffectsTunables): number {
  const [low, high] = t.tracerDaylightDeg;
  return smoothstep(low, high, sunElevationDeg);
}

/**
 * How much of `tracer_cover` a tracer's light covers what is behind it, by the sun (a smoothstep over
 * `tracer_cover_deg`): all of it while the sun is up, the haze behind a tracer bright (at 17:35 its
 * light added alone showed the haze's hue, a red tracer orange); none from dusk on, the sky behind it
 * dark and its light added alone brighter, as approved.
 */
export function coverAt(sunElevationDeg: number, t: EffectsTunables): number {
  const [low, high] = t.tracerCoverDeg;
  return smoothstep(low, high, sunElevationDeg);
}

/** How near the eye a tracer is for its whiteness, `metres` off: 1 within tracer_white_near_m, falling to 0 at tracer_white_far_m (effects.wgsl takes a ribbon's so, at its middle). */
export function tracerNearAt(metres: number, t: EffectsTunables): number {
  return 1 - smoothstep(t.tracerWhiteNearM, t.tracerWhiteFarM, metres);
}

/** How far a tracer's core (and its head) is mixed toward white `metres` from the eye: all of tracer_core_white near it, none far off, and by day at least `floor` of it (effects.wgsl's whiteFloor, tracer_white_by_day × daylight). */
export function tracerWhiteAt(metres: number, t: EffectsTunables, floor = 0): number {
  return t.tracerCoreWhite * Math.max(tracerNearAt(metres, t), floor);
}

const RAD = Math.PI / 180;
const TAU = 2 * Math.PI;
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (a: readonly number[]): V3 => {
  const n = Math.hypot(a[0], a[1], a[2]);
  return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 1];
};
/** The flash's star: forward, and two rays 60° either side of it, a little up, each 0.6 as long. */
const STAR_SIDE = 60 * RAD;
const STAR_SIDE_LENGTH = 0.6;
const STAR_LIFT = 0.3;
/** A star's ray's look across it: its style, and nothing of a tracer's core and glow. */
const STAR_LOOK = [RIBBON_STYLE.star, 0, 0, 0] as const;
/** How far a test's tracer has flown: far past its lighting in. */
const LONG_FLOWN = Infinity;

export class EffectsFrameBuilder {
  /** Quads and transient lights a test asks for, every frame until it asks for none. */
  debug: DebugQuad[] = [];
  debugRibbons: DebugRibbon[] = [];
  debugTracers: DebugTracer[] = [];
  debugEmbers: DebugEmber[] = [];
  debugLights: TransientLight[] = [];
  debugBlasts: TransientLight[] = [];
  debugSmoke: SmokePuff[] = [];
  /** Where the last frame's test quads start among its billboards. */
  debugAt = 0;
  private readonly billboards = new Float32Array(MAX_BILLBOARDS * BILLBOARD_FLOATS);
  private readonly ribbons = new Float32Array(MAX_RIBBONS * RIBBON_FLOATS);
  /** Shots' flashes, aging: the player's at the drawn rifle's muzzle; another player's (`remote`) at their own; each its `share` of a bare gun's. */
  private flashes: { muzzle: V3; dir: V3; age: number; remote?: boolean; share: number }[] = [];
  /** Shells landed, aged as the flashes are, while their light or their smoke lasts. */
  private landed: { at: V3; radiusM: number; age: number }[] = [];
  /** The world's time the last frame showed. */
  private shown: number | null = null;

  /** Tracer strikes' embers and the ricochets that glanced off, aged by the world's time. */
  private readonly ricochets: Ricochets;

  constructor(readonly t: EffectsTunables) {
    this.ricochets = new Ricochets(t.ricochet);
  }

  /**
   * `rifle`: the rifle as this frame draws it, or null when it is not drawn; `eye`: the camera
   * (metres), the player's eye if not given; `battle`, the battle seen, its flares dimmed by the
   * sky's flares key `flareKey` as their light is; `others`, the other players as drawn, for their
   * lights and lasers; `daylight`, the day's share of the light (daylightAt), the tracers burning
   * brighter by it; `cover`, the sun's share of how much a tracer's light covers what is behind it
   * (coverAt).
   */
  build(session: Session, events: CombatEvents, rifle: RiflePose | null = null, eye?: readonly number[], battle: ShownBattle = NO_BATTLE, flareKey = 1, others: readonly SoldierDraw[] = [], daylight = 0, cover = 0): BuiltEffects {
    const t = this.t;
    // Flashes age with the world's time as the frame shows it: none while paused.
    const shown = (session.ticks + session.clock.alpha) * session.clock.dt;
    const elapsed = this.shown === null ? 0 : Math.max(0, shown - this.shown);
    this.shown = shown;
    for (const f of this.flashes) f.age += elapsed;
    this.flashes = this.flashes.filter((f) => f.age < t.flashS);
    for (const shot of events.shots) this.flashes.push({ muzzle: shot.muzzle, dir: shot.dir, age: 0, share: shot.flash ?? 1 });
    for (const shot of events.remoteShots) this.flashes.push({ muzzle: shot.muzzle, dir: shot.dir, age: 0, remote: true, share: shot.flash ?? 1 });
    this.ricochets.step(elapsed);
    for (const hit of events.impacts) if (hit.kind !== TRACER_KIND.none) this.ricochets.strike(hit, hit.kind);
    for (const b of this.landed) b.age += elapsed;
    this.landed = this.landed.filter((b) => b.age < Math.max(t.blastLightS, t.smokeS));
    for (const b of events.blasts) this.landed.push({ at: b.at, radiusM: b.radiusM, age: 0 });

    // The drawn gun's muzzle and bore, and how far it is drawn from where the simulation holds it.
    const arm = session.arm.spec;
    const muzzle = rifle ? throughPose(rifle.toWorld, arm.muzzle) : null;
    const bore = rifle ? unit([rifle.toWorld[6], rifle.toWorld[7], rifle.toWorld[8]]) : null;
    const drift: V3[] = [];
    if (muzzle && rifle) {
      drift[MUZZLE_ANCHOR - 1] = sub(muzzle, session.muzzle());
      drift[PORT_ANCHOR - 1] = sub(throughPose(rifle.toWorld, arm.port), session.port());
    }

    let billboards = session.particles.billboards(this.billboards, drift, t.particleAttachS);
    this.debugAt = billboards;
    for (const q of this.debug) {
      if (billboards >= MAX_BILLBOARDS) break;
      this.billboards.set([...q.position, q.size / 2, ...q.colour, 1, q.lit ? (q.square ? 2 : 0) : 1], billboards * BILLBOARD_FLOATS);
      billboards++;
    }
    // The battle's flares seen: a spark trailing each as it climbs, a bright disc each as it burns.
    const ft = t.flares;
    for (const fl of battle.flares) {
      if (billboards >= MAX_BILLBOARDS || fl.stage === 'out') continue;
      const [size, glow] = fl.stage === 'climb' ? [ft.sparkSizeM, ft.sparkGlow * flareKey] : [ft.discSizeM, ft.discGlow * fl.glow * flareKey];
      this.billboards.set([...fl.position, size / 2, fl.colour[0] * glow, fl.colour[1] * glow, fl.colour[2] * glow, 1, 1], billboards * BILLBOARD_FLOATS);
      billboards++;
    }
    // The far shells seen: each flash a disc on the ground growing over flash_s and fading, emissive;
    // their columns of smoke, puff by puff, lit discs.
    const fs = t.farShells;
    for (const f of battle.flashes) {
      const age = battle.seconds - f.t;
      if (billboards >= MAX_BILLBOARDS || !f.far || age < 0 || age >= fs.flashS) continue;
      const half = (fs.flashSizeM[0] + (fs.flashSizeM[1] - fs.flashSizeM[0]) * (age / fs.flashS)) / 2;
      const glow = fs.flashGlow * (1 - age / fs.flashS);
      this.billboards.set([f.position[0], f.position[1] + half, f.position[2], half, t.distantColour[0] * glow, t.distantColour[1] * glow, t.distantColour[2] * glow, 1, 1], billboards * BILLBOARD_FLOATS);
      billboards++;
    }
    for (const p of battle.smoke) {
      if (billboards >= MAX_BILLBOARDS) break;
      const c = fs.smokeColour;
      this.billboards.set([...p.centre, p.radiusM, c[0] * p.alpha, c[1] * p.alpha, c[2] * p.alpha, p.alpha, 0], billboards * BILLBOARD_FLOATS);
      billboards++;
    }
    // The fires' plumes, drawn as the far shells' smoke is (lit discs) as well as in the haze: the
    // haze's own glow lights its smoke as it lights the haze round it, which at dusk hides it. Before
    // the flames: a disc covers what was drawn before it.
    for (const p of battle.plumes) {
      if (billboards >= MAX_BILLBOARDS) break;
      const c = fs.smokeColour;
      this.billboards.set([...p.centre, p.radiusM, c[0] * p.alpha, c[1] * p.alpha, c[2] * p.alpha, p.alpha, 0], billboards * BILLBOARD_FLOATS);
      billboards++;
    }
    // Their flames and embers: emissive, each its glow over the flames' colour.
    const fc = t.fires.flameColour;
    let flames = 0;
    for (const q of battle.flames) {
      if (billboards >= MAX_BILLBOARDS) break;
      this.billboards.set([...q.centre, q.sizeM / 2, fc[0] * q.glow, fc[1] * q.glow, fc[2] * q.glow, 1, 1], billboards * BILLBOARD_FLOATS);
      billboards++;
      flames++;
    }
    // From here the billboards are the tracers' own (their heads and embers) and other emissive ones:
    // drawn over the ribbons (effects.ts), a tracer's light covering what is behind it.
    const tracerBillboardsFrom = billboards;

    let ribbons = 0;
    /** A ribbon, `look` its style and a tracer's shares (effects.ts RIBBON_FLOATS): false once they are full. */
    const ribbon = (tail: readonly number[], head: readonly number[], width: number, colour: readonly number[], alphaTail: number, alphaHead: number, look: readonly number[] = STAR_LOOK) => {
      if (ribbons >= MAX_RIBBONS) return false;
      this.ribbons.set([tail[0], tail[1], tail[2], width, head[0], head[1], head[2], alphaTail, colour[0], colour[1], colour[2], alphaHead, look[0], look[1], look[2], look[3]], ribbons * RIBBON_FLOATS);
      ribbons++;
      return true;
    };

    // The eye the frame is seen from: a tracer's core is white-hot near it (and by day, at least
    // whiteFloor of that, effects.wgsl's); the battle's nearest it are drawn.
    const eyeAt = eye ?? [session.player.position.x, session.player.position.y + session.controller.eyeHeight(session.player), session.player.position.z];
    const whiteFloor = t.tracerWhiteByDay * daylight;
    // A tracer by its kind (net/gear.ts TRACER_KIND): the battle's amber, a team's red or blue, at
    // its intensity, and brighter by day; a white-hot core in its glow (effects.wgsl's style 1).
    const day = 1 + t.tracerDayBoost * daylight;
    const glows = [t.tracerColour, t.tracerColour, t.tracerColourRed, t.tracerColourBlue].map((c) => c.map((v) => v * t.tracerIntensity * day));
    const tracerLook = [RIBBON_STYLE.tracer, t.tracerCoreWidthM / t.tracerGlowWidthM, t.tracerGlowShare, t.tracerCoreWhite];
    /** How lit in a tracer is `flown` metres out, lit in over `overM` (0: from the muzzle). */
    const ignite = (flown: number, overM: number) => (overM > 0 ? Math.min(1, Math.max(0, flown / overM)) : 1);
    /** A streak `speed` (m/s) asks for: a frame's flight, between tracer_min_m and `maxM`. */
    const streak = (speed: number, maxM: number) => Math.min(maxM, Math.max(t.tracerMinM, speed * t.tracerStreakS));
    let heads = 0;
    /**
     * One tracer-like streak, `tail` to `head` (m), of `kind`, its tail and head `tailFlown` and
     * `headFlown` metres into its flight: its ribbon, fading toward its tail (tracer_tail_alpha), lit
     * in from nothing at the muzzle to full `igniteM` out (its round's, by how aimed its shot was;
     * unless given, a hip shot's, tracer_ignite_hip_m) and full past it. A streak that spans that
     * point (a round's first frame or two, its streak reaching back to the muzzle) is drawn as two
     * ribbons, the ramp up to it and the rest, so it is lit as the law says along its length, not only
     * at its ends. Then its head once it is tracer_head_from_m out, an emissive disc as bright as its
     * core there and more (its colour mixed toward white as effects.wgsl mixes the core's, by its own
     * distance from the eye), held to the pixels it is drawn over as the ribbon is (HEAD_BILLBOARD).
     * False once the ribbons are full; a head is left off once the billboards are. `fade` (0 to 1)
     * dims all of it: a ricochet's burning out.
     */
    const tracer = (tail: readonly number[], head: readonly number[], kind: number, tailFlown: number, headFlown: number, fade = 1, igniteM = t.tracerIgniteHipM): boolean => {
      const colour = glows[kind] ?? glows[TRACER_KIND.amber];
      const lit = ignite(headFlown, igniteM) * fade;
      const fromTail = t.tracerTailAlpha * ignite(tailFlown, igniteM) * fade;
      if (tailFlown < igniteM && igniteM < headFlown) {
        // Where it is fully lit, `u` of the way along, as bright there as the streak's own fade.
        const u = (igniteM - tailFlown) / (headFlown - tailFlown);
        const at = [0, 1, 2].map((k) => tail[k] + (head[k] - tail[k]) * u);
        const there = (t.tracerTailAlpha + (1 - t.tracerTailAlpha) * u) * fade;
        if (!ribbon(tail, at, t.tracerGlowWidthM, colour, fromTail, there, tracerLook)) return false;
        if (!ribbon(at, head, t.tracerGlowWidthM, colour, there, lit, tracerLook)) return false;
      } else if (!ribbon(tail, head, t.tracerGlowWidthM, colour, fromTail, lit, tracerLook)) return false;
      if (headFlown >= t.tracerHeadFromM && billboards < MAX_BILLBOARDS) {
        const hottest = Math.max(colour[0], colour[1], colour[2]);
        const burn = (t.tracerHeadGain * lit) / t.particleGlow;
        // Mixed toward white as the core is at its distance; its alpha how near the eye it is, the draw
        // showing it as white-hot as its core there (effects.wgsl keepHue).
        const metres = Math.hypot(head[0] - eyeAt[0], head[1] - eyeAt[1], head[2] - eyeAt[2]);
        const near = Math.max(tracerNearAt(metres, t), whiteFloor);
        const white = tracerWhiteAt(metres, t, whiteFloor);
        const core = colour.map((c) => (c + (hottest - c) * white) * burn);
        this.billboards.set([head[0], head[1], head[2], t.tracerHeadM / 2, core[0], core[1], core[2], near, HEAD_BILLBOARD], billboards * BILLBOARD_FLOATS);
        billboards++;
        heads++;
      }
      return true;
    };

    // Tracers: the round's streak back along its path, its offset from where it left to where it
    // is drawn from shrinking to nothing where the shot was aimed (its own convergence, Session.aimRange).
    let tracers = 0;
    const drawn: BuiltEffects['drawn'] = [];
    /**
     * A round's streak, `tail` to `head` on its path (m), its head `flown` metres into its flight, of
     * `kind`: drawn from where its tracer leaves, `offset` off its path at the muzzle, the offset
     * shrinking to none `reach` metres out; lit in over `igniteM` (−1 unset: a hip shot's). `lift`,
     * for a round that struck: its head held off what it struck by so much (m). False once the ribbons
     * are full.
     */
    const round = (tail: readonly number[], head: readonly number[], flown: number, offset: readonly number[], reach: number, igniteM: number, kind: number, lift: readonly number[] | null): boolean => {
      const length = Math.hypot(head[0] - tail[0], head[1] - tail[1], head[2] - tail[2]);
      if (!(length > 0)) return true;
      const share = (f: number) => (reach > 0 ? Math.max(0, 1 - f / reach) : 0);
      const h = share(flown);
      const s = share(flown - length);
      const drawnTail = tail.map((v, k) => v + offset[k] * s) as V3;
      const drawnHead = head.map((v, k) => v + offset[k] * h + (lift ? lift[k] : 0)) as V3;
      if (!tracer(drawnTail, drawnHead, kind, flown - length, flown, 1, igniteM >= 0 ? igniteM : t.tracerIgniteHipM)) return false;
      drawn.push({ tail: drawnTail, head: drawnHead, kind, flown, headDrawn: flown >= t.tracerHeadFromM, joinsM: reach, struck: lift !== null });
      tracers++;
      return true;
    };
    let full = false;
    const seg = session.rounds.tracerSegments((speed) => streak(speed, t.tracerMaxM));
    for (let i = 0; i < seg.flown.length && !full; i++) {
      const at = (a: Float32Array) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
      full = !round(at(seg.tail), at(seg.head), seg.flown[i], sub(at(seg.from), at(seg.origin)), seg.converge[i], seg.ignite[i], seg.kind[i], null);
    }
    // The rounds that struck in the frame's ticks, drawn once more, by the same law, at the end of
    // their flight: one whose whole flight fitted in the ticks is seen at all (its tail at the muzzle),
    // and a stream reaches what it struck rather than stopping a tick short. Each joins its path where
    // it struck if that is nearer than where it was aimed, and its head is held off what it struck by
    // its own radius, so the face does not hide half of it: off a face along its normal; off a body,
    // or the voxel a round started in, back along its way.
    const r = t.tracerHeadM / 2;
    const ended: { at: readonly number[]; dir: readonly number[]; flown: number; lift: V3; draw: StrikeDraw }[] = [];
    for (const hit of events.impacts) {
      if (!hit.draw) continue;
      const n = hit.normal;
      const lift: V3 = n[0] === 0 && n[1] === 0 && n[2] === 0 ? [-hit.dir[0] * r, -hit.dir[1] * r, -hit.dir[2] * r] : [n[0] * r, n[1] * r, n[2] * r];
      ended.push({ at: hit.position, dir: hit.dir, flown: hit.distance, lift, draw: hit.draw });
    }
    for (const hit of events.hits) if (hit.draw) ended.push({ at: hit.position, dir: hit.dir, flown: hit.distance, lift: [-hit.dir[0] * r, -hit.dir[1] * r, -hit.dir[2] * r], draw: hit.draw });
    for (const e of ended) {
      if (full) break;
      const d = e.draw;
      const back = Math.min(streak(d.speed, t.tracerMaxM), e.flown);
      const tail = [0, 1, 2].map((k) => e.at[k] - e.dir[k] * back);
      full = !round(tail, e.at, e.flown, sub(d.from, d.origin), Math.min(d.convergeM, e.flown), d.igniteM, d.kind, e.lift);
    }

    // Tracer strikes' embers, small emissive discs of their tracer's colour fading out, kept at its
    // hue as a far tracer is (EMBER_BILLBOARD, its alpha its whiteness: none, but by day); and the ricochets in
    // flight, drawn as the tracers are, long past their lighting in (they left a wall, not a muzzle),
    // fading as they burn out.
    let embers = 0;
    const embersByKind = [0, 0, 0, 0];
    const glowing = this.ricochets.embers();
    for (const d of this.debugEmbers) glowing.push({ at: d.at, size: t.ricochet.emberM, kind: d.kind, alpha: 1 });
    for (const e of glowing) {
      if (billboards >= MAX_BILLBOARDS) break;
      const colour = glows[e.kind] ?? glows[TRACER_KIND.amber];
      const burn = (t.tracerHeadGain * e.alpha) / t.particleGlow;
      this.billboards.set([e.at[0], e.at[1], e.at[2], e.size / 2, colour[0] * burn, colour[1] * burn, colour[2] * burn, whiteFloor, EMBER_BILLBOARD], billboards * BILLBOARD_FLOATS);
      billboards++;
      embers++;
      if (e.kind >= 0 && e.kind < embersByKind.length) embersByKind[e.kind]++;
    }
    let ricochets = 0;
    const ricochetsByKind = [0, 0, 0, 0];
    for (const f of this.ricochets.flights()) {
      if (!(Math.hypot(f.head[0] - f.tail[0], f.head[1] - f.tail[1], f.head[2] - f.tail[2]) > 0)) continue;
      if (!tracer(f.tail, f.head, f.kind, LONG_FLOWN, LONG_FLOWN, f.alpha)) break;
      ricochets++;
      if (f.kind >= 0 && f.kind < ricochetsByKind.length) ricochetsByKind[f.kind]++;
    }

    // Each live flash: its star and its light, at the drawn muzzle (where the shot left it when
    // the rifle is not drawn).
    let stars = 0;
    const lights: TransientLight[] = [];
    const flash = t.flashColour.map((c) => c * t.flashIntensity);
    for (const f of this.flashes) {
      const at = f.remote ? f.muzzle : (muzzle ?? f.muzzle);
      const d = f.remote ? f.dir : (bore ?? f.dir);
      let side: V3 = [d[2], 0, -d[0]];
      const level = Math.hypot(side[0], side[2]);
      side = level > 1e-6 ? [side[0] / level, 0, side[2] / level] : [1, 0, 0];
      const up: V3 = [d[1] * side[2] - d[2] * side[1], d[2] * side[0] - d[0] * side[2], d[0] * side[1] - d[1] * side[0]];
      // A suppressed shot: no star, and a glimmer of its light.
      const rays: [V3, number][] = f.share < 0.5 ? [] : [[d, t.flashStarLengthM * Math.min(1.4, f.share)]];
      if (f.share >= 0.5) {
        for (const sign of [1, -1]) {
          const r = [0, 1, 2].map((k) => d[k] * Math.cos(STAR_SIDE) + sign * side[k] * Math.sin(STAR_SIDE) + up[k] * STAR_LIFT);
          const n = Math.hypot(r[0], r[1], r[2]);
          rays.push([[r[0] / n, r[1] / n, r[2] / n], t.flashStarLengthM * STAR_SIDE_LENGTH * Math.min(1.4, f.share)]);
        }
      }
      for (const [r, length] of rays) {
        if (ribbon(at, at.map((v, k) => v + r[k] * length), t.flashStarWidthM, flash, 1, 0)) stars++;
      }
      lights.push({ position: at, radiusM: t.flashLightRadiusM, colour: t.flashLightColour, intensity: t.flashLightIntensity * f.share });
    }

    // The guns' lights and lasers, switched on: the player's from the drawn gun along its bore, each
    // other's from theirs, to where the beam strikes the world.
    const beams: { from: V3; dir: V3; kind: 'flashlight' | 'laser' }[] = [];
    if (rifle && bore && session.lightOn && session.held !== SHOVEL_HELD && arm.beam && arm.fit.side !== 'none') beams.push({ from: throughPose(rifle.toWorld, arm.beam), dir: bore, kind: arm.fit.side });
    for (const o of others) {
      const g = decodeGear(o.gear ?? 0);
      if (!g.light || g.gun === null || g.fit.side === 'none') continue;
      const from = beamOf(g.gun, g.fit);
      if (from) beams.push({ from: toWorld(o.frames.rifle, from), dir: unit(o.frames.rifle.z), kind: g.fit.side });
    }
    const lt = t.light;
    for (const b of beams) {
      const v = session.voxel;
      const hit = raycast(session.map, [b.from[0] / v, b.from[1] / v, b.from[2] / v], b.dir, lt.rangeM / v);
      if (!hit) continue;
      const reach = hit.t * v;
      const at = b.from.map((c, k) => c + b.dir[k] * reach);
      if (b.kind === 'laser') {
        if (billboards >= MAX_BILLBOARDS) continue;
        const g = t.laser.glow;
        const c = t.laser.colour;
        this.billboards.set([at[0] - b.dir[0] * 0.02, at[1] - b.dir[1] * 0.02, at[2] - b.dir[2] * 0.02, t.laser.sizeM / 2, c[0] * g, c[1] * g, c[2] * g, 1, 1], billboards * BILLBOARD_FLOATS);
        billboards++;
      } else {
        // A pool of light a little short of where it strikes, wider and dimmer the farther.
        const share = Math.min(1, reach / lt.rangeM);
        const radius = lt.radiusM[0] + (lt.radiusM[1] - lt.radiusM[0]) * share;
        const back = Math.min(reach * 0.5, radius * 0.35);
        lights.push({ position: [at[0] - b.dir[0] * back, at[1] - b.dir[1] * back, at[2] - b.dir[2] * back], radiusM: radius, colour: lt.colour, intensity: lt.intensity * (1 - 0.6 * share) });
      }
    }
    for (const r of this.debugRibbons) ribbon(r.tail, r.head, r.width, r.colour, 1, 1);
    for (const r of this.debugTracers) tracer(r.tail, r.head, r.kind, LONG_FLOWN, LONG_FLOWN);
    lights.push(...this.debugLights);

    // The battle's tracers, after the session's own: drawn as theirs are, the head at the round and
    // its streak back along its way, at most battleTrailM (or its flight since it was fired or
    // struck, if shorter); the nearest the eye, at most maxBattleTracers.
    const offEye = (p: readonly number[]) => (p[0] - eyeAt[0]) ** 2 + (p[1] - eyeAt[1]) ** 2 + (p[2] - eyeAt[2]) ** 2;
    const nearest = [...battle.tracers].sort((a, b) => offEye(a.position) - offEye(b.position)).slice(0, t.maxBattleTracers);
    let battleTracers = 0;
    for (const tr of nearest) {
      const speed = Math.hypot(tr.velocity[0], tr.velocity[1], tr.velocity[2]);
      if (!(speed > 0)) continue;
      const trailM = Math.min(streak(speed, t.battleTrailM), tr.flown);
      const tail = [0, 1, 2].map((k) => tr.position[k] - (tr.velocity[k] * trailM) / speed);
      // A leg after a strike is lit as the whole flight was: its ignition is the muzzle's.
      const lit = tr.carried ?? 0;
      if (!tracer(tail, tr.position, TRACER_KIND.amber, lit + tr.flown - trailM, lit + tr.flown)) break;
      battleTracers++;
    }

    // Each shell's blast: a light a metre over where it landed, flaring and dying over blast_light_s.
    const blasts: TransientLight[] = this.landed
      .filter((b) => b.age < t.blastLightS)
      .map((b) => ({
        position: [b.at[0], b.at[1] + 1, b.at[2]],
        radiusM: t.blastLightRadiusM,
        colour: t.blastLightColour,
        intensity: t.blastLightIntensity * (1 - b.age / t.blastLightS) ** 2,
      }));
    blasts.push(...this.debugBlasts);

    // Each shell's smoke: smoke_puffs puffs, one over the crater and the rest a third of its radius
    // aside, rising, spreading and thinning to nothing by smoke_s; with the fires' plumes, the
    // nearest the eye drawn.
    const from = eyeAt;
    const puffs: SmokePuff[] = [];
    for (const b of this.landed) {
      if (b.age >= t.smokeS) continue;
      const r0 = t.smokeRadiusScale * b.radiusM;
      const turn = (((b.at[0] * 12.9898 + b.at[2] * 78.233) % TAU) + TAU) % TAU;
      for (let k = 0; k < t.smokePuffs; k++) {
        const aside = k === 0 ? 0 : b.radiusM / 3;
        const a = turn + (TAU * (k - 1)) / Math.max(1, t.smokePuffs - 1);
        puffs.push({
          centre: [b.at[0] + Math.cos(a) * aside, b.at[1] + r0 * (k === 0 ? 1 : 0.6) + t.smokeRiseMS * b.age, b.at[2] + Math.sin(a) * aside],
          radiusM: r0 + t.smokeSpreadMS * b.age,
          density: t.smokeDensity * (1 - b.age / t.smokeS) ** 2,
        });
      }
    }
    const far = (p: SmokePuff) => Math.hypot(p.centre[0] - from[0], p.centre[1] - from[1], p.centre[2] - from[2]);
    for (const p of battle.plumes) puffs.push({ centre: [p.centre[0], p.centre[1], p.centre[2]], radiusM: p.radiusM, density: p.density });
    const smoke = [...this.debugSmoke, ...puffs.sort((a, b) => far(a) - far(b))].slice(0, MAX_PUFFS);

    return {
      frame: { billboards: this.billboards, billboardCount: billboards, ribbons: this.ribbons, ribbonCount: ribbons, whiteFloor, cover, tracerBillboardsFrom },
      lights,
      blasts,
      smoke,
      counts: { billboards, tracers, stars, lights: lights.length, battleTracers, flames, heads, ricochets, embers, ricochetsByKind, embersByKind },
      drawn,
    };
  }
}
