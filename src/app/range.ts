/**
 * The range in the app (the shots spec's §5): solo play's dummies and steel plates out in front of
 * the spawn bay, by combat/range.ts's rules, put into the world, the soldiers and the session.
 *
 * - **When:** in solo play only (rangeAllowed): never in a room, a check run, or with ?range=0. It
 *   goes up at the click that starts play, so the page's still and the approved views are as they
 *   were, and in tests only when a test asks (hooks.range).
 * - **Up** (raise): laid out over the world (rangeLayout, given the world's plan, so no spot stands
 *   in a trench, and the eye of a player standing on the spawn bay's firing step, so every target
 *   laid is in their sight); its plates and their posts written into it, every voxel they replace
 *   kept; the solo artillery's shells kept [range] range_shell_clear_m off every spot (a mover's
 *   walk too).
 * - **Down** (lower): every voxel the plates wrote put back as it was, whatever has struck them since.
 *   What the world did round them, blood on the ground or a crater, is the world's, and stays.
 * - **Each frame, before its ticks** (frame): the dummies posed as soldiers by the range's own gaits,
 *   in Blue's uniform with hunter-orange tape and the bare AK at rest, for the app to draw after any
 *   others in the renderer's eight slots. Their strides go on by the range's own time, the session's
 *   since the last frame, so a range whose session does not tick (paused, or flying) stands still.
 *   The standing ones are the session's targets: bodies only the player's rounds strike. A dummy
 *   down is drawn lying and is no target, as a dead body is not hit. They never go to
 *   together.prepare, whose bodies everyone's rounds strike. The figures, the bodies and the list of
 *   targets are kept from frame to frame and brought up to date in place.
 * - **After the ticks** (after): the player's rounds into the dummies (body 200 on) and into target
 *   steel, as the range's events, oldest first. A hit; a kill, with the shots it took, a shot being
 *   a pull of the trigger, told by the pull each round carries to what it strikes (the tick it left
 *   on), so a shotgun's pellets are one, and a round still in the air as the next pull leaves is
 *   its own; a plate, the voxel struck repainted lead-grey (TARGET_STEEL_HIT). Others' rounds only
 *   spark off the steel. A frame with none gives one shared empty list.
 */

import { FIRST_DUMMY, plateCentre, plateVoxels, Range, rangeLayout, rangeTunables, type RangeBay, type RangeEvent, type RangeTunables } from '../combat/range';
import type { Tunables } from '../core/tunables';
import { Stance } from '../physics/character';
import type { SoldierDraw } from '../render/soldiers';
import type { Body, CombatEvents, Session } from '../sim/session';
import type { BrickMap } from '../world/bricks';
import { P } from '../world/materials';
import { Gaits, type Figure } from './together';

/** What a frame of a range that is down gives, and one whose ticks did nothing on it: one list each, never written. */
const NO_DRAWS: readonly SoldierDraw[] = Object.freeze([]);
const NO_FIGURES: readonly Figure[] = Object.freeze([]);
const NO_EVENTS: readonly RangeEvent[] = Object.freeze([]);

/** Whether the range may stand: in solo play, not in a check run, and not asked away (`?range=0`). */
export function rangeAllowed(o: { room: boolean; check: boolean; param: string | null }): boolean {
  return !o.room && !o.check && o.param !== '0';
}

/** Where the range is laid from: the spawn (foot centre, metres) and its bay. */
export interface RangeSpawn {
  position: readonly [number, number, number];
  bay: RangeBay;
}

/**
 * The range as it stands, for the hooks: its dummies (body ids 200 on; where their feet are, their
 * health, whether down) and its plates (numbered as laid, torso then head; the middle of their
 * steel, metres; the player's rounds into them).
 */
export interface RangeState {
  up: boolean;
  dummies: { id: number; position: [number, number, number]; hp: number; down: boolean }[];
  plates: { index: number; at: [number, number, number]; hits: number }[];
}

/** The range up: the world it stands in and its rules; its plates; and every voxel it wrote. */
interface Up {
  map: BrickMap;
  range: Range;
  plates: { at: [number, number, number]; hits: number }[];
  /** Each steel voxel's plate, by the voxel's key. */
  steel: Map<number, number>;
  /** Each voxel written, by its key: where, and what it replaced. */
  written: Map<number, [number, number, number, number]>;
  /** One figure a dummy, and one body (from its first frame), brought up to date each frame; the targets, the standing ones' bodies. */
  figures: Figure[];
  bodies: Body[];
  targets: Body[];
  /** The range's time at the last frame, or null before its first: the gaits step on by the time since. */
  posedAt: number | null;
}

export class RangeView {
  readonly t: RangeTunables;
  /** How near a spot no shell lands while the range stands, metres ([range] range_shell_clear_m). */
  readonly shellClearM: number;
  private readonly gaits = new Gaits();
  private on: Up | null = null;
  /** The seconds the range was last brought to: its clock, which never goes back. */
  private now = 0;

  constructor(tun: Tunables) {
    this.t = rangeTunables(tun);
    this.shellClearM = tun.f('range.range_shell_clear_m');
  }

  get up(): boolean {
    return this.on !== null;
  }

  /**
   * Up in `session`'s world, laid out from `spawn` and sighted from `eye` (metres: a player's standing
   * on the spawn bay's firing step, the step view's); up already, nothing changes.
   */
  raise(session: Session, spawn: RangeSpawn, eye: readonly [number, number, number]): void {
    if (this.on) return;
    const map = session.map;
    const v = session.voxel;
    const spots = rangeLayout(map, v, spawn, this.t, session.plan, eye);
    const written = new Map<number, [number, number, number, number]>();
    const steel = new Map<number, number>();
    const plates: Up['plates'] = [];
    for (const spot of spots) {
      const voxels = plateVoxels(spot, v, this.t, spawn.bay);
      if (voxels.length === 0) continue;
      const index = plates.length;
      for (const [x, y, z, p] of voxels) {
        if (!map.inBounds(x, y, z)) continue;
        const k = keyOf(map, x, y, z);
        if (!written.has(k)) written.set(k, [x, y, z, map.get(x, y, z)]);
        map.set(x, y, z, p);
        if (p === P.TARGET_STEEL) steel.set(k, index);
      }
      // Its steel's middle: where the layout sighted it.
      plates.push({ at: plateCentre(voxels, v), hits: 0 });
    }
    this.now = Math.max(this.now, session.ticks * session.clock.dt);
    const range = new Range(spots, this.t, spawn.bay);
    // Blue's, in hunter-orange tape, the bare AK at rest, as tall as the player stands.
    const height = session.controller.t.stances[Stance.STANDING].height;
    const figures = range.figures(this.now).map((f): Figure => ({ seat: f.id, team: 'blue', position: f.position, velocity: f.velocity, yaw: f.yaw, pitch: 0, height, deadFor: f.deadFor, gear: 0, tape: P.TAPE_RANGE }));
    this.on = { map, range, plates, steel, written, figures, bodies: [], targets: [], posedAt: null };
    session.artillery.setExclusion(spots.map((s) => ({ x: s.at[0], z: s.at[2], r: this.shellClearM + (s.kind === 'mover' ? this.t.moverSpanM / 2 : 0) })));
  }

  /** Down: every voxel it wrote as it was, no targets, the shells anywhere again; down already, nothing changes. */
  lower(session: Session): void {
    const on = this.on;
    if (!on) return;
    for (const [x, y, z, was] of on.written.values()) on.map.set(x, y, z, was);
    this.on = null;
    session.targets = [];
    session.artillery.setExclusion([]);
  }

  /**
   * The dummies at `nowS` (the session's seconds) as figures: Blue's, in hunter-orange tape, the bare
   * AK at rest, standing as tall as the player stands. The same figures each time, brought to
   * `nowS`; none while down.
   */
  figures(nowS: number): readonly Figure[] {
    const on = this.on;
    if (!on) return NO_FIGURES;
    const posed = on.range.figures(this.clock(nowS));
    for (let i = 0; i < posed.length; i++) {
      const f = posed[i];
      const g = on.figures[i];
      g.position = f.position;
      g.velocity = f.velocity;
      g.yaw = f.yaw;
      g.deadFor = f.deadFor;
    }
    return on.figures;
  }

  /**
   * Before the frame's ticks, at `nowS` (the session's seconds): the dummies posed as soldiers, for
   * the app to draw after any others; the standing ones given to the session as its targets. Their
   * strides go on by the range's time since the last frame, none while the session does not tick.
   * None while down.
   */
  frame(session: Session, nowS: number): readonly SoldierDraw[] {
    const on = this.on;
    if (!on) return NO_DRAWS;
    const now = this.clock(nowS);
    const step = on.posedAt === null ? 0 : now - on.posedAt;
    on.posedAt = now;
    const figures = this.figures(now);
    const draws = this.gaits.pose(figures, step);
    const targets = on.targets;
    targets.length = 0;
    for (let i = 0; i < draws.length; i++) {
      const d = draws[i];
      let body = on.bodies[i];
      if (body) {
        body.frames = d.frames;
        body.feet = d.feet;
      } else on.bodies[i] = body = { id: d.seat, frames: d.frames, feet: d.feet };
      if (figures[i].deadFor === null) targets.push(body);
    }
    session.targets = targets;
    return draws;
  }

  /**
   * After the frame's ticks, at `nowS` (the session's seconds): what the player's rounds did on the
   * range, oldest first. Each hit on a dummy counts the pull of the trigger its round left on
   * (BodyHit.shot, the tick of that pull's shot), whatever tick it struck on. None while down, or
   * when no round of the player's struck a dummy or the range's steel: one shared empty list.
   */
  after(events: CombatEvents, nowS: number): readonly RangeEvent[] {
    const on = this.on;
    if (!on) return NO_EVENTS;
    const now = this.clock(nowS);
    let out: RangeEvent[] | null = null;
    let ticks: number[] | null = null;
    for (const h of events.hits) {
      if (h.owner !== 0 || h.body < FIRST_DUMMY) continue;
      // Every pull of the player's says itself on its rounds (session.combat); a round that says
      // none (fired into the pool by hand) counts as a pull of the tick it struck on.
      const e = on.range.hit(h.body, h.zone, h.gun, h.distance, h.shot ?? h.tick, now);
      if (!e) continue;
      (out ??= []).push(e);
      (ticks ??= []).push(h.tick);
    }
    for (const i of events.impacts) {
      if (i.owner !== 0 || (i.material !== P.TARGET_STEEL && i.material !== P.TARGET_STEEL_HIT)) continue;
      const [x, y, z] = i.cell;
      const index = on.steel.get(keyOf(on.map, x, y, z));
      if (index === undefined) continue;
      on.map.set(x, y, z, P.TARGET_STEEL_HIT);
      on.plates[index].hits++;
      (out ??= []).push(on.range.plate(index, i.distance));
      (ticks ??= []).push(i.tick);
    }
    if (out === null || ticks === null) return NO_EVENTS;
    // Oldest first, and stable: a tick's dummies before its plates, each as the rounds struck. A
    // frame's are few, so an insertion sort; one alone needs none.
    if (out.length > 1) {
      for (let i = 1; i < out.length; i++) {
        const e = out[i];
        const tick = ticks[i];
        let j = i;
        for (; j > 0 && ticks[j - 1] > tick; j--) {
          out[j] = out[j - 1];
          ticks[j] = ticks[j - 1];
        }
        out[j] = e;
        ticks[j] = tick;
      }
    }
    return out;
  }

  /** The range as it stands, at the time it was last brought to. */
  state(): RangeState {
    const on = this.on;
    if (!on) return { up: false, dummies: [], plates: [] };
    const now = this.now;
    return {
      up: true,
      dummies: on.range.figures(now).map((f) => ({ id: f.id, position: f.position, hp: on.range.health(f.id, now), down: f.deadFor !== null })),
      plates: on.plates.map((p, index) => ({ index, at: [p.at[0], p.at[1], p.at[2]], hits: p.hits })),
    };
  }

  /** The range's clock brought to `nowS`, never back. */
  private clock(nowS: number): number {
    this.now = Math.max(this.now, nowS);
    return this.now;
  }
}

/** A voxel's key in `map`: its index, x fastest. */
function keyOf(map: BrickMap, x: number, y: number, z: number): number {
  return (z * map.dims.y + y) * map.dims.x + x;
}
