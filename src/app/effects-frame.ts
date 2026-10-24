/**
 * A frame's effects, from the session, the events the frame drained and the
 * rifle as it is drawn: the particles' billboards, the shot's flash and brass
 * leaving the drawn rifle; each tracer round's ribbon, 7 m back from its head,
 * the player's drawn from the rifle's muzzle and joining the round's path by
 * `tracer_converge_m` (the round leaves the eye, so the reticle tells the
 * truth); and each shot's flash — a star of three ribbons from the drawn
 * muzzle along its bore and a transient light there — for `flash_s` of the
 * world's time, so as long at any frame rate and held while paused (spec §4).
 * The simulation's muzzle is the bare eye's at the tick; the drawn rifle's
 * follows the interpolated, bobbing eye, centimetres away while walking.
 */

import type { DistantShell } from '../battle/director';
import { farShellTunables, type ColumnPuff, type FarShellTunables } from '../battle/far-shells';
import { flareTunables, type FlareState, type FlareTunables } from '../battle/flares';
import { tracerTunables, type TracerState } from '../battle/tracers';
import { BILLBOARD_FLOATS } from '../combat/particles';
import { RIFLE_MUZZLE, RIFLE_PORT } from '../combat/rifle-model';
import type { Tunables } from '../core/tunables';
import { MAX_BILLBOARDS, MAX_RIBBONS, RIBBON_FLOATS, type EffectsFrame, type SmokePuff, type TransientLight } from '../render/effects';
import { MAX_PUFFS } from '../render/frame-uniforms';
import { throughPose, type RiflePose } from '../render/rifle';
import { MUZZLE_ANCHOR, PORT_ANCHOR, type CombatEvents, type Session } from '../sim/session';

type V3 = [number, number, number];

/** The battle as a frame draws it (src/battle/director.ts): at its moment, its flares, its newest distant shells' flashes, the far shells' smoke, and the machine guns' tracers. */
export interface ShownBattle {
  seconds: number;
  flares: readonly FlareState[];
  flashes: readonly DistantShell[];
  smoke: readonly ColumnPuff[];
  tracers: readonly TracerState[];
}

/** No battle drawn: at rest, as the approved views are measured. */
export const NO_BATTLE: ShownBattle = { seconds: 0, flares: [], flashes: [], smoke: [], tracers: [] };

export interface EffectsTunables {
  /** The battle's flares, as they are seen: their sparks climbing and discs burning. */
  flares: FlareTunables;
  /** The far shells, as they are seen: their flash's disc and their columns of smoke. */
  farShells: FarShellTunables;
  /** A distant shell's flash's colour ([battle.flashes]). */
  distantColour: V3;
  /** The most of the battle's tracers drawn, the nearest the eye, and the trail each is drawn with. */
  maxBattleTracers: number;
  battleTrailM: number;
  tracerLengthM: number;
  tracerWidthM: number;
  tracerColour: V3;
  tracerIntensity: number;
  tracerTailAlpha: number;
  tracerConvergeM: number;
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
    distantColour: tun.triple('battle.flashes.colour'),
    maxBattleTracers: tracerTunables(tun).maxDrawn,
    battleTrailM: tracerTunables(tun).trailM,
    tracerLengthM: f('tracer_length_m'),
    tracerWidthM: f('tracer_width_m'),
    tracerColour: rgb(tun, 'effects.tracer_colour'),
    tracerIntensity: f('tracer_intensity'),
    tracerTailAlpha: f('tracer_tail_alpha'),
    tracerConvergeM: f('tracer_converge_m'),
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

/** A test's ribbon: emissive, as a tracer is, as bright at its tail as its head. */
export interface DebugRibbon {
  tail: V3;
  head: V3;
  width: number;
  colour: V3;
}

export interface BuiltEffects {
  frame: EffectsFrame;
  lights: TransientLight[];
  /** Shells' blasts, lighting the world shadowed (renderer.setBlasts). */
  blasts: TransientLight[];
  /** Their smoke in the haze, the nearest MAX_PUFFS puffs (renderer.setSmoke). */
  smoke: SmokePuff[];
  counts: { billboards: number; tracers: number; stars: number; lights: number; battleTracers: number };
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

export class EffectsFrameBuilder {
  /** Quads and transient lights a test asks for, every frame until it asks for none. */
  debug: DebugQuad[] = [];
  debugRibbons: DebugRibbon[] = [];
  debugLights: TransientLight[] = [];
  debugBlasts: TransientLight[] = [];
  debugSmoke: SmokePuff[] = [];
  /** Where the last frame's test quads start among its billboards. */
  debugAt = 0;
  private readonly billboards = new Float32Array(MAX_BILLBOARDS * BILLBOARD_FLOATS);
  private readonly ribbons = new Float32Array(MAX_RIBBONS * RIBBON_FLOATS);
  private flashes: { muzzle: V3; dir: V3; age: number }[] = [];
  /** Shells landed, aged as the flashes are, while their light or their smoke lasts. */
  private landed: { at: V3; radiusM: number; age: number }[] = [];
  /** The world's time the last frame showed. */
  private shown: number | null = null;

  constructor(readonly t: EffectsTunables) {}

  /**
   * `rifle`: the rifle as this frame draws it, or null when it is not drawn; `eye`: the camera
   * (metres), the player's eye if not given; `battle`, the battle seen, its flares dimmed by the
   * sky's flares key `flareKey` as their light is.
   */
  build(session: Session, events: CombatEvents, rifle: RiflePose | null = null, eye?: readonly number[], battle: ShownBattle = NO_BATTLE, flareKey = 1): BuiltEffects {
    const t = this.t;
    // Flashes age with the world's time as the frame shows it: none while paused.
    const shown = (session.ticks + session.clock.alpha) * session.clock.dt;
    const elapsed = this.shown === null ? 0 : Math.max(0, shown - this.shown);
    this.shown = shown;
    for (const f of this.flashes) f.age += elapsed;
    this.flashes = this.flashes.filter((f) => f.age < t.flashS);
    for (const shot of events.shots) this.flashes.push({ muzzle: shot.muzzle, dir: shot.dir, age: 0 });
    for (const b of this.landed) b.age += elapsed;
    this.landed = this.landed.filter((b) => b.age < Math.max(t.blastLightS, t.smokeS));
    for (const b of events.blasts) this.landed.push({ at: b.at, radiusM: b.radiusM, age: 0 });

    // The drawn rifle's muzzle and bore, and how far it is drawn from where the simulation holds it.
    const muzzle = rifle ? throughPose(rifle.toWorld, RIFLE_MUZZLE) : null;
    const bore = rifle ? unit([rifle.toWorld[6], rifle.toWorld[7], rifle.toWorld[8]]) : null;
    const drift: V3[] = [];
    if (muzzle && rifle) {
      drift[MUZZLE_ANCHOR - 1] = sub(muzzle, session.muzzle());
      drift[PORT_ANCHOR - 1] = sub(throughPose(rifle.toWorld, RIFLE_PORT), session.port());
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

    let ribbons = 0;
    const ribbon = (tail: readonly number[], head: readonly number[], width: number, colour: readonly number[], alphaTail: number, alphaHead: number) => {
      if (ribbons >= MAX_RIBBONS) return false;
      this.ribbons.set([tail[0], tail[1], tail[2], width, head[0], head[1], head[2], alphaTail, colour[0], colour[1], colour[2], alphaHead], ribbons * RIBBON_FLOATS);
      ribbons++;
      return true;
    };

    // Tracers: the round's last tracer_length_m, its offset from where it left to where it is
    // drawn from shrinking to nothing by tracer_converge_m.
    let tracers = 0;
    const seg = session.rounds.tracerSegments(t.tracerLengthM);
    const glow = t.tracerColour.map((c) => c * t.tracerIntensity);
    for (let i = 0; i < seg.flown.length; i++) {
      const at = (a: Float32Array) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
      const head = at(seg.head);
      const tail = at(seg.tail);
      const length = Math.hypot(head[0] - tail[0], head[1] - tail[1], head[2] - tail[2]);
      if (!(length > 0)) continue;
      const from = at(seg.from);
      const origin = at(seg.origin);
      const offset = [from[0] - origin[0], from[1] - origin[1], from[2] - origin[2]];
      const share = (flown: number) => Math.max(0, 1 - flown / t.tracerConvergeM);
      const h = share(seg.flown[i]);
      const s = share(seg.flown[i] - length);
      if (!ribbon(tail.map((v, k) => v + offset[k] * s), head.map((v, k) => v + offset[k] * h), t.tracerWidthM, glow, t.tracerTailAlpha, 1)) break;
      tracers++;
    }

    // Each live flash: its star and its light, at the drawn muzzle (where the shot left it when
    // the rifle is not drawn).
    let stars = 0;
    const lights: TransientLight[] = [];
    const flash = t.flashColour.map((c) => c * t.flashIntensity);
    for (const f of this.flashes) {
      const at = muzzle ?? f.muzzle;
      const d = bore ?? f.dir;
      let side: V3 = [d[2], 0, -d[0]];
      const level = Math.hypot(side[0], side[2]);
      side = level > 1e-6 ? [side[0] / level, 0, side[2] / level] : [1, 0, 0];
      const up: V3 = [d[1] * side[2] - d[2] * side[1], d[2] * side[0] - d[0] * side[2], d[0] * side[1] - d[1] * side[0]];
      const rays: [V3, number][] = [[d, t.flashStarLengthM]];
      for (const sign of [1, -1]) {
        const r = [0, 1, 2].map((k) => d[k] * Math.cos(STAR_SIDE) + sign * side[k] * Math.sin(STAR_SIDE) + up[k] * STAR_LIFT);
        const n = Math.hypot(r[0], r[1], r[2]);
        rays.push([[r[0] / n, r[1] / n, r[2] / n], t.flashStarLengthM * STAR_SIDE_LENGTH]);
      }
      for (const [r, length] of rays) {
        if (ribbon(at, at.map((v, k) => v + r[k] * length), t.flashStarWidthM, flash, 1, 0)) stars++;
      }
      lights.push({ position: at, radiusM: t.flashLightRadiusM, colour: t.flashLightColour, intensity: t.flashLightIntensity });
    }
    for (const r of this.debugRibbons) ribbon(r.tail, r.head, r.width, r.colour, 1, 1);
    lights.push(...this.debugLights);

    // The battle's tracers, after the session's own: drawn as theirs are, the head at the round and
    // its trail battleTrailM back along its way (or its flight since it was fired or struck, if
    // shorter); the nearest the eye, at most maxBattleTracers.
    const eyeAt = eye ?? [session.player.position.x, session.player.position.y + session.controller.eyeHeight(session.player), session.player.position.z];
    const offEye = (p: readonly number[]) => (p[0] - eyeAt[0]) ** 2 + (p[1] - eyeAt[1]) ** 2 + (p[2] - eyeAt[2]) ** 2;
    const nearest = [...battle.tracers].sort((a, b) => offEye(a.position) - offEye(b.position)).slice(0, t.maxBattleTracers);
    let battleTracers = 0;
    for (const tr of nearest) {
      const speed = Math.hypot(tr.velocity[0], tr.velocity[1], tr.velocity[2]);
      if (!(speed > 0)) continue;
      const trail = Math.min(t.battleTrailM, tr.flown) / speed;
      const tail = [0, 1, 2].map((k) => tr.position[k] - tr.velocity[k] * trail);
      if (!ribbon(tail, tr.position, t.tracerWidthM, glow, t.tracerTailAlpha, 1)) break;
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
    // aside, rising, spreading and thinning to nothing by smoke_s; the nearest the eye drawn.
    const from = eye ?? [session.player.position.x, session.player.position.y + session.controller.eyeHeight(session.player), session.player.position.z];
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
    const smoke = [...this.debugSmoke, ...puffs.sort((a, b) => far(a) - far(b))].slice(0, MAX_PUFFS);

    return {
      frame: { billboards: this.billboards, billboardCount: billboards, ribbons: this.ribbons, ribbonCount: ribbons },
      lights,
      blasts,
      smoke,
      counts: { billboards, tracers, stars, lights: lights.length, battleTracers },
    };
  }
}
