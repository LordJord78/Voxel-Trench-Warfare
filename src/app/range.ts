/**
 * The range in the app (the shots spec's §5): solo play's dummies and steel plates out in front of
 * the spawn bay, by combat/range.ts's rules, put into the world, the soldiers and the session.
 *
 * - **When:** in solo play only (rangeAllowed): never in a room, a check run, or with ?range=0. It
 *   goes up at the click that starts play, so the page's still and the approved views are as they
 *   were, and in tests only when a test asks (hooks.range).
 * - **Up** (raise): laid out over the world (rangeLayout, given the world's plan, so no spot stands
 *   in a trench); its plates and their posts written into it, every voxel they replace kept; the
 *   solo artillery's shells kept [range] range_shell_clear_m off every spot (a mover's walk too).
 * - **Down** (lower): every voxel the plates wrote put back as it was, whatever has struck them since.
 *   What the world did round them, blood on the ground or a crater, is the world's, and stays.
 * - **Each frame, before its ticks** (frame): the dummies posed as soldiers by the range's own gaits,
 *   in Blue's uniform with hunter-orange tape and the bare AK at rest, for the app to draw after any
 *   others in the renderer's eight slots. The standing ones are the session's targets: bodies only
 *   the player's rounds strike. A dummy down is drawn lying and is no target, as a dead body is not
 *   hit. They never go to together.prepare, whose bodies everyone's rounds strike.
 * - **After the ticks** (after): the player's rounds into the dummies (body 200 on) and into target
 *   steel, as the range's events, oldest first. A hit; a kill, with the shots it took, a shot being
 *   a pull of the trigger, told by the shots' ticks (a shotgun's pellets are one); a plate, the voxel
 *   struck repainted lead-grey (TARGET_STEEL_HIT). Others' rounds only spark off the steel.
 */

import { FIRST_DUMMY, plateVoxels, Range, rangeLayout, rangeTunables, type RangeBay, type RangeEvent, type RangeTunables } from '../combat/range';
import type { Tunables } from '../core/tunables';
import { Stance } from '../physics/character';
import type { SoldierDraw } from '../render/soldiers';
import type { CombatEvents, Session } from '../sim/session';
import type { BrickMap } from '../world/bricks';
import { P } from '../world/materials';
import { Gaits, type Figure } from './together';

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
}

export class RangeView {
  readonly t: RangeTunables;
  /** How near a spot no shell lands while the range stands, metres ([range] range_shell_clear_m). */
  readonly shellClearM: number;
  private readonly gaits = new Gaits();
  private on: Up | null = null;
  /** The seconds the range was last brought to: its clock, which never goes back. */
  private now = 0;
  /** The tick of the player's latest shot the events have told. */
  private lastShot = -1;

  constructor(tun: Tunables) {
    this.t = rangeTunables(tun);
    this.shellClearM = tun.f('range.range_shell_clear_m');
  }

  get up(): boolean {
    return this.on !== null;
  }

  /** Up in `session`'s world, laid out from `spawn`; up already, nothing changes. */
  raise(session: Session, spawn: RangeSpawn): void {
    if (this.on) return;
    const map = session.map;
    const v = session.voxel;
    const spots = rangeLayout(map, v, spawn, this.t, session.plan);
    const written = new Map<number, [number, number, number, number]>();
    const steel = new Map<number, number>();
    const plates: Up['plates'] = [];
    for (const spot of spots) {
      const voxels = plateVoxels(spot, v, this.t, spawn.bay);
      if (voxels.length === 0) continue;
      const index = plates.length;
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (const [x, y, z, p] of voxels) {
        if (!map.inBounds(x, y, z)) continue;
        const k = keyOf(map, x, y, z);
        if (!written.has(k)) written.set(k, [x, y, z, map.get(x, y, z)]);
        map.set(x, y, z, p);
        if (p !== P.TARGET_STEEL) continue;
        steel.set(k, index);
        [x, y, z].forEach((c, a) => {
          lo[a] = Math.min(lo[a], c);
          hi[a] = Math.max(hi[a], c + 1);
        });
      }
      plates.push({ at: [((lo[0] + hi[0]) / 2) * v, ((lo[1] + hi[1]) / 2) * v, ((lo[2] + hi[2]) / 2) * v], hits: 0 });
    }
    this.now = Math.max(this.now, session.ticks * session.clock.dt);
    this.on = { map, range: new Range(spots, this.t, spawn.bay), plates, steel, written };
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

  /** The dummies at `nowS` (the session's seconds) as figures: Blue's, in hunter-orange tape, the bare AK at rest, standing as tall as the player stands. None while down. */
  figures(session: Session, nowS: number): Figure[] {
    const on = this.on;
    if (!on) return [];
    const height = session.controller.t.stances[Stance.STANDING].height;
    return on.range.figures(this.clock(nowS)).map((f) => ({
      seat: f.id,
      team: 'blue',
      position: f.position,
      velocity: f.velocity,
      yaw: f.yaw,
      pitch: 0,
      height,
      deadFor: f.deadFor,
      gear: 0,
      tape: P.TAPE_RANGE,
    }));
  }

  /**
   * Before the frame's ticks, at `nowS` (the session's seconds): the dummies posed as soldiers, for
   * the app to draw after any others; the standing ones given to the session as its targets. None
   * while down.
   */
  frame(session: Session, dt: number, nowS: number): SoldierDraw[] {
    if (!this.on) return [];
    const figures = this.figures(session, nowS);
    const draws = this.gaits.pose(figures, dt);
    session.targets = draws.filter((_, i) => figures[i].deadFor === null).map((d) => ({ id: d.seat, frames: d.frames, feet: d.feet }));
    return draws;
  }

  /**
   * After the frame's ticks, at `nowS` (the session's seconds): what the player's rounds did on the
   * range, oldest first. Each hit on a dummy counts the trigger's shot it came from: the latest of
   * the player's shots at or before its tick. None while down.
   */
  after(events: CombatEvents, nowS: number): RangeEvent[] {
    const shots = events.shots;
    let next = 0;
    const shotOf = (tick: number): number => {
      while (next < shots.length && shots[next].tick <= tick) this.lastShot = shots[next++].tick;
      return this.lastShot;
    };
    const out: { tick: number; e: RangeEvent }[] = [];
    const on = this.on;
    if (on) {
      const now = this.clock(nowS);
      for (const h of events.hits) {
        if (h.owner !== 0 || h.body < FIRST_DUMMY) continue;
        const e = on.range.hit(h.body, h.zone, h.gun, h.distance, shotOf(h.tick), now);
        if (e) out.push({ tick: h.tick, e });
      }
      for (const i of events.impacts) {
        if (i.owner !== 0 || (i.material !== P.TARGET_STEEL && i.material !== P.TARGET_STEEL_HIT)) continue;
        const [x, y, z] = i.cell;
        const index = on.steel.get(keyOf(on.map, x, y, z));
        if (index === undefined) continue;
        on.map.set(x, y, z, P.TARGET_STEEL_HIT);
        on.plates[index].hits++;
        out.push({ tick: i.tick, e: on.range.plate(index, i.distance) });
      }
    }
    shotOf(Number.POSITIVE_INFINITY);
    // Stable: a tick's dummies before its plates, each as the rounds struck.
    return out.sort((a, b) => a.tick - b.tick).map((o) => o.e);
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
