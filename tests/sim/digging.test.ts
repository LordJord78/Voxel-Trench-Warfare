import { describe, expect, it } from 'vitest';
import { Entrenching, entrenchingTunables } from '../../src/combat/entrenching';
import { loadTunables } from '../../src/core/tunables';
import { Stance, type MoveIntent } from '../../src/physics/character';
import { boxHitsSolid } from '../../src/physics/collision';
import type { DetonationRunner } from '../../src/sim/destruction';
import { idleIntent, Session } from '../../src/sim/session';
import { BrickMap } from '../../src/world/bricks';
import { runDetonation, type DetonationResult } from '../../src/world/detonation';
import { isLoose, P } from '../../src/world/materials';
import { sameWorld, trenchArena } from '../support/worlds';

// Digging in the session (the spec's §5, "Digging"; the reference's session._tick_dig and exposure):
// F held clears loose ground in front of the feet, a scoop at a time; never lying down, through the
// periscope or off the ground; while digging the aim sways 1.6 times as much and the exposure shown
// is 1.25 times; and a dig inside a crater's region that is out waits for it. The reference's
// test_entrenching's session tests, ported.
const tun = loadTunables();
const t = entrenchingTunables(tun);
const DIG: MoveIntent = { ...idleIntent(), dig: true };

/** 12.8 × 6.4 × 12.8 m: a floor 0.4 m deep (its top a timber firing step, if asked), a heap of spoil 0.6–2 m ahead of the spawn. */
function yard(step = false): BrickMap {
  const map = new BrickMap({ x: 128, y: 64, z: 128 });
  map.fillBox(0, 0, 0, 128, 4, 128, P.CLAY);
  if (step) map.fillBox(0, 3, 0, 128, 4, 128, P.TIMBER);
  map.fillBox(56, 4, 26, 72, 12, 40, P.SPOIL);
  map.takeDirty();
  return map;
}

/** A session in `map` standing at `spawn`, facing +z, settled for `ticks` with `intent`. */
function stand(map: BrickMap, spawn: [number, number, number], intent: MoveIntent = idleIntent(), ticks = 60, runner?: DetonationRunner): Session {
  const s = Session.create({ map, plan: null, spawn: { position: spawn }, waterTable: 42, runner }, tun, 7, 0);
  s.intent = intent;
  for (let k = 0; k < ticks; k++) s.tick();
  s.drainEvents();
  return s;
}

/** A runner that keeps each crater until released, and after that is in step with the ticks (a crater asking for a wider region is posted again). */
function heldRunner(): DetonationRunner & { release(): void } {
  const waiting: DetonationResult[] = [];
  const done: DetonationResult[] = [];
  let open = false;
  return {
    post: (req) => (open ? done : waiting).push(runDetonation(req)),
    take: () => done.splice(0),
    release: () => {
      open = true;
      done.push(...waiting.splice(0));
    },
  };
}

function looseIn(map: BrickMap, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  let n = 0;
  for (let z = z0; z < z1; z++) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (isLoose(map.get(x, y, z))) n++;
  return n;
}

/** The trench's own volume in the arena: floor to ground, front wall to back. */
const trenchLoose = (map: BrickMap) => looseIn(map, 0, 44, 120, 256, 64, 136);

/**
 * The review's bay: a 3 m shell on the parapet's crest slumps it into the trench (4.8 m³ of it,
 * 8.5–17 m along). A player on the floor at `x`, facing `yaw`, digs for `seconds` as a person
 * would: F held, stepping forward when there is nothing to clear, when a scoop comes back thin, or
 * when the digging has turned to the walls beside them — in this bare arena the shell loosened the
 * bay's walls and floor into spoil as well as filling it. Whether they were ever inside solid.
 */
function digOutBay(seconds: number, x = 8.0, yaw = 90) {
  const s = Session.create({ map: trenchArena(), plan: null, spawn: { position: [x, 4.6, 13.0] }, waterTable: 42 }, tun, 7, yaw);
  for (let k = 0; k < 120; k++) s.tick();
  s.land(12.8, 15.0, 3, 11);
  for (let k = 0; k < 240; k++) s.tick();
  s.drainEvents();
  const p = s.player;
  const start = p.position;
  const before = trenchLoose(s.map);
  const ahead = [Math.sin((yaw * Math.PI) / 180), Math.cos((yaw * Math.PI) / 180)];
  const aside = (at: readonly number[]) => Math.abs((at[0] - p.position.x) * ahead[1] - (at[2] - p.position.z) * ahead[0]) > 0.5;
  const g = s.controller.grid;
  let inside = 0;
  let step = 0;
  for (let k = 0; k < seconds * 60; k++) {
    s.intent = { ...DIG, forward: step > 0 ? 1 : 0 };
    if (step > 0) step--;
    s.tick();
    if (boxHitsSolid(g, p.position, s.controller.t.radius, p.height)) inside++;
    const scoops = s.drainEvents().scoops;
    if (step === 0 && (!s.entrenching.inReach || scoops.some((c) => c.voxels < t.scoopVoxels / 2 || aside(c.at)))) step = 4;
  }
  return { s, start, before, after: trenchLoose(s.map), inside };
}

describe('digging in the session', () => {
  it('a shelled bay can be dug back out', () => {
    const { s, start, before, after } = digOutBay(40);
    const p = s.player.position;
    expect(before).toBeGreaterThan(4000);
    // At the reference's rate, less the steps; and into the slump, at least a metre.
    expect(s.entrenching.cleared).toBeGreaterThan(3400);
    expect(p.x - start.x).toBeGreaterThan(1.0);
    // The line worked along is back down to the floor (y 44): no more than a voxel of spoil left on it.
    for (let x = Math.floor(start.x * 10); x <= Math.floor(p.x * 10); x++) {
      for (let z = 128; z <= 132; z++) expect(looseIn(s.map, x, 45, z, x + 1, 64, z + 1), `${x},${z}`).toBe(0);
    }
    // And the bay's own fill is down by more than a cubic metre: the rest of the work was the walls and floor the shell broke.
    expect(before - after).toBeGreaterThan(1000);
  });

  it('the ground slumping in never leaves the player inside solid', () => {
    // Beside the slump, and under it (lifted onto it by milestone 4's lift).
    expect(digOutBay(40).inside).toBe(0);
    expect(digOutBay(40, 12.8).inside).toBe(0);
    // A sheer face of spoil 1.2 m high, 0.6 m ahead: dug at its foot, it slumps back over the feet.
    const map = new BrickMap({ x: 128, y: 64, z: 128 });
    map.fillBox(0, 0, 0, 128, 4, 128, P.CLAY);
    map.fillBox(56, 4, 26, 72, 16, 40, P.SPOIL);
    map.takeDirty();
    const s = stand(map, [6.4, 0.4, 2.0]);
    const p = s.player;
    s.intent = DIG;
    for (let k = 0; k < 600; k++) {
      s.tick();
      expect(boxHitsSolid(s.controller.grid, p.position, s.controller.t.radius, p.height), `tick ${k}`).toBe(false);
    }
    // It did come down on them: they stand on it.
    expect(s.entrenching.cleared).toBeGreaterThan(0);
    expect(p.position.y).toBeGreaterThan(0.45);
  });

  it('you cannot dig lying down, through the periscope, or in the air', () => {
    const prone = stand(yard(), [6.4, 0.4, 2.0], { ...idleIntent(), stance: Stance.PRONE }, 90);
    prone.intent = { ...DIG, stance: Stance.PRONE };
    for (let k = 0; k < 300; k++) prone.tick();
    expect(prone.player.stance).toBe(Stance.PRONE);
    expect(prone.digging).toBe(false);
    expect(prone.entrenching.cleared).toBe(0);

    const scope = stand(yard(true), [6.4, 0.4, 2.0], { ...idleIntent(), periscope: true }, 90);
    expect(scope.player.stance).toBe(Stance.PERISCOPE);
    scope.intent = { ...DIG, periscope: true };
    for (let k = 0; k < 300; k++) scope.tick();
    expect(scope.digging).toBe(false);
    expect(scope.entrenching.cleared).toBe(0);

    // Dropped from 3 m: in the air for the first ticks, then on the ground and digging.
    const air = stand(yard(), [6.4, 3.4, 2.0], DIG, 0);
    let airborne = 0;
    for (let k = 0; k < 120; k++) {
      air.tick();
      if (!air.player.onGround) {
        airborne++;
        expect(air.digging).toBe(false);
      }
    }
    expect(airborne).toBeGreaterThan(10);
    expect(air.digging).toBe(true);
  });

  it('digging costs exposure and steadiness', () => {
    const idle = stand(yard(), [6.4, 0.4, 2.0]);
    const busy = stand(yard(), [6.4, 0.4, 2.0]);
    const shown = idle.exposure();
    expect(shown).toBe(tun.f('stance.standing.exposure'));
    busy.intent = DIG;
    busy.tick();
    expect(busy.digging).toBe(true);
    expect(busy.exposure()).toBeCloseTo(shown * t.exposureScale, 12);
    // The same first shot from each: its cone, and the recoil, are 1.6 times as wide while digging.
    idle.intent = { ...idleIntent(), fire: true };
    busy.intent = { ...DIG, fire: true };
    idle.tick();
    busy.tick();
    expect(busy.recoil.scale).toBeCloseTo(idle.recoil.scale * t.swayScale, 12);
    const off = (s: Session) => {
      const { dir, aim } = s.shots[0];
      const yaw = (Math.atan2(dir[0], dir[2]) * 180) / Math.PI;
      const pitch = (Math.asin(dir[1]) * 180) / Math.PI;
      return Math.hypot(yaw - aim[0], pitch - aim[1]);
    };
    expect(off(busy) / off(idle)).toBeCloseTo(t.swayScale, 4);
  });

  it('a dig inside a region that is out waits for it, then goes on', () => {
    // A wedge of spoil at its angle of repose against the trench's back wall, in reach; a shell on the parapet 6 m along, whose region covers it.
    const arena = () => {
      const map = trenchArena();
      for (let y = 44; y < 48; y++) map.fillBox(122, y, 132 + (y - 44), 134, y + 1, 136, P.SPOIL);
      map.takeDirty();
      return map;
    };
    const runner = heldRunner();
    const s = stand(arena(), [12.8, 4.6, 12.4], idleIntent(), 120, runner);
    const feet = [s.player.position.x, s.player.position.y, s.player.position.z];
    s.land(19.0, 15.0, 3, 11);
    s.tick();
    expect(s.destruction.out.some((b) => b.x0 <= 128 && 128 < b.x1 && b.z0 <= 133 && 133 < b.z1)).toBe(true);
    s.intent = DIG;
    for (let k = 0; k < 120; k++) s.tick();
    expect(s.digging).toBe(true);
    expect(s.entrenching.inReach).toBe(true);
    expect(s.entrenching.cleared).toBe(0);
    expect(s.entrenching.fraction).toBe(1);
    runner.release();
    let landed = false;
    for (let k = 0; k < 60 && !landed; k++) {
      s.tick();
      landed = s.drainEvents().craters.length > 0;
    }
    expect(landed).toBe(true);
    for (let k = 0; k < 120; k++) s.tick();
    expect(s.entrenching.cleared).toBeGreaterThan(0);
    expect(s.player.position.toArray()).toEqual(feet);

    // The same crater cut at once, and then the same scoops from the same feet.
    const crater = stand(arena(), [12.8, 4.6, 12.4], idleIntent(), 120);
    crater.land(19.0, 15.0, 3, 11);
    for (let k = 0; k < 60 && crater.destruction.pending > 0; k++) crater.tick();
    expect(crater.destruction.pending).toBe(0);
    const replay = new Entrenching(crater.map, t, 0.1, 42);
    while (replay.cleared < s.entrenching.cleared) replay.work(feet, 0, 1 / 60);
    expect(sameWorld(s.map, crater.map)).toBe(true);
  });

  it('a scoop is an event, where it was dug', () => {
    const s = stand(yard(), [6.4, 0.4, 2.0]);
    s.intent = DIG;
    const scoops = [];
    for (let k = 0; k < 60; k++) {
      const was = s.entrenching.cleared;
      s.tick();
      const ev = s.drainEvents().scoops;
      expect(ev.length).toBe((s.entrenching.cleared - was) / t.scoopVoxels);
      scoops.push(...ev);
    }
    expect(scoops.length).toBeGreaterThanOrEqual(3);
    for (const sc of scoops) {
      expect(sc.voxels).toBe(t.scoopVoxels);
      const p = s.player.position;
      expect(Math.hypot(sc.at[0] - p.x, sc.at[1] - p.y, sc.at[2] - p.z)).toBeLessThanOrEqual(t.reachM);
    }
    expect(new Set(scoops.map((sc) => sc.tick)).size).toBe(scoops.length);
  });

  it('digging is deterministic', () => {
    const a = digOutBay(10, 12.8);
    const b = digOutBay(10, 12.8);
    expect(a.s.entrenching.cleared).toBe(b.s.entrenching.cleared);
    expect(a.s.player.position.toArray()).toEqual(b.s.player.position.toArray());
    expect(sameWorld(a.s.map, b.s.map)).toBe(true);
  });
});
