import { describe, expect, it } from 'vitest';
import { projectileSpec } from '../../src/combat/ballistics';
import { pose, toWorld, type Frame, type PartName, type V3, type Zone } from '../../src/combat/soldier-rig';
import { loadTunables } from '../../src/core/tunables';
import { idleIntent, LOCAL_BODY, Session, type Body, type CombatEvents } from '../../src/sim/session';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';

// The range's targets (the shots spec's §5): bodies only the player's rounds strike. The front's
// rounds and other players' pass through them, and with targets up in solo no round stops at the
// player's own body: solo has no health to take.
const tun = loadTunables();
const AK = projectileSpec(tun, 'assault_rifle');

/**
 * 25.6 × 6.4 × 51.2 m: a floor 0.4 m deep, a clay wall at z 40–42 m past the targets and one at
 * z 0–1 m behind the player, who stands at (12.8, 0.4, 5) facing +z, settled. Solo, unless asked.
 */
function range(together = false): Session {
  const map = new BrickMap({ x: 256, y: 64, z: 512 });
  map.fillBox(0, 0, 0, 256, 4, 512, P.SOD);
  map.fillBox(0, 4, 400, 256, 64, 420, P.CLAY);
  map.fillBox(0, 4, 0, 256, 64, 10, P.CLAY);
  const s = Session.create({ map, plan: null, spawn: { position: [12.8, 0.4, 5] } }, tun, 7, 0);
  s.together = together;
  s.intent = idleIntent();
  for (let k = 0; k < 40; k++) s.tick();
  return s;
}

/** A body standing `z` m out along +z, facing back at the player: a target (200 on) or another player (their seat). */
function standing(id: number, z: number): Body {
  const feet: [number, number, number] = [12.8, 0.4, z];
  return { id, feet, frames: pose({ position: feet, yaw: 180, pitch: 0, height: 1.8, speed: 0, bob: 0, deadFor: null }) };
}

/** The middle of a posed body's chest: its torso's box's. */
const chest = (frames: Record<PartName, Frame>): V3 => toWorld(frames.torso, [0, 0.28, 0]);

/** The player's own body, posed as the session poses it for rounds to strike (and others draw it). */
function own(s: Session): Record<PartName, Frame> {
  const p = s.player;
  return pose({ position: p.position.toArray(), yaw: p.yaw, pitch: p.pitch, height: p.height, speed: 0, bob: p.bobPhase, deadFor: null });
}

/** `ticks` ticks: the hits and impacts the rounds in the air made. */
function land(s: Session, ticks = 10): Pick<CombatEvents, 'hits' | 'impacts'> {
  const hits: CombatEvents['hits'] = [];
  const impacts: CombatEvents['impacts'] = [];
  for (let k = 0; k < ticks; k++) {
    s.tick();
    const e = s.drainEvents();
    hits.push(...e.hits);
    impacts.push(...e.impacts);
  }
  return { hits, impacts };
}

/** A round of `owner`'s (the AK's), from `from` level along +z (`dz` 1) or −z (−1): what it struck. */
function level(s: Session, owner: number, from: readonly number[], dz: 1 | -1) {
  s.rounds.fire([from[0], from[1], from[2]], [0, 0, dz * AK.muzzleVelocity], AK, owner, true);
  return land(s);
}

/** One pull of the player's trigger, aimed from the eye at `at`: what it struck. */
function shoot(s: Session, at: readonly number[]) {
  const p = s.player;
  const eye = [p.position.x, p.position.y + s.controller.eyeHeight(p), p.position.z];
  const d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]];
  p.yaw = (Math.atan2(d[0], d[2]) * 180) / Math.PI;
  p.pitch = (Math.atan2(d[1], Math.hypot(d[0], d[2])) * 180) / Math.PI;
  s.intent = { ...idleIntent(), fire: true };
  const fired = land(s, 1);
  s.intent = idleIntent();
  const after = land(s);
  return { hits: [...fired.hits, ...after.hits], impacts: [...fired.impacts, ...after.impacts] };
}

describe("the range's targets", () => {
  it("the player's round strikes a target: events.hits has body 200, owner 0, its zone", () => {
    const aims: [PartName, V3, Zone][] = [
      ['torso', [0, 0.28, 0], 'torso'],
      ['head', [0, 0.155, 0], 'head'],
    ];
    for (const [part, local, zone] of aims) {
      const s = range();
      const dummy = standing(200, 25);
      s.targets = [dummy];
      const { hits, impacts } = shoot(s, toWorld(dummy.frames[part], local));
      expect(hits, part).toHaveLength(1);
      expect(hits[0]).toMatchObject({ owner: 0, body: 200, zone });
      // Struck where it stands, 20 m out, and stopped there: nothing went on to the wall past it.
      expect(Math.abs(hits[0].position[2] - 25)).toBeLessThan(0.4);
      expect(impacts).toEqual([]);
    }
  });

  it("the front's round passes through a target", () => {
    for (const together of [false, true]) {
      const s = range(together);
      const dummy = standing(200, 25);
      s.targets = [dummy];
      const at = chest(dummy.frames);
      const from = [at[0], at[1], at[2] - 10];
      // Level through its chest from 10 m short of it: on into the wall past it.
      const front = level(s, 1, from, 1);
      expect(front.hits, `together ${together}`).toEqual([]);
      expect(front.impacts.map((i) => i.cell[2])).toEqual([400]);
      // The player's round on the same line stops in it.
      const mine = level(s, 0, from, 1);
      expect(mine.hits).toMatchObject([{ owner: 0, body: 200, zone: 'torso' }]);
      expect(mine.impacts).toEqual([]);
    }
  });

  it("solo with targets up: no round stops at the player's own body", () => {
    const s = range();
    const dummy = standing(200, 25);
    s.targets = [dummy];
    const me = chest(own(s));
    const toMe = [me[0], me[1], me[2] + 7];
    // The front's round, and another player's, from 7 m out back through the player's chest: on
    // into the wall behind them.
    for (const owner of [1, 2]) {
      const { hits, impacts } = level(s, owner, toMe, -1);
      expect(hits.filter((h) => h.body === LOCAL_BODY), `owner ${owner}`).toEqual([]);
      expect(hits).toEqual([]);
      expect(impacts.map((i) => i.cell[2])).toEqual([9]);
    }
    // The targets are up all the same: the player's round strikes one.
    const at = chest(dummy.frames);
    expect(level(s, 0, [at[0], at[1], at[2] - 10], 1).hits).toMatchObject([{ owner: 0, body: 200 }]);
    // With friends, the same rounds stop in the player's chest.
    const t = range(true);
    t.targets = [standing(200, 25)];
    for (const owner of [1, 2]) expect(level(t, owner, toMe, -1).hits).toMatchObject([{ owner, body: LOCAL_BODY, zone: 'torso' }]);
  });

  it("a target is not struck by another player's round (owner 2)", () => {
    for (const together of [false, true]) {
      const s = range(together);
      const dummy = standing(200, 25);
      s.targets = [dummy];
      const at = chest(dummy.frames);
      const from: V3 = [at[0], at[1], at[2] - 10];
      // Seat 0's shot (owner 2), level through its chest from 10 m short of it: on into the wall past it.
      s.fireRemote(2, from, [0, 0, 1], true, from);
      const theirs = land(s);
      expect(theirs.hits, `together ${together}`).toEqual([]);
      expect(theirs.impacts.map((i) => i.cell[2])).toEqual([400]);
      // The player's on the same line stops in it.
      expect(level(s, 0, from, 1).hits).toMatchObject([{ owner: 0, body: 200, zone: 'torso' }]);
    }
  });

  it("solo with targets up there is still no one else to hit: the player's round goes past another's body to the target", () => {
    const dummy = standing(200, 25);
    const at = chest(dummy.frames);
    const from = [at[0], at[1], at[2] - 15];
    const s = range();
    s.targets = [dummy];
    s.bodies = [standing(3, 15)];
    expect(level(s, 0, from, 1).hits).toMatchObject([{ owner: 0, body: 200 }]);
    // With friends, it stops in theirs, short of the target.
    const t = range(true);
    t.targets = [dummy];
    t.bodies = [standing(3, 15)];
    expect(level(t, 0, from, 1).hits).toMatchObject([{ owner: 0, body: 3 }]);
  });
});
